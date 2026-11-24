import { beforeEach, describe, expect, it } from 'vitest';
import { midPrice, SiftingFeedAdapter, type WebSocketLike } from '../src/adapters/siftingFeedAdapter.js';
import type { MarketTick } from '../src/types/market.js';

const KEY = 'sft_test_key_do_not_log';
const MIN = 60_000;
const HOUR = 3_600_000;

interface Call {
  url: URL;
  headers: Record<string, string>;
}

/** Scripted fetch: returns queued responses in order and records each request. */
function scriptedFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const bar = (t: number, o = 1, h = 2, l = 0.5, c = 1.5) => ({ t, o, h, l, c, v: 1 });

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  closed = false;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: { message?: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.({});
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006): void {
    this.onclose?.({ code });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function logSink() {
  const lines: string[] = [];
  const add = (level: string) => (msg: string) => lines.push(`${level} ${msg}`);
  return { lines, log: { info: add('info'), warn: add('warn'), error: add('error') } };
}

describe('midPrice', () => {
  it('uses (bid + ask) / 2 when both sides are present', () => {
    expect(midPrice({ p: 3621.55, b: 3621.19, a: 3621.91 })).toBeCloseTo(3621.55, 10);
  });

  it('falls back to last trade when a side is missing or zero', () => {
    expect(midPrice({ p: 3621.55, b: 0, a: 3621.91 })).toBe(3621.55);
    expect(midPrice({ p: 3621.55 })).toBe(3621.55);
  });

  it('accepts numeric strings as well as numbers', () => {
    expect(midPrice({ b: '10', a: '12' })).toBe(11);
  });

  it('returns null when there is no usable price', () => {
    expect(midPrice({})).toBeNull();
  });
});

describe('fetchHistoricalCandles', () => {
  const NOW = Date.UTC(2026, 10, 24, 6, 34, 0); // 2026-11-24T06:34Z

  it('requests ascending bars with the API key header and gzip, and drops the forming bar', async () => {
    const closedOpen = Date.UTC(2026, 10, 24, 6, 32);
    const formingOpen = Date.UTC(2026, 10, 24, 6, 34);
    const { fetchFn, calls } = scriptedFetch([{ body: { data: [bar(closedOpen), bar(formingOpen)] } }]);
    const adapter = new SiftingFeedAdapter({ apiKey: KEY, fetch: fetchFn, now: () => NOW, WebSocket: FakeSocket as never });

    const candles = await adapter.fetchHistoricalCandles('XAUUSD', '1m', 1);

    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ openTimeMs: closedOpen, isClosed: true, symbol: 'XAUUSD', timeframe: '1m' });
    expect(calls[0].url.pathname).toBe('/v1/hist/commodities/XAUUSD/bars');
    expect(calls[0].url.searchParams.get('order')).toBe('asc');
    expect(calls[0].url.searchParams.get('interval')).toBe('1m');
    expect(calls[0].headers['X-API-Key']).toBe(KEY);
    expect(calls[0].headers['Accept-Encoding']).toBe('gzip');
  });

  it('follows next_cursor across pages', async () => {
    const t0 = Date.UTC(2026, 10, 24, 5, 0);
    const { fetchFn, calls } = scriptedFetch([
      { body: { data: [bar(t0), bar(t0 + MIN)], meta: { next_cursor: 'PAGE2' } } },
      { body: { data: [bar(t0 + 2 * MIN)], meta: {} } },
    ]);
    const adapter = new SiftingFeedAdapter({ apiKey: KEY, fetch: fetchFn, now: () => NOW, WebSocket: FakeSocket as never });

    const candles = await adapter.fetchHistoricalCandles('XAUUSD', '1m', 3);

    expect(candles.map((c) => c.openTimeMs)).toEqual([t0, t0 + MIN, t0 + 2 * MIN]);
    expect(calls[1].url.searchParams.get('cursor')).toBe('PAGE2');
  });

  it('widens the window when weekend or break gaps leave too few closed candles', async () => {
    const t0 = Date.UTC(2026, 10, 24, 5, 0);
    const { fetchFn, calls } = scriptedFetch([
      { body: { data: [bar(t0)] } }, // too few: triggers widening
      { body: { data: [bar(t0 - 10 * MIN), bar(t0 - 9 * MIN), bar(t0)] } },
    ]);
    const adapter = new SiftingFeedAdapter({ apiKey: KEY, fetch: fetchFn, now: () => NOW, WebSocket: FakeSocket as never });

    const candles = await adapter.fetchHistoricalCandles('XAUUSD', '1m', 2);

    expect(candles).toHaveLength(2);
    const firstStart = Date.parse(calls[0].url.searchParams.get('start')!);
    const secondStart = Date.parse(calls[1].url.searchParams.get('start')!);
    expect(secondStart).toBeLessThan(firstStart);
  });

  it('aggregates 1h bars into UTC 4h candles and excludes the forming bucket', async () => {
    // Bucket 00:00–04:00 is complete except 02:00 (feed gap); bucket 04:00–08:00 is still forming.
    const b0 = Date.UTC(2026, 10, 24, 0, 0);
    const { fetchFn, calls } = scriptedFetch([
      {
        body: {
          data: [
            bar(b0, 10, 12, 9, 11), // 00:00
            bar(b0 + HOUR, 11, 15, 10, 14), // 01:00 (high 15)
            bar(b0 + 3 * HOUR, 14, 14.5, 8, 9), // 03:00 (low 8, close 9)
            bar(b0 + 4 * HOUR, 9, 9.5, 8.5, 9.2), // 04:00 → bucket still forming at NOW (06:34)
            bar(b0 + 5 * HOUR, 9.2, 9.4, 9, 9.1),
          ],
        },
      },
    ]);
    const adapter = new SiftingFeedAdapter({ apiKey: KEY, fetch: fetchFn, now: () => NOW, WebSocket: FakeSocket as never });

    const candles = await adapter.fetchHistoricalCandles('XAUUSD', '4h', 1);

    expect(calls[0].url.searchParams.get('interval')).toBe('1h');
    expect(candles).toEqual([
      {
        symbol: 'XAUUSD',
        timeframe: '4h',
        openTimeMs: b0,
        open: 10,
        high: 15,
        low: 8,
        close: 9,
        isClosed: true,
      },
    ]);
  });

  it('throws a clear error on data_unavailable and includes the earliest date', async () => {
    const { fetchFn } = scriptedFetch([{ status: 422, body: { error: 'data_unavailable', earliest: '2024-01-02' } }]);
    const adapter = new SiftingFeedAdapter({ apiKey: KEY, fetch: fetchFn, now: () => NOW, WebSocket: FakeSocket as never });

    await expect(adapter.fetchHistoricalCandles('XAUUSD', '1m', 25)).rejects.toThrow(/2024-01-02/);
  });

  it('surfaces HTTP status without echoing the key', async () => {
    const { fetchFn } = scriptedFetch([{ status: 401, body: { error: 'unauthorized' } }]);
    const adapter = new SiftingFeedAdapter({ apiKey: KEY, fetch: fetchFn, now: () => NOW, WebSocket: FakeSocket as never });

    const err = await adapter.fetchHistoricalCandles('XAUUSD', '1m', 25).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain(KEY);
  });
});

