import { TIMEFRAME_MS, type Candle, type MarketTick, type Timeframe } from './types/market.js';

/** Start (UTC epoch ms) of the candle bucket containing `timestampMs` (handoff §4.1). */
export function bucketOpenMs(timestampMs: number, timeframe: Timeframe): number {
  const dt = TIMEFRAME_MS[timeframe];
  return Math.floor(timestampMs / dt) * dt;
}

export interface IngestResult {
  rolledOver: boolean;
  /** Tick belonged to an earlier bucket than the active candle and was dropped. */
  ignored: boolean;
}

/**
 * Rolling buffer of `capacity` closed candles plus one live forming candle.
 * Pure: no timers, no I/O. The caller feeds ticks and history.
 */
export class CandleManager {
  private closed: Candle[] = [];
  private active: Candle | null = null;

  constructor(
    readonly symbol: string,
    readonly timeframe: Timeframe,
    readonly capacity: number,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
  }

  ingest(tick: MarketTick): IngestResult {
    const bucket = bucketOpenMs(tick.timestampMs, this.timeframe);

    if (this.active === null) {
      this.active = this.newCandle(bucket, tick.price);
      return { rolledOver: false, ignored: false };
    }

    if (bucket < this.active.openTimeMs) {
      return { rolledOver: false, ignored: true };
    }

    if (bucket > this.active.openTimeMs) {
      // Finalise the previous bucket into the closed ring (evicting the oldest), then start fresh.
      this.pushClosed({ ...this.active, isClosed: true });
      this.active = this.newCandle(bucket, tick.price);
      return { rolledOver: true, ignored: false };
    }

    const a = this.active;
    a.high = Math.max(a.high, tick.price);
    a.low = Math.min(a.low, tick.price);
    a.close = tick.price;
    return { rolledOver: false, ignored: false };
  }

  /**
   * Replaces closed history with fetched candles (warm-up or reconnect re-sync).
   * Only fully closed candles strictly older than the active bucket are kept.
   */
  setHistory(candles: readonly Candle[]): void {
    const cutoff = this.active?.openTimeMs ?? Number.POSITIVE_INFINITY;
    const usable = candles
      .filter((c) => c.isClosed && c.openTimeMs < cutoff && c.symbol === this.symbol && c.timeframe === this.timeframe)
      .sort((a, b) => a.openTimeMs - b.openTimeMs);

    // Drop duplicates that share an open time, keeping the last occurrence.
    const byOpen = new Map<number, Candle>();
    for (const c of usable) byOpen.set(c.openTimeMs, c);

    this.closed = [...byOpen.values()].slice(-this.capacity);
  }

  /** Closes of the closed-candle ring, oldest first. */
  closedCloses(): number[] {
    return this.closed.map((c) => c.close);
  }

  closedCount(): number {
    return this.closed.length;
  }

  /** Closed candles, oldest first (copies). */
  closedCandles(): Candle[] {
    return this.closed.map((c) => ({ ...c }));
  }

  /** Live forming candle, or null before the first tick. */
  activeCandle(): Candle | null {
    return this.active ? { ...this.active } : null;
  }

  lastPrice(): number | null {
    return this.active?.close ?? null;
  }

  private pushClosed(candle: Candle): void {
    this.closed.push(candle);
    if (this.closed.length > this.capacity) {
      this.closed.splice(0, this.closed.length - this.capacity);
    }
  }

  private newCandle(openTimeMs: number, price: number): Candle {
    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      openTimeMs,
      open: price,
      high: price,
      low: price,
      close: price,
      isClosed: false,
    };
  }
}
