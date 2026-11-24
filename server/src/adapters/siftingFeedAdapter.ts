import { TIMEFRAME_MS, type Candle, type IMarketFeedAdapter, type MarketTick, type Timeframe } from '../types/market.js';

/**
 * Sifting (api.sifting.io / stream.sifting.io) adapter for commodities such as XAUUSD.
 *
 * - History: GET /v1/hist/commodities/:symbol/bars. Commodities have no 4h interval, so 4h candles
 *   are built by aggregating 1h bars on UTC 4h boundaries.
 * - Live: wss://stream.sifting.io/ws/v1 with product `com`. Mid-price (bid + ask) / 2 is used,
 *   falling back to last trade.
 *
 * The API key is sent as X-API-Key on REST calls and as the `key` query parameter on the socket
 * (the only WebSocket auth method in the AsyncAPI spec). URLs are never logged.
 */

export const SIFTING_REST_BASE = 'https://api.sifting.io';
export const SIFTING_WS_URL = 'wss://stream.sifting.io/ws/v1';
const PRODUCT = 'com';
const PING_INTERVAL_MS = 30_000; // server closes after 90 s without client frames
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MIN_LOOKBACK_MS = 2 * 3_600_000;
const MAX_WIDEN_ATTEMPTS = 4;
const MAX_PAGES = 10;

/** Sifting interval used to serve each engine timeframe, and how many source bars make one candle. */
const SOURCE: Record<Timeframe, { interval: '1m' | '5m' | '15m' | '1h'; factor: number }> = {
  '1m': { interval: '1m', factor: 1 },
  '5m': { interval: '5m', factor: 1 },
  '15m': { interval: '15m', factor: 1 },
  '1h': { interval: '1h', factor: 1 },
  '4h': { interval: '1h', factor: 4 },
};

