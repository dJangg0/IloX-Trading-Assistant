export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h';

export const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '4h'];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
};

export interface Candle {
  symbol: string;
  timeframe: Timeframe;
  openTimeMs: number; // UTC candle open timestamp in milliseconds
  open: number;
  high: number;
  low: number;
  close: number;
  isClosed: boolean;
}

export interface MarketTick {
  symbol: string;
  price: number; // Mid-price for FX/Commodities: (bid + ask) / 2, or last trade
  timestampMs: number; // UTC epoch milliseconds
}

export interface IMarketFeedAdapter {
  /** Fetches at least `limit` (minimum 25) most recent closed candles for warm-up */
  fetchHistoricalCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;

  /** Subscribes to real-time price updates for active symbols */
  subscribe(symbols: string[], onTick: (tick: MarketTick) => void): Promise<void>;

  /** Updates active symbol subscriptions dynamically when rules are added/removed */
  updateSubscriptions(symbols: string[]): Promise<void>;

  /** Cleanly closes sockets on server shutdown */
  disconnect(): Promise<void>;

  /**
   * Optional extension (not part of the original contract). Adapters that hold a socket
   * should invoke the handler after every reconnect so the engine can re-sync candle
   * history before resuming tick evaluation (handoff §4.1).
   */
  onReconnect?(handler: () => Promise<void>): void;
}
