import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChartService, mergeSeries } from '../src/chartService.js';
import { computeBands, rollingBands } from '../src/bollingerEngine.js';
import { openDb, Repo } from '../src/db.js';
import { MonitorService, type LiveTail } from '../src/monitorService.js';
import { PushService } from '../src/pushService.js';
import type { Candle, IMarketFeedAdapter, Timeframe } from '../src/types/market.js';
import { TIMEFRAME_MS } from '../src/types/market.js';
import webpush from 'web-push';

const MIN = 60_000;
const bucketNow = (tf: Timeframe, ms = Date.now()) => Math.floor(ms / TIMEFRAME_MS[tf]) * TIMEFRAME_MS[tf];

function candle(symbol: string, tf: Timeframe, openTimeMs: number, close: number): Candle {
  return { symbol, timeframe: tf, openTimeMs, open: close - 0.5, high: close + 1, low: close - 1, close, isClosed: true };
}

/** `count` closed 1m candles ending right before the current bucket, closes oscillating around 100. */
function history(symbol: string, count: number, tf: Timeframe = '1m'): Candle[] {
  const end = bucketNow(tf);
  return Array.from({ length: count }, (_, i) =>
    candle(symbol, tf, end - (count - i) * TIMEFRAME_MS[tf], 100 + (i % 2 === 0 ? 1 : -1) * (1 + (i % 5) * 0.2)),
  );
}

function fakeAdapter(data: Candle[] | (() => Candle[])): IMarketFeedAdapter & { calls: number } {
  const a = {
    calls: 0,
    async fetchHistoricalCandles() {
      a.calls++;
      return typeof data === 'function' ? data() : data;
    },
    async subscribe() {},
    async updateSubscriptions() {},
    async disconnect() {},
  };
  return a;
}

const quietLog = { info() {}, warn() {}, error() {} };

describe('rollingBands', () => {
  it('matches computeBands on each full window and is null before the first full window', () => {
    const closes = [1, 2, 3, 4, 5, 6];
    const series = rollingBands(closes, 3, 2);
    expect(series[0]).toBeNull();
    expect(series[1]).toBeNull();
    expect(series[2]).toEqual(computeBands([1, 2, 3], 2));
    expect(series[5]).toEqual(computeBands([4, 5, 6], 2));
  });
});

describe('mergeSeries', () => {
  it('keeps vendor history before the tail and lets tick-built candles replace it from the tail start', () => {
    const t = (i: number) => i * MIN;
    const vendor = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => candle('XAUUSD', '1m', t(i), 100 + i));
    const tail = {
      closed: [candle('XAUUSD', '1m', t(5), 555), candle('XAUUSD', '1m', t(6), 666)],
      active: candle('XAUUSD', '1m', t(7), 777),
    };
    const merged = mergeSeries(vendor, tail);

    expect(merged.map((c) => c.openTimeMs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(t));
    expect(merged.map((c) => c.close)).toEqual([100, 101, 102, 103, 104, 555, 666, 777]);
  });

  it('returns sorted vendor history when there is no tail', () => {
    const vendor = [candle('XAUUSD', '1m', 2 * MIN, 2), candle('XAUUSD', '1m', 0, 0)];
    expect(mergeSeries(vendor, { closed: [], active: null }).map((c) => c.close)).toEqual([0, 2]);
  });
});

