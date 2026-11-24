import { describe, expect, it } from 'vitest';
import {
  computeBands,
  computeTriggers,
  evaluateTick,
  retracementFraction,
  type Bands,
  type Direction,
  type FsmState,
} from '../src/bollingerEngine.js';

/** 19 closed candles oscillating around 100 (σ ≈ 1), giving non-trivial bands. */
const CLOSED_19 = Array.from({ length: 19 }, (_, i) => (i % 2 === 0 ? 101 : 99));

interface Step {
  price: number;
  state: FsmState;
  fired: Direction[];
  bands: Bands;
}

/**
 * Drives the FSM over a price path with a fixed set of closed candles. The live price is the
 * 20th element of each window, matching the engine's C_t = P convention.
 */
function run(prices: number[], opts: { r: number; initial?: FsmState; closes?: number[] } = { r: 0.85 }): Step[] {
  const closes = opts.closes ?? CLOSED_19;
  let state: FsmState = opts.initial ?? 'NEUTRAL';
  let lastArmedPrice: number | null = null;
  const trace: Step[] = [];
  for (const price of prices) {
    const bands = computeBands([...closes, price], 2);
    const res = evaluateTick({ state, lastArmedPrice, price, bands, reversionPct: opts.r });
    state = res.nextState;
    lastArmedPrice = res.lastArmedPrice;
    trace.push({ price, state, fired: res.fired, bands });
  }
  return trace;
}

/** Inclusive price ladder from `from` to `to` in `step` increments (step may be negative). */
const range = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let i = 0; ; i++) {
    const x = Math.round((from + i * step) * 1e6) / 1e6;
    if (step > 0 ? x > to + 1e-9 : x < to - 1e-9) break;
    out.push(x);
  }
  return out;
};

describe('computeBands', () => {
  it('matches the classic population-σ example (σ = 2, mean = 5)', () => {
    const b = computeBands([2, 4, 4, 4, 5, 5, 7, 9], 2);
    expect(b.middle).toBe(5);
    expect(b.stdDev).toBeCloseTo(2, 12);
    expect(b.upper).toBeCloseTo(9, 12);
    expect(b.lower).toBeCloseTo(1, 12);
  });

  it('collapses to a zero-width band on a flat window', () => {
    const b = computeBands(Array(20).fill(2350), 2);
    expect(b.stdDev).toBe(0);
    expect(b.upper).toBe(b.middle);
    expect(b.lower).toBe(b.middle);
  });
});

describe('computeTriggers (handoff §3.2)', () => {
  it('places T_bull and T_bear at r of the way from the band to the median', () => {
    const t = computeTriggers({ upper: 110, middle: 100, lower: 90, stdDev: 5 }, 0.85);
    expect(t.tBull).toBeCloseTo(98.5, 10);
    expect(t.tBear).toBeCloseTo(101.5, 10);
  });
});

describe('Guardrail A — flat market', () => {
  it('neither arms nor fires when σ = 0', () => {
    const flat = Array(19).fill(2350);
    const trace = run([2350, 2350, 2350], { r: 0.85, closes: flat });
    for (const s of trace) {
      expect(s.bands.stdDev).toBe(0);
      expect(s.state).toBe('NEUTRAL');
      expect(s.fired).toEqual([]);
    }
  });

  it('reports halted=true and leaves state untouched', () => {
    const bands = computeBands(Array(20).fill(50), 2);
    const res = evaluateTick({ state: 'ARMED_LOWER', lastArmedPrice: 40, price: 50, bands, reversionPct: 0.85 });
    expect(res).toEqual({ nextState: 'ARMED_LOWER', lastArmedPrice: 40, fired: [], halted: true });
  });
});

