import { rollingBands, type Direction, type FsmState } from './bollingerEngine.js';
import { bucketOpenMs } from './candleManager.js';
import type { Repo } from './db.js';
import type { FeedStatus, LiveTail, MonitorView } from './monitorService.js';
import type { Candle, IMarketFeedAdapter, Timeframe } from './types/market.js';

/** Same parameters as the monitors, so the chart shows exactly what the engine evaluates. */
export const CHART_BB_PERIOD = 20;
export const CHART_BB_K = 2;
const HISTORY_TTL_MS = 15_000;

export interface ChartCandle {
  time: number; // UTC seconds (lightweight-charts convention)
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartBand {
  time: number;
  upper: number;
  middle: number;
  lower: number;
}

export interface ChartAlert {
  id: string;
  time: number;
  direction: Direction;
  price: number;
}

export interface ChartResponse {
  symbol: string;
  timeframe: Timeframe;
  asOf: number;
  /** True when vendor history could not be refreshed and a cached copy was served. */
  historyStale: boolean;
  candles: ChartCandle[];
  bands: ChartBand[];
  triggers: {
    monitorId: string;
    reversionPct: number;
    fsmState: FsmState;
    tBull: number | null;
    tBear: number | null;
  } | null;
  alerts: ChartAlert[];
  live: { price: number | null; feedStatus: FeedStatus };
}

export interface ChartDeps {
  adapter: IMarketFeedAdapter;
  repo: Repo;
  live: (symbol: string, timeframe: Timeframe) => LiveTail;
  now?: () => number;
}

interface CacheEntry {
  candles: Candle[];
  requested: number;
  fetchedAt: number;
}

/**
 * Builds the chart payload: vendor history merged with the live tail (for monitored pairs), Bollinger
 * bands over the merged series, the monitor's trigger levels, and alert markers.
 */
export class ChartService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<Candle[]>>();
  private readonly now: () => number;

  constructor(private readonly deps: ChartDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async getChart(symbol: string, timeframe: Timeframe, limit: number): Promise<ChartResponse> {
    const live = this.deps.live(symbol, timeframe);

    // Fetch extra history so the first displayed candle already has a full 20-close window.
    const { candles: history, stale } = await this.history(symbol, timeframe, limit + CHART_BB_PERIOD);
    const merged = mergeSeries(history, live);

    const bands = rollingBands(
      merged.map((c) => c.close),
      CHART_BB_PERIOD,
      CHART_BB_K,
    );

    const start = Math.max(0, merged.length - limit);
    const shown = merged.slice(start);
    const firstShownMs = shown[0]?.openTimeMs ?? Number.POSITIVE_INFINITY;

    const bandSeries: ChartBand[] = [];
    for (let i = start; i < merged.length; i++) {
      const b = bands[i];
      if (b) bandSeries.push({ time: toSec(merged[i].openTimeMs), upper: b.upper, middle: b.middle, lower: b.lower });
    }

    return {
      symbol,
      timeframe,
      asOf: this.now(),
      historyStale: stale,
      candles: shown.map((c) => ({
        time: toSec(c.openTimeMs),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
      bands: bandSeries,
      triggers: live.monitor ? triggersOf(live.monitor) : null,
      alerts: this.alertsFor(symbol, timeframe, firstShownMs),
      live: { price: live.price, feedStatus: live.feedStatus },
    };
  }

  /** Cached vendor history. Concurrent requests share one fetch. Falls back to stale data if the vendor fails. */
  private async history(symbol: string, timeframe: Timeframe, count: number): Promise<{ candles: Candle[]; stale: boolean }> {
    const key = `${symbol}|${timeframe}`;
    const cached = this.cache.get(key);
    if (cached && cached.requested >= count && this.now() - cached.fetchedAt < HISTORY_TTL_MS) {
      return { candles: cached.candles, stale: false };
    }

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.deps.adapter
        .fetchHistoricalCandles(symbol, timeframe, count)
        .then((candles) => {
          this.cache.set(key, { candles, requested: count, fetchedAt: this.now() });
          return candles;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }

    try {
      return { candles: await pending, stale: false };
    } catch (err) {
      if (cached) return { candles: cached.candles, stale: true };
      throw err;
    }
  }

  private alertsFor(symbol: string, timeframe: Timeframe, fromMs: number): ChartAlert[] {
    return this.deps.repo
      .listAlertsFor(symbol, timeframe, 200)
      .map((a) => ({
        id: a.id,
        time: toSec(bucketOpenMs(parseSqliteUtc(a.createdAt), timeframe)),
        direction: a.direction,
        price: a.triggerPrice,
      }))
      .filter((a) => a.time * 1000 >= fromMs)
      .sort((x, y) => x.time - y.time);
  }
}

/**
 * Joins vendor history with the live tail. For monitored pairs, tick-built candles replace vendor candles
 * from the tail's first open time onward, so the chart matches what the engine saw.
 */
export function mergeSeries(history: readonly Candle[], tail: Pick<LiveTail, 'closed' | 'active'>): Candle[] {
  const tailCandles = [...tail.closed, ...(tail.active ? [tail.active] : [])];
  if (tailCandles.length === 0) return [...history].sort((a, b) => a.openTimeMs - b.openTimeMs);

  const tailStart = tailCandles[0].openTimeMs;
  const base = history.filter((c) => c.openTimeMs < tailStart).sort((a, b) => a.openTimeMs - b.openTimeMs);
  return [...base, ...tailCandles];
}

function triggersOf(m: MonitorView): NonNullable<ChartResponse['triggers']> {
  return { monitorId: m.id, reversionPct: m.reversionPct, fsmState: m.fsmState, tBull: m.tBull, tBear: m.tBear };
}

function toSec(ms: number): number {
  return Math.floor(ms / 1000);
}

/** SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. */
function parseSqliteUtc(s: string): number {
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