describe('ChartService.getChart', () => {
  it('returns the requested number of candles with bands computed over the full series', async () => {
    const data = history('XAUUSD', 40);
    const db = openDb(':memory:');
    const repo = new Repo(db);
    const chart = new ChartService({
      adapter: fakeAdapter(data),
      repo,
      live: (): LiveTail => ({ closed: [], active: null, price: null, feedStatus: 'STALE', monitor: null }),
    });

    const res = await chart.getChart('XAUUSD', '1m', 20);

    expect(res.candles).toHaveLength(20);
    expect(res.bands).toHaveLength(20); // every shown candle has a full 20-close window behind it
    const last = res.bands.at(-1)!;
    const expected = computeBands(data.slice(-20).map((c) => c.close), 2);
    expect(last.middle).toBeCloseTo(expected.middle, 10);
    expect(last.upper).toBeCloseTo(expected.upper, 10);
    expect(res.candles.at(-1)!.time).toBe(Math.floor(data.at(-1)!.openTimeMs / 1000));
    expect(res.triggers).toBeNull();
    expect(res.historyStale).toBe(false);
    db.close();
  });

  it('appends the live forming candle and reports its price', async () => {
    const data = history('XAUUSD', 40);
    const activeOpen = bucketNow('1m');
    const db = openDb(':memory:');
    const chart = new ChartService({
      adapter: fakeAdapter(data),
      repo: new Repo(db),
      live: (): LiveTail => ({
        closed: [],
        active: candle('XAUUSD', '1m', activeOpen, 108),
        price: 108,
        feedStatus: 'LIVE',
        monitor: null,
      }),
    });

    const res = await chart.getChart('XAUUSD', '1m', 20);
    expect(res.candles.at(-1)!.time).toBe(activeOpen / 1000);
    expect(res.candles.at(-1)!.close).toBe(108);
    expect(res.live).toEqual({ price: 108, feedStatus: 'LIVE' });
    db.close();
  });

  it('shows the monitor trigger levels and alert markers, placed on the candle that fired', async () => {
    const data = history('XAUUSD', 40);
    const db = openDb(':memory:');
    const repo = new Repo(db);
    repo.insertRule({ id: 'r1', symbol: 'XAUUSD', timeframe: '1m', bbPeriod: 20, bbStdDev: 2, reversionPct: 0.85 });
    repo.insertAlert({
      id: 'a1',
      ruleId: 'r1',
      symbol: 'XAUUSD',
      timeframe: '1m',
      direction: 'BULL_REVERSION',
      reversionPct: 0.85,
      triggerPrice: 99.5,
      upperBand: 101,
      middleBand: 100,
      lowerBand: 99,
    });
    const monitor = {
      id: 'r1',
      symbol: 'XAUUSD',
      timeframe: '1m' as Timeframe,
      isActive: true,
      reversionPct: 0.85,
      fsmState: 'ARMED_LOWER' as const,
      lastArmedPrice: 98,
      lastTriggeredAt: null,
      ready: true,
      price: 100,
      upper: 101,
      middle: 100,
      lower: 99,
      tBull: 99.85,
      tBear: 100.15,
      feedStatus: 'LIVE' as const,
    };
    const chart = new ChartService({
      adapter: fakeAdapter(data),
      repo,
      live: (): LiveTail => ({ closed: [], active: null, price: 100, feedStatus: 'LIVE', monitor }),
    });

    const res = await chart.getChart('XAUUSD', '1m', 20);

    expect(res.triggers).toEqual({ monitorId: 'r1', reversionPct: 0.85, fsmState: 'ARMED_LOWER', tBull: 99.85, tBear: 100.15 });
    // The alert was created "now", which falls in the current bucket.
    expect(res.alerts).toEqual([{ id: 'a1', time: bucketNow('1m') / 1000, direction: 'BULL_REVERSION', price: 99.5 }]);
    db.close();
  });

  it('serves stale history when the vendor fails after a successful fetch', async () => {
    const data = history('XAUUSD', 40);
    let clock = 1_000_000;
    let failing = false;
    const adapter = fakeAdapter(() => {
      if (failing) throw new Error('vendor down');
      return data;
    });
    const db = openDb(':memory:');
    const chart = new ChartService({
      adapter,
      repo: new Repo(db),
      now: () => clock,
      live: (): LiveTail => ({ closed: [], active: null, price: null, feedStatus: 'STALE', monitor: null }),
    });

    await chart.getChart('XAUUSD', '1m', 20);
    clock += 60_000; // past the 15 s cache TTL
    failing = true;
    const res = await chart.getChart('XAUUSD', '1m', 20);

    expect(res.historyStale).toBe(true);
    expect(res.candles).toHaveLength(20);
    db.close();
  });

  it('throws when the vendor fails and nothing is cached', async () => {
    const db = openDb(':memory:');
    const chart = new ChartService({
      adapter: fakeAdapter(() => {
        throw new Error('vendor down');
      }),
      repo: new Repo(db),
      live: (): LiveTail => ({ closed: [], active: null, price: null, feedStatus: 'STALE', monitor: null }),
    });
    await expect(chart.getChart('XAUUSD', '1m', 20)).rejects.toThrow('vendor down');
    db.close();
  });
});

describe('GET /api/chart', () => {
  const apps: Array<{ close(): Promise<unknown> }> = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
  });

  async function appWith(adapter: IMarketFeedAdapter) {
    const db = openDb(':memory:');
    const repo = new Repo(db);
    const vapid = webpush.generateVAPIDKeys();
    const push = new PushService(repo, { subject: 'mailto:test@example.com', ...vapid }, quietLog);
    const service = new MonitorService({ repo, adapter, push, log: quietLog });
    const chart = new ChartService({ adapter, repo, live: (s, tf) => service.liveFor(s, tf) });
    const app = await buildApp({
      service,
      chart,
      repo,
      push,
      adminToken: 'test-admin-token-0123456789',
      vapidPublicKey: vapid.publicKey,
      corsOrigins: [],
      staticDir: null,
    });
    apps.push(app);
    return app;
  }

  it('returns chart data for a valid request', async () => {
    const app = await appWith(fakeAdapter(history('XAUUSD', 60)));
    const res = await app.inject({ method: 'GET', url: '/api/chart?symbol=xauusd&timeframe=1m&limit=30' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ symbol: string; candles: unknown[]; bands: unknown[] }>();
    expect(body.symbol).toBe('XAUUSD');
    expect(body.candles).toHaveLength(30);
    expect(body.bands.length).toBeGreaterThan(0);
  });

  it('rejects an unknown timeframe and an out-of-range limit with 400', async () => {
    const app = await appWith(fakeAdapter(history('XAUUSD', 60)));
    expect((await app.inject({ method: 'GET', url: '/api/chart?symbol=XAUUSD&timeframe=2m' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/chart?symbol=XAUUSD&timeframe=1m&limit=5000' })).statusCode).toBe(400);
  });

  it('returns 502 with the reason when market history is unavailable', async () => {
    const app = await appWith(
      fakeAdapter(() => {
        throw new Error('Sifting bars request failed: HTTP 503');
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/chart?symbol=XAUUSD&timeframe=1m' });
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: string }>().error).toContain('HTTP 503');
  });
});