describe('Guardrail B — state transition matrix', () => {
  const bands: Bands = { upper: 105, middle: 100, lower: 95, stdDev: 2.5 };

  it('NEUTRAL → ARMED_LOWER on P ≤ L, with no push', () => {
    const res = evaluateTick({ state: 'NEUTRAL', lastArmedPrice: null, price: 94, bands, reversionPct: 0.85 });
    expect(res).toMatchObject({ nextState: 'ARMED_LOWER', lastArmedPrice: 94, fired: [] });
  });

  it('NEUTRAL → ARMED_UPPER on P ≥ U, with no push', () => {
    const res = evaluateTick({ state: 'NEUTRAL', lastArmedPrice: null, price: 106, bands, reversionPct: 0.85 });
    expect(res).toMatchObject({ nextState: 'ARMED_UPPER', lastArmedPrice: 106, fired: [] });
  });

  it('ARMED_LOWER stays armed while price is between L and T_bull', () => {
    // T_bull = 95 + 0.85·5 = 99.25
    const res = evaluateTick({ state: 'ARMED_LOWER', lastArmedPrice: 94, price: 98, bands, reversionPct: 0.85 });
    expect(res).toMatchObject({ nextState: 'ARMED_LOWER', fired: [] });
  });

  it('ARMED_LOWER fires bullish at T_bull and resets to NEUTRAL', () => {
    const res = evaluateTick({ state: 'ARMED_LOWER', lastArmedPrice: 94, price: 99.25, bands, reversionPct: 0.85 });
    expect(res).toMatchObject({ nextState: 'NEUTRAL', lastArmedPrice: null, fired: ['BULL_REVERSION'] });
  });

  it('ARMED_LOWER with an extreme spike ≥ U fires bullish AND arms upper', () => {
    const res = evaluateTick({ state: 'ARMED_LOWER', lastArmedPrice: 94, price: 106, bands, reversionPct: 0.85 });
    expect(res).toMatchObject({ nextState: 'ARMED_UPPER', lastArmedPrice: 106, fired: ['BULL_REVERSION'] });
  });

  it('ARMED_UPPER fires bearish at T_bear and resets to NEUTRAL', () => {
    // T_bear = 105 − 0.85·5 = 100.75
    const res = evaluateTick({ state: 'ARMED_UPPER', lastArmedPrice: 106, price: 100.75, bands, reversionPct: 0.85 });
    expect(res).toMatchObject({ nextState: 'NEUTRAL', fired: ['BEAR_REVERSION'] });
  });

  it('ARMED_UPPER with an extreme drop ≤ L fires bearish AND arms lower', () => {
    const res = evaluateTick({ state: 'ARMED_UPPER', lastArmedPrice: 106, price: 94, bands, reversionPct: 0.85 });
    expect(res).toMatchObject({ nextState: 'ARMED_LOWER', lastArmedPrice: 94, fired: ['BEAR_REVERSION'] });
  });
});

