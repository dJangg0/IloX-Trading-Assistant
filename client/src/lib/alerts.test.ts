import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findNewAlerts, toToast } from './alerts';
import type { AlertView } from './types';

const alert = (id: string, over: Partial<AlertView> = {}): AlertView => ({
  id,
  symbol: 'XAUUSD',
  timeframe: '5m',
  direction: 'BULL_REVERSION',
  reversionPct: 0.85,
  triggerPrice: 3619.5,
  upper: 3628,
  middle: 3620.6,
  lower: 3613.2,
  retracedPct: 0.85,
  createdAt: '2026-11-24 06:35:48',
  ...over,
});

test('findNewAlerts returns only alerts whose ids were not seen', () => {
  const seen = new Set(['a1']);
  const fresh = findNewAlerts(seen, [alert('a2'), alert('a1'), alert('a3')]);
  assert.deepEqual(fresh.map((a) => a.id), ['a2', 'a3']);
});

test('findNewAlerts is empty when everything has been seen', () => {
  assert.deepEqual(findNewAlerts(new Set(['a1']), [alert('a1')]), []);
});

test('toToast formats a bullish alert with the trigger price and retracement', () => {
  const t = toToast(alert('a1'));
  assert.equal(t.tone, 'bull');
  assert.equal(t.title, '▲ Bullish reversion · XAUUSD 5m');
  assert.equal(t.body, '@ 3619.50 · 85% back to the median');
});

test('toToast formats a bearish alert and an overshoot past the median', () => {
  const t = toToast(alert('a2', { direction: 'BEAR_REVERSION', retracedPct: 1.31 }));
  assert.equal(t.tone, 'bear');
  assert.equal(t.title, '▼ Bearish reversion · XAUUSD 5m');
  assert.equal(t.body, '@ 3619.50 · through the median');
});

test('toToast omits the retracement when it cannot be computed', () => {
  assert.equal(toToast(alert('a3', { retracedPct: null })).body, '@ 3619.50');
});