export interface WebSocketLike {
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface SiftingOptions {
  apiKey: string;
  restBase?: string;
  wsUrl?: string;
  fetch?: typeof fetch;
  WebSocket?: WebSocketCtor;
  now?: () => number;
  log?: Logger;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

interface RawBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export class SiftingFeedAdapter implements IMarketFeedAdapter {
  private readonly apiKey: string;
  private readonly restBase: string;
  private readonly wsUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly WS: WebSocketCtor;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  private onTick: ((tick: MarketTick) => void) | null = null;
  private reconnectHandler: (() => Promise<void>) | null = null;
  private desired = new Set<string>();
  private socket: WebSocketLike | null = null;
  private socketOpen = false;
  private everConnected = false;
  private closedByUs = false;
  private attempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SiftingOptions) {
    if (!opts.apiKey) throw new Error('SiftingFeedAdapter requires an API key');
    this.apiKey = opts.apiKey;
    this.restBase = opts.restBase ?? SIFTING_REST_BASE;
    this.wsUrl = opts.wsUrl ?? SIFTING_WS_URL;
    this.fetchImpl = opts.fetch ?? fetch;
    const ctor = opts.WebSocket ?? (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!ctor) throw new Error('No WebSocket implementation available (Node 22+ provides one globally)');
    this.WS = ctor;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? console;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? RECONNECT_BASE_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? RECONNECT_MAX_MS;
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  async fetchHistoricalCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const { interval, factor } = SOURCE[timeframe];
    const sourceMs = TIMEFRAME_MS[interval];
    const outMs = TIMEFRAME_MS[timeframe];
    // Extra output candle covers the partially formed group at the newest edge.
    const neededSource = (limit + 1) * factor;

    // Ascending pages over a tight window. `order=desc` is avoided: with a wide `start` it anchors
    // on stale bars (observed: 15m returned 23:45 while 06:30 existed). Widen the window if weekend
    // or daily-break gaps leave too few closed candles.
    let lookbackMs = Math.max(MIN_LOOKBACK_MS, neededSource * sourceMs * 2);
    let candles: Candle[] = [];
    for (let attempt = 0; attempt < MAX_WIDEN_ATTEMPTS; attempt++) {
      const bars = await this.fetchBarsAsc(symbol, interval, this.now() - lookbackMs);
      const nowMs = this.now();
      const closed = bars.filter((b) => b.t + sourceMs <= nowMs); // drop the bar still forming
      candles = factor === 1 ? closed.map((b) => toCandle(symbol, timeframe, b)) : aggregate(symbol, timeframe, closed, outMs, nowMs);
      if (candles.length >= limit) break;
      lookbackMs *= 3;
    }
    return candles.slice(-limit);
  }

  private async fetchBarsAsc(symbol: string, interval: string, startMs: number): Promise<RawBar[]> {
    const out: RawBar[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`/v1/hist/commodities/${encodeURIComponent(symbol)}/bars`, this.restBase);
      url.searchParams.set('start', new Date(startMs).toISOString());
      url.searchParams.set('interval', interval);
      url.searchParams.set('order', 'asc');
      url.searchParams.set('limit', '2000');
      if (cursor) url.searchParams.set('cursor', cursor);

      const res = await this.fetchImpl(url, {
        headers: { 'X-API-Key': this.apiKey, 'Accept-Encoding': 'gzip' },
      });
      const body = (await res.json().catch(() => ({}))) as {
        data?: RawBar[];
        meta?: { next_cursor?: string };
        error?: string;
        earliest?: string;
      };

      if (!res.ok) {
        if (res.status === 422 && body.earliest) {
          throw new Error(`Sifting has no ${symbol} ${interval} history before ${body.earliest}`);
        }
        throw new Error(`Sifting bars request failed: HTTP ${res.status}${body.error ? ` (${body.error})` : ''}`);
      }

      out.push(...(body.data ?? []).filter((b) => Number.isFinite(b.t)));
      cursor = body.meta?.next_cursor;
      if (!cursor) break;
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // ---------------------------------------------------------------------------
  // Live stream
  // ---------------------------------------------------------------------------

  async subscribe(symbols: string[], onTick: (tick: MarketTick) => void): Promise<void> {
    this.onTick = onTick;
    this.desired = new Set(symbols);
    this.connect();
  }

  async updateSubscriptions(symbols: string[]): Promise<void> {
    const next = new Set(symbols);
    if (this.socketOpen && this.socket) {
      const added = [...next].filter((s) => !this.desired.has(s));
      const removed = [...this.desired].filter((s) => !next.has(s));
      if (added.length) this.send({ op: 'subscribe', product: PRODUCT, symbols: added });
      if (removed.length) this.send({ op: 'unsubscribe', product: PRODUCT, symbols: removed });
    }
    this.desired = next;
  }

  async disconnect(): Promise<void> {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopPing();
    const s = this.socket;
    this.socket = null;
    this.socketOpen = false;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      s.close();
    }
  }

  /** Engine hook: called after every reconnect so history is re-fetched before ticks resume. */
  onReconnect(handler: () => Promise<void>): void {
    this.reconnectHandler = handler;
  }

  private connect(): void {
    if (this.closedByUs) return;
    // Key goes in the query string because it is the documented WebSocket auth method. We never log the URL.
    const url = `${this.wsUrl}?key=${encodeURIComponent(this.apiKey)}`;
    const ws = new this.WS(url);
    this.socket = ws;

    ws.onopen = () => {
      this.socketOpen = true;
      this.attempts = 0;
      this.startPing();
      if (this.desired.size > 0) {
        this.send({ op: 'subscribe', product: PRODUCT, symbols: [...this.desired] });
      }
      this.log.info(`[sifting] stream connected (${this.desired.size} symbol(s))`);
      const wasConnected = this.everConnected;
      this.everConnected = true;
      if (wasConnected) {
        // Missed ticks during the drop must not corrupt the window: re-fetch history first (handoff §4.1).
        void this.reconnectHandler?.().catch((err: unknown) => this.log.error(`[sifting] re-sync failed: ${describe(err)}`));
      }
    };

    ws.onmessage = (ev) => this.handleFrame(ev.data);

    ws.onerror = (ev) => {
      this.log.warn(`[sifting] stream error: ${redact(ev.message ?? 'unknown')}`);
    };

    ws.onclose = (ev) => {
      this.socketOpen = false;
      this.stopPing();
      this.socket = null;
      if (this.closedByUs) return;
      this.log.warn(`[sifting] stream closed (code ${ev.code ?? 'n/a'}); reconnecting`);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const exp = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.attempts);
    const delay = exp / 2 + Math.random() * (exp / 2); // jitter keeps reconnects from synchronising
    this.attempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private handleFrame(raw: unknown): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (frame.f) {
      case 'tick': {
        const symbol = String(frame.s ?? '');
        if (!this.desired.has(symbol) || !this.onTick) return;
        const price = midPrice(frame);
        const timestampMs = Number(frame.t);
        if (price === null || !Number.isFinite(timestampMs)) return;
        this.onTick({ symbol, price, timestampMs });
        return;
      }
      case 'error':
        this.log.error(`[sifting] ${String(frame.code ?? 'error')}: ${redact(String(frame.message ?? ''))}`);
        return;
      default:
        return; // ack, pong
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.socket && this.socketOpen) this.socket.send(JSON.stringify(payload));
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ op: 'ping' }), PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

function toCandle(symbol: string, timeframe: Timeframe, b: RawBar): Candle {
  return { symbol, timeframe, openTimeMs: b.t, open: b.o, high: b.h, low: b.l, close: b.c, isClosed: true };
}

/**
 * Rolls ascending 1h bars into UTC-aligned buckets of the target timeframe. A bucket is emitted only
 * once its end has passed. Hours missing from the feed (daily break, weekend) are simply absent,
 * matching how charting platforms aggregate.
 */
function aggregate(symbol: string, timeframe: Timeframe, bars: RawBar[], outMs: number, nowMs: number): Candle[] {
  const groups = new Map<number, RawBar[]>();
  for (const b of bars) {
    const bucket = Math.floor(b.t / outMs) * outMs;
    const g = groups.get(bucket);
    if (g) g.push(b);
    else groups.set(bucket, [b]);
  }

  const out: Candle[] = [];
  for (const [bucket, g] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (bucket + outMs > nowMs) continue; // still forming
    out.push({
      symbol,
      timeframe,
      openTimeMs: bucket,
      open: g[0].o,
      high: Math.max(...g.map((b) => b.h)),
      low: Math.min(...g.map((b) => b.l)),
      close: g[g.length - 1].c,
      isClosed: true,
    });
  }
  return out;
}

/** (bid + ask) / 2 when both sides are present, otherwise last trade. The stream sends numbers, but accept strings too. */
export function midPrice(frame: Record<string, unknown>): number | null {
  const bid = Number(frame.b);
  const ask = Number(frame.a);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) return (bid + ask) / 2;
  const last = Number(frame.p);
  return Number.isFinite(last) && last > 0 ? last : null;
}

function redact(text: string): string {
  return text.replace(/sft_[A-Za-z0-9_-]+/g, 'sft_***');
}

function describe(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}
