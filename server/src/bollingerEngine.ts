/**
 * Pure Bollinger Band maths and the 3-state reversion FSM (handoff §3).
 * Zero I/O: everything here is a function of its arguments.
 */

export type FsmState = 'NEUTRAL' | 'ARMED_LOWER' | 'ARMED_UPPER';
export type Direction = 'BULL_REVERSION' | 'BEAR_REVERSION';

export interface Bands {
  upper: number; // U = M + k·σ
  middle: number; // M
  lower: number; // L = M − k·σ
  stdDev: number; // σ (population)
}

export interface Triggers {
  tBull: number; // L + r·(M − L)
  tBear: number; // U − r·(U − M)
}

export interface FsmInput {
  state: FsmState;
  lastArmedPrice: number | null;
  price: number; // P
  bands: Bands;
  reversionPct: number; // r ∈ [0.10, 1.00]
}

export interface FsmResult {
  nextState: FsmState;
  lastArmedPrice: number | null;
  /** Empty when no alert fires. At most one entry per tick. */
  fired: Direction[];
  /** True when Guardrail A (flat market) suppressed evaluation. */
  halted: boolean;
}

export const FLAT_MARKET_EPSILON = 1e-8;
export const MIN_REVERSION_PCT = 0.1;
export const MAX_REVERSION_PCT = 1.0;
export const DEFAULT_REVERSION_PCT = 0.85;

/**
 * Bollinger bands over `closes` (a window that already includes the live price as its last element).
 * Uses the population standard deviation, σ = sqrt(Σ(c − M)² / N).
 */
export function computeBands(closes: readonly number[], k: number): Bands {
  const n = closes.length;
  if (n < 2) {
    throw new RangeError(`computeBands needs at least 2 closes, got ${n}`);
  }
  let sum = 0;
  for (const c of closes) sum += c;
  const middle = sum / n;

  let sq = 0;
  for (const c of closes) {
    const d = c - middle;
    sq += d * d;
  }
  const stdDev = Math.sqrt(sq / n);

  return {
    upper: middle + k * stdDev,
    middle,
    lower: middle - k * stdDev,
    stdDev,
  };
}

/**
 * Bands for every index of a close series: element i uses closes[i − period + 1 … i] (population σ).
 * Indices before a full window are null. Used by the chart endpoint, so the same maths is shown on screen.
 */
export function rollingBands(closes: readonly number[], period: number, k: number): (Bands | null)[] {
  return closes.map((_, i) => (i + 1 < period ? null : computeBands(closes.slice(i + 1 - period, i + 1), k)));
}

export function computeTriggers(bands: Bands, reversionPct: number): Triggers {
  return {
    tBull: bands.lower + reversionPct * (bands.middle - bands.lower),
    tBear: bands.upper - reversionPct * (bands.upper - bands.middle),
  };
}

export function isFlatMarket(bands: Bands): boolean {
  return bands.stdDev <= FLAT_MARKET_EPSILON;
}

/**
 * Single-tick FSM transition (handoff §3.3, Guardrails A–C).
 *
 * Guardrail C needs no special case: `reversionPct` is read fresh on every tick, so a lowered
 * threshold fires on the next tick and a raised one keeps the rule armed.
 */
export function evaluateTick(input: FsmInput): FsmResult {
  const { state, price: P, bands, reversionPct } = input;

  // Guardrail A: flat market, halt without arming or firing.
  if (isFlatMarket(bands)) {
    return { nextState: state, lastArmedPrice: input.lastArmedPrice, fired: [], halted: true };
  }

  const { upper: U, lower: L } = bands;
  const { tBull, tBear } = computeTriggers(bands, reversionPct);

  const stay = (): FsmResult => ({
    nextState: state,
    lastArmedPrice: input.lastArmedPrice,
    fired: [],
    halted: false,
  });

  switch (state) {
    case 'NEUTRAL':
      if (P <= L) return { nextState: 'ARMED_LOWER', lastArmedPrice: P, fired: [], halted: false };
      if (P >= U) return { nextState: 'ARMED_UPPER', lastArmedPrice: P, fired: [], halted: false };
      return stay();

    case 'ARMED_LOWER':
      // Extreme spike through the upper band: fire bullish AND arm the upper watch.
      if (P >= U) {
        return { nextState: 'ARMED_UPPER', lastArmedPrice: P, fired: ['BULL_REVERSION'], halted: false };
      }
      if (P >= tBull) {
        return { nextState: 'NEUTRAL', lastArmedPrice: null, fired: ['BULL_REVERSION'], halted: false };
      }
      // Still below the trigger (including a further drop to or below L): remain armed.
      return stay();

    case 'ARMED_UPPER':
      // Extreme drop through the lower band: fire bearish AND arm the lower watch.
      if (P <= L) {
        return { nextState: 'ARMED_LOWER', lastArmedPrice: P, fired: ['BEAR_REVERSION'], halted: false };
      }
      if (P <= tBear) {
        return { nextState: 'NEUTRAL', lastArmedPrice: null, fired: ['BEAR_REVERSION'], halted: false };
      }
      return stay();
  }
}

/** Fraction of the band-touch → median move completed by `price` (0 = at the band, 1 = at the median). */
export function retracementFraction(
  direction: Direction,
  price: number,
  levels: Pick<Bands, 'upper' | 'middle' | 'lower'>,
): number | null {
  if (direction === 'BULL_REVERSION') {
    const span = levels.middle - levels.lower;
    return span > 0 ? (price - levels.lower) / span : null;
  }
  const span = levels.upper - levels.middle;
  return span > 0 ? (levels.upper - price) / span : null;
}

export function isValidReversionPct(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_REVERSION_PCT && value <= MAX_REVERSION_PCT;
}