describe('Phase 2 verification scenarios (handoff §8.2)', () => {
  it('price touching L transitions NEUTRAL → ARMED_LOWER with 0 pushes', () => {
    const trace = run([100, 99, 96, 90]);
    const armedAt = trace.findIndex((s) => s.state === 'ARMED_LOWER');
    expect(armedAt).toBeGreaterThanOrEqual(0);
    const { price, bands } = trace[armedAt];
    expect(price).toBeLessThanOrEqual(bands.lower);
    expect(trace.flatMap((s) => s.fired)).toEqual([]);
  });

  it('price reaching L + 0.85(M − L) fires exactly 1 push and resets to NEUTRAL', () => {
    // Arm at 90, then climb in small steps until the bullish trigger is hit.
    const path = [90, ...range(90.05, 100, 0.05)];
    const trace = run(path);
    const fires = trace.filter((s) => s.fired.length > 0);

    expect(fires).toHaveLength(1);
    const f = fires[0];
    expect(f.fired).toEqual(['BULL_REVERSION']);
    expect(f.state).toBe('NEUTRAL');
    const { tBull } = computeTriggers(f.bands, 0.85);
    expect(f.price).toBeGreaterThanOrEqual(tBull - 1e-9);
    expect(f.price).toBeLessThan(f.bands.upper);
  });

  it('oscillating across T_bull and M after a fire produces 0 additional pushes', () => {
    const climb = [90, ...range(90.05, 100, 0.05)];
    const oscillate = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 99.6 : 100.4));
    const trace = run([...climb, ...oscillate]);
    const fires = trace.flatMap((s) => s.fired);
    expect(fires).toEqual(['BULL_REVERSION']);
    expect(trace.at(-1)?.state).toBe('NEUTRAL');
  });

  /** Arms at 90, then climbs in 0.01 steps until recovery reaches `target` (stays below the 85% trigger). */
  const climbToRecovery = (target: number): { path: number[]; price: number; bands: Bands } => {
    const path = [90];
    for (let p = 90.01; p < 101; p = Math.round((p + 0.01) * 1e6) / 1e6) {
      const bands = computeBands([...CLOSED_19, p], 2);
      const f = retracementFraction('BULL_REVERSION', p, bands)!;
      if (f >= target) return { path, price: p, bands };
      path.push(p);
    }
    throw new Error(`could not reach recovery ${target}`);
  };

  it('lowering reversion_pct 0.85 → 0.60 while ARMED_LOWER fires on the next tick once recovery ≥ 60%', () => {
    // Recovery 60% is reached before the 85% trigger, so the rule must still be armed at 0.85.
    const { path, price, bands } = climbToRecovery(0.6);
    expect(retracementFraction('BULL_REVERSION', price, bands)!).toBeLessThan(0.85);

    const armed = run([...path], { r: 0.85 });
    expect(armed.at(-1)?.state).toBe('ARMED_LOWER');

    // The tick at 60% recovery, evaluated at the original 85% threshold: nothing fires.
    const atThreshold = evaluateTick({
      state: 'ARMED_LOWER',
      lastArmedPrice: 90,
      price,
      bands,
      reversionPct: 0.85,
    });
    expect(atThreshold.fired).toEqual([]);
    expect(atThreshold.nextState).toBe('ARMED_LOWER');

    // Same tick after the user lowers the slider to 60%: fires immediately and resets.
    const lowered = evaluateTick({
      state: 'ARMED_LOWER',
      lastArmedPrice: 90,
      price,
      bands,
      reversionPct: 0.6,
    });
    expect(lowered.fired).toEqual(['BULL_REVERSION']);
    expect(lowered.nextState).toBe('NEUTRAL');
  });
});

describe('Bearish mirror', () => {
  it('arms on an upper touch and fires once at T_bear', () => {
    // Mirror of the bullish path around 100.
    const path = [110, ...range(109.95, 100, -0.05)];
    const trace = run(path);
    const armedAt = trace.findIndex((s) => s.state === 'ARMED_UPPER');
    expect(armedAt).toBeGreaterThanOrEqual(0);
    expect(trace.slice(0, armedAt).flatMap((s) => s.fired)).toEqual([]);

    const fires = trace.filter((s) => s.fired.length > 0);
    expect(fires).toHaveLength(1);
    expect(fires[0].fired).toEqual(['BEAR_REVERSION']);
    expect(fires[0].state).toBe('NEUTRAL');
    const { tBear } = computeTriggers(fires[0].bands, 0.85);
    expect(fires[0].price).toBeLessThanOrEqual(tBear + 1e-9);
  });
});

describe('retracementFraction', () => {
  it('is 0 at the band and 1 at the median', () => {
    const levels = { upper: 110, middle: 100, lower: 90 };
    expect(retracementFraction('BULL_REVERSION', 90, levels)).toBe(0);
    expect(retracementFraction('BULL_REVERSION', 100, levels)).toBe(1);
    expect(retracementFraction('BEAR_REVERSION', 110, levels)).toBe(0);
    expect(retracementFraction('BEAR_REVERSION', 100, levels)).toBe(1);
  });
});
