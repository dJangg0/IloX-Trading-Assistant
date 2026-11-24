import { describe, expect, it } from 'vitest';
import { bucketOpenMs, CandleManager } from '../src/candleManager.js';
import type { Candle } from '../src/types/market.js';

const MIN = 60_000;

describe('bucketOpenMs (handoff §4.1, UTC-aligned)', () => {
  it('floors to the candle boundary for each timeframe', () => {
    const t = Date.UTC(2026, 0, 5, 13, 7, 33, 500);
    expect(bucketOpenMs(t, '1m')).toBe(Date.UTC(2026, 0, 5, 13, 7));
    expect(bucketOpenMs(t, '5m')).toBe(Date.UTC(2026, 0, 5, 13, 5));
    expect(bucketOpenMs(t, '15m')).toBe(Date.UTC(2026, 0, 5, 13, 0));
    expect(bucketOpenMs(t, '1h')).toBe(Date.UTC(2026, 0, 5, 13, 0));
    expect(bucketOpenMs(t, '4h')).toBe(Date.UTC(2026, 0, 5, 12, 0));
  });
});

describe('CandleManager', () => {
  const tick = (price: number, timestampMs: number) => ({ symbol: 'XAUUSD', price, timestampMs });

  it('initialises a candle on the first tick and tracks OHLC within a bucket', () => {
    const cm = new CandleManager('XAUUSD', '1m', 19);
    expect(cm.ingest(tick(10, 0))).toEqual({ rolledOver: false, ignored: false });
    cm.ingest(tick(12, 10_000));
    cm.ingest(tick(9, 20_000));
    cm.ingest(tick(11, 30_000));

    expect(cm.activeCandle()).toMatchObject({ open: 10, high: 12, low: 9, close: 11, openTimeMs: 0, isClosed: false });
    expect(cm.closedCount()).toBe(0);
  });

  it('rolls over at the bucket boundary, finalising the previous candle with its last price', () => {
    const cm = new CandleManager('XAUUSD', '1m', 19);
    cm.ingest(tick(10, 0));
    cm.ingest(tick(14, 59_999));
    const res = cm.ingest(tick(15, MIN));

    expect(res).toEqual({ rolledOver: true, ignored: false });
    expect(cm.closedCloses()).toEqual([14]);
    expect(cm.activeCandle()).toMatchObject({ openTimeMs: MIN, open: 15, high: 15, low: 15, close: 15 });
  });

  it('evicts the oldest closed candle beyond capacity', () => {
    const cm = new CandleManager('XAUUSD', '1m', 3);
    for (let i = 0; i < 6; i++) cm.ingest(tick(100 + i, i * MIN));
    // Ticks at minutes 0..5 close minutes 0..4; capacity 3 keeps the last three closes.
    expect(cm.closedCloses()).toEqual([102, 103, 104]);
    expect(cm.closedCount()).toBe(3);
  });

  it('drops ticks that belong to an earlier bucket than the active candle', () => {
    const cm = new CandleManager('XAUUSD', '1m', 19);
    cm.ingest(tick(10, 2 * MIN));
    const res = cm.ingest(tick(99, MIN + 1));
    expect(res).toEqual({ rolledOver: false, ignored: true });
    expect(cm.activeCandle()?.close).toBe(10);
  });

  it('setHistory keeps only closed candles older than the active bucket, sorted and capped', () => {
    const cm = new CandleManager('XAUUSD', '1m', 3);
    cm.ingest(tick(50, 10 * MIN));

    const mk = (i: number, closed = true): Candle => ({
      symbol: 'XAUUSD',
      timeframe: '1m',
      openTimeMs: i * MIN,
      open: i,
      high: i,
      low: i,
      close: i,
      isClosed: closed,
    });
    const fetched = [mk(8), mk(2), mk(5), mk(6, false), mk(9), mk(10), mk(7), mk(4), mk(3)];
    cm.setHistory(fetched);

    // Active bucket is 10: 6 is still open and 10 is not strictly older, so both are dropped.
    // Of {2,3,4,5,7,8,9} the last three by open time survive the capacity of 3.
    expect(cm.closedCloses()).toEqual([7, 8, 9]);
  });

  it('setHistory ignores candles from other symbols or timeframes', () => {
    const cm = new CandleManager('XAUUSD', '5m', 19);
    cm.setHistory([
      { symbol: 'EURUSD', timeframe: '5m', openTimeMs: 0, open: 1, high: 1, low: 1, close: 1, isClosed: true },
      { symbol: 'XAUUSD', timeframe: '1m', openTimeMs: MIN, open: 2, high: 2, low: 2, close: 2, isClosed: true },
      { symbol: 'XAUUSD', timeframe: '5m', openTimeMs: 2 * MIN, open: 3, high: 3, low: 3, close: 3, isClosed: true },
    ]);
    expect(cm.closedCloses()).toEqual([3]);
  });

  it('rejects an invalid capacity', () => {
    expect(() => new CandleManager('XAUUSD', '1m', 0)).toThrow(RangeError);
  });
});
