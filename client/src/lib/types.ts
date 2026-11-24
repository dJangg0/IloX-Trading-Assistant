export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h';
export const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '4h'];

export type FsmState = 'NEUTRAL' | 'ARMED_LOWER' | 'ARMED_UPPER';
export type Direction = 'BULL_REVERSION' | 'BEAR_REVERSION';
export type FeedStatus = 'LIVE' | 'STALE';

export interface MonitorView {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  isActive: boolean;
  reversionPct: number;
  fsmState: FsmState;
  lastArmedPrice: number | null;
  lastTriggeredAt: string | null;
  ready: boolean;
  price: number | null;
  upper: number | null;
  middle: number | null;
  lower: number | null;
  tBull: number | null;
  tBear: number | null;
  feedStatus: FeedStatus;
}

export interface AlertView {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  reversionPct: number;
  triggerPrice: number;
  upper: number;
  middle: number;
  lower: number;
  retracedPct: number | null;
  createdAt: string;
}

export interface DispatchResult {
  sent: number;
  failed: number;
  pruned: number;
}

export interface Health {
  status: 'ok';
  activeSubscriptions: number;
  uptimeSec: number;
}

export interface ChartCandle {
  time: number; // UTC seconds
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