describe('live stream', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  it('authenticates via the key query parameter and subscribes to the commodities product', async () => {
    const { log } = logSink();
    const adapter = new SiftingFeedAdapter({
      apiKey: KEY,
      WebSocket: FakeSocket as never,
      log,
      fetch: scriptedFetch([{ body: {} }]).fetchFn,
    });
    await adapter.subscribe(['XAUUSD'], () => undefined);

    const sock = FakeSocket.instances[0];
    expect(sock.url).toContain('wss://stream.sifting.io/ws/v1?key=');
    sock.open();
    expect(JSON.parse(sock.sent[0])).toEqual({ op: 'subscribe', product: 'com', symbols: ['XAUUSD'] });
    await adapter.disconnect();
  });

  it('emits mid-price ticks for subscribed symbols only and ignores acks', async () => {
    const ticks: MarketTick[] = [];
    const adapter = new SiftingFeedAdapter({
      apiKey: KEY,
      WebSocket: FakeSocket as never,
      log: logSink().log,
      fetch: scriptedFetch([{ body: {} }]).fetchFn,
    });
    await adapter.subscribe(['XAUUSD'], (t) => ticks.push(t));
    const sock = FakeSocket.instances[0];
    sock.open();

    sock.receive({ f: 'ack', op: 'subscribe', product: 'com', symbols: ['XAUUSD'] });
    sock.receive({ f: 'tick', class: 'spot', s: 'XAUUSD', p: 3621.55, b: 3621.19, a: 3621.91, t: 1000 });
    sock.receive({ f: 'tick', class: 'spot', s: 'EURUSD', p: 1.08, b: 1.08, a: 1.08, t: 1001 });

    expect(ticks).toEqual([{ symbol: 'XAUUSD', price: (3621.19 + 3621.91) / 2, timestampMs: 1000 }]);
    await adapter.disconnect();
  });

  it('redacts the key from error frames it logs', async () => {
    const sink = logSink();
    const adapter = new SiftingFeedAdapter({
      apiKey: KEY,
      WebSocket: FakeSocket as never,
      log: sink.log,
      fetch: scriptedFetch([{ body: {} }]).fetchFn,
    });
    await adapter.subscribe(['XAUUSD'], () => undefined);
    const sock = FakeSocket.instances[0];
    sock.open();
    sock.receive({ f: 'error', code: 'auth_failed', message: `bad key ${KEY}` });

    expect(sink.lines.join('\n')).toContain('auth_failed');
    expect(sink.lines.join('\n')).not.toContain(KEY);
    await adapter.disconnect();
  });

  it('reconnects after an unexpected drop, re-subscribes, and runs the re-sync hook', async () => {
    const sink = logSink();
    const adapter = new SiftingFeedAdapter({
      apiKey: KEY,
      WebSocket: FakeSocket as never,
      log: sink.log,
      reconnectBaseMs: 1,
      reconnectMaxMs: 2,
      fetch: scriptedFetch([{ body: {} }]).fetchFn,
    });
    let resyncs = 0;
    adapter.onReconnect(async () => {
      resyncs++;
    });

    await adapter.subscribe(['XAUUSD'], () => undefined);
    FakeSocket.instances[0].open();
    expect(resyncs).toBe(0); // first connect is not a reconnect

    FakeSocket.instances[0].drop();
    await sleep(30);
    expect(FakeSocket.instances.length).toBe(2);

    FakeSocket.instances[1].open();
    await sleep(5);
    expect(resyncs).toBe(1);
    expect(JSON.parse(FakeSocket.instances[1].sent[0])).toEqual({
      op: 'subscribe',
      product: 'com',
      symbols: ['XAUUSD'],
    });
    await adapter.disconnect();
  });

  it('subscribes and unsubscribes incrementally when the symbol set changes', async () => {
    const adapter = new SiftingFeedAdapter({
      apiKey: KEY,
      WebSocket: FakeSocket as never,
      log: logSink().log,
      fetch: scriptedFetch([{ body: {} }]).fetchFn,
    });
    await adapter.subscribe(['XAUUSD'], () => undefined);
    const sock = FakeSocket.instances[0];
    sock.open();
    await adapter.updateSubscriptions(['XAUUSD', 'NATGAS']);
    await adapter.updateSubscriptions(['NATGAS']);

    const ops = sock.sent.map((s) => JSON.parse(s));
    expect(ops[1]).toEqual({ op: 'subscribe', product: 'com', symbols: ['NATGAS'] });
    expect(ops[2]).toEqual({ op: 'unsubscribe', product: 'com', symbols: ['XAUUSD'] });
    await adapter.disconnect();
  });

  it('does not reconnect after disconnect()', async () => {
    const adapter = new SiftingFeedAdapter({
      apiKey: KEY,
      WebSocket: FakeSocket as never,
      log: logSink().log,
      reconnectBaseMs: 1,
      reconnectMaxMs: 2,
      fetch: scriptedFetch([{ body: {} }]).fetchFn,
    });
    await adapter.subscribe(['XAUUSD'], () => undefined);
    FakeSocket.instances[0].open();
    await adapter.disconnect();
    await sleep(20);
    expect(FakeSocket.instances.length).toBe(1);
    expect(FakeSocket.instances[0].closed).toBe(true);
  });
});
