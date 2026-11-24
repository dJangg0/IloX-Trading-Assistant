import { bucketOpenMs } from '../candleManager.js';
import { TIMEFRAME_MS, type Candle, type IMarketFeedAdapter, type MarketTick, type Timeframe } from '../types/market.js';

export interface SimulatedFeedOptions {
  /** Emit interval per symbol. */
  tickMs: number;
  /** Per-tick relative volatility (e.g. 0.0005 ≈ 5 bps per tick). */
  volatility: number;
  /** Starting prices for known symbols; unknown symbols start at 100. */
  basePrices?: Record<string, number>;
  random?: () => number;
  now?: () => number;
}

const DEFAULT_BASE_PRICES: Record<string, number> = {
  XAUUSD: 2350,
  EURUSD: 1.085,
  GBPUSD: 1.27,
  BTCUSD: 67000,
  NAS100: 19500,
};

/**
 * Random-walk feed for development and QA. Ticks are generated on a timer and history is
 * synthesised backwards from the current price, so the full pipeline runs without a provider.
 * Not a market-data source: use it to exercise the engine, FSM and push path.
 */
export class SimulatedFeedAdapter implements IMarketFeedAdapter {
  private readonly prices = new Map<string, number>();
  private readonly subscribed = new Set<string>();
  private readonly random: () => number;
  private readonly now: () => number;
  private onTick: ((tick: MarketTick) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: SimulatedFeedOptions) {
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? (() => Date.now());
  }

  async fetchHistoricalCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const dt = TIMEFRAME_MS[timeframe];
    const currentBucket = bucketOpenMs(this.now(), timeframe);
    const candles: Candle[] = [];

    // Walk backwards from the live price so history ends where the feed currently is.
    let close = this.price(symbol);
    for (let i = 0; i < limit; i++) {
      const openTimeMs = currentBucket - (i + 1) * dt;
      const open = close * (1 + this.gaussian() * this.opts.volatility * 3);
      const high = Math.max(open, close) * (1 + Math.abs(this.gaussian()) * this.opts.volatility);
      const low = Math.min(open, close) * (1 - Math.abs(this.gaussian()) * this.opts.volatility);
      candles.push({ symbol, timeframe, openTimeMs, open, high, low, close, isClosed: true });
      close = open;
    }
    return candles.reverse();
  }

  async subscribe(symbols: string[], onTick: (tick: MarketTick) => void): Promise<void> {
    this.onTick = onTick;
    this.setSymbols(symbols);
    if (!this.timer) {
      this.timer = setInterval(() => this.emitTicks(), this.opts.tickMs);
    }
  }

  async updateSubscriptions(symbols: string[]): Promise<void> {
    this.setSymbols(symbols);
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onTick = null;
    this.subscribed.clear();
  }

  private setSymbols(symbols: string[]): void {
    this.subscribed.clear();
    for (const s of symbols) this.subscribed.add(s);
  }

  private emitTicks(): void {
    if (!this.onTick) return;
    const timestampMs = this.now();
    for (const symbol of this.subscribed) {
      const next = this.price(symbol) * (1 + this.gaussian() * this.opts.volatility);
      this.prices.set(symbol, next);
      this.onTick({ symbol, price: round(next), timestampMs });
    }
  }

  private price(symbol: string): number {
    let p = this.prices.get(symbol);
    if (p === undefined) {
      p = this.opts.basePrices?.[symbol] ?? DEFAULT_BASE_PRICES[symbol] ?? 100;
      this.prices.set(symbol, p);
    }
    return p;
  }

  /** Box–Muller standard normal. */
  private gaussian(): number {
    const u = Math.max(this.random(), Number.EPSILON);
    const v = this.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
