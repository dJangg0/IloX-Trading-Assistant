import webpush from 'web-push';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { ChartService } from '../src/chartService.js';
import { SimulatedFeedAdapter } from '../src/adapters/simulatedFeedAdapter.js';
import { openDb, Repo } from '../src/db.js';
import { MonitorService, type MonitorView } from '../src/monitorService.js';
import { PushService } from '../src/pushService.js';
import type { Timeframe } from '../src/types/market.js';

const ADMIN = 'test-admin-token-0123456789';
const ADMIN_HEADERS = { 'x-admin-token': ADMIN };

let vapid: { publicKey: string; privateKey: string };

beforeAll(() => {
  vapid = webpush.generateVAPIDKeys();
});

interface Harness {
  app: FastifyInstance;
  service: MonitorService;
  repo: Repo;
}

async function harness(): Promise<Harness> {
  const db = openDb(':memory:');
  const repo = new Repo(db);
  const push = new PushService(repo, { subject: 'mailto:test@example.com', ...vapid }, { warn() {}, error() {}, info() {} });
  const adapter = new SimulatedFeedAdapter({ tickMs: 60_000, volatility: 0.0005, random: seeded(42) });
  const service = new MonitorService({ repo, adapter, push, log: { info() {}, warn() {}, error() {} } });
  const chart = new ChartService({ adapter, repo, live: (symbol, tf) => service.liveFor(symbol, tf) });
  const app = await buildApp({
    service,
    chart,
    repo,
    push,
    adminToken: ADMIN,
    vapidPublicKey: vapid.publicKey,
    corsOrigins: [],
    staticDir: null,
  });
  return { app, service, repo };
}

/** Deterministic PRNG so the simulated history is stable across runs. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * `ready` needs history AND a live price (the live price is C_t). Prime one price, then wait for
 * the background history warm-up to finish.
 */
async function waitForReady(service: MonitorService, id: string, prime?: { symbol: string; timeframe: Timeframe; price: number }): Promise<MonitorView> {
  if (prime) service.simulatePrice(prime);
  for (let i = 0; i < 200; i++) {
    const m = service.listMonitors().find((x) => x.id === id);
    if (m && m.ready) return m;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`monitor ${id} never became ready`);
}

describe('admin authentication (handoff §6.2)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it('rejects admin calls without a token with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/monitors',
      payload: { symbol: 'XAUUSD', timeframe: '4h' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects admin calls with a wrong token with 403', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: { 'x-admin-token': 'nope' },
      payload: { symbol: 'XAUUSD', timeframe: '4h' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('keeps public reads open without a token', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/monitors' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('monitor validation & lifecycle', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it('creates a rule with the 0.85 default and warms it up', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: ADMIN_HEADERS,
      payload: { symbol: 'xauusd', timeframe: '4h' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<MonitorView>();
    expect(body).toMatchObject({ symbol: 'XAUUSD', timeframe: '4h', reversionPct: 0.85, fsmState: 'NEUTRAL' });

    const ready = await waitForReady(h.service, body.id, { symbol: 'XAUUSD', timeframe: '4h', price: 2350 });
    expect(ready.upper).toBeGreaterThan(ready.middle!);
    expect(ready.lower).toBeLessThan(ready.middle!);
    expect(ready.tBull).toBeGreaterThan(ready.lower!);
  });

  it('rejects a reversionPct outside [0.10, 1.00] with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: ADMIN_HEADERS,
      payload: { symbol: 'EURUSD', timeframe: '1h', reversionPct: 1.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown timeframe with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: ADMIN_HEADERS,
      payload: { symbol: 'EURUSD', timeframe: '2m' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a duplicate (symbol, timeframe) with 409', async () => {
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: ADMIN_HEADERS,
      payload: { symbol: 'EURUSD', timeframe: '1h' },
    });
    expect(first.statusCode).toBe(201);
    const dup = await h.app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: ADMIN_HEADERS,
      payload: { symbol: 'EURUSD', timeframe: '1h' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('PATCH validates the range (400) and persists a valid reversionPct', async () => {
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/api/monitors',
        headers: ADMIN_HEADERS,
        payload: { symbol: 'EURUSD', timeframe: '15m' },
      })
    ).json<MonitorView>();

    const bad = await h.app.inject({
      method: 'PATCH',
      url: `/api/monitors/${created.id}`,
      headers: ADMIN_HEADERS,
      payload: { reversionPct: 0.05 },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await h.app.inject({
      method: 'PATCH',
      url: `/api/monitors/${created.id}`,
      headers: ADMIN_HEADERS,
      payload: { reversionPct: 0.6 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<MonitorView>().reversionPct).toBe(0.6);
  });

  it('reports feedStatus STALE until a tick arrives', async () => {
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/api/monitors',
        headers: ADMIN_HEADERS,
        payload: { symbol: 'EURUSD', timeframe: '1h' },
      })
    ).json<MonitorView>();
    expect(created.feedStatus).toBe('STALE');
  });

  it('deletes a rule and returns 204', async () => {
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/api/monitors',
        headers: ADMIN_HEADERS,
        payload: { symbol: 'NAS100', timeframe: '5m' },
      })
    ).json<MonitorView>();

    const del = await h.app.inject({ method: 'DELETE', url: `/api/monitors/${created.id}`, headers: ADMIN_HEADERS });
    expect(del.statusCode).toBe(204);
    const list = await h.app.inject({ method: 'GET', url: '/api/monitors' });
    expect(list.json()).toEqual([]);
  });
});

describe('end-to-end through the debug price injector', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it('arms on a crash, then an extreme spike fires bullish once and arms the upper watch', async () => {
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/api/monitors',
        headers: ADMIN_HEADERS,
        payload: { symbol: 'XAUUSD', timeframe: '4h' },
      })
    ).json<MonitorView>();
    await waitForReady(h.service, created.id, { symbol: 'XAUUSD', timeframe: '4h', price: 2350 });

    const inject = (price: number) =>
      h.app.inject({
        method: 'POST',
        url: '/api/debug/simulate-price',
        headers: ADMIN_HEADERS,
        payload: { symbol: 'XAUUSD', timeframe: '4h', price },
      });

    // Crash far below the lower band → NEUTRAL → ARMED_LOWER with no push.
    const armed = (await inject(1850)).json<MonitorView>();
    expect(armed.fsmState).toBe('ARMED_LOWER');
    expect((await h.app.inject({ method: 'GET', url: '/api/alerts' })).json()).toEqual([]);

    // Spike far above the upper band → fires bullish and arms upper.
    const spiked = (await inject(2850)).json<MonitorView>();
    expect(spiked.fsmState).toBe('ARMED_UPPER');

    const alerts = (await h.app.inject({ method: 'GET', url: '/api/alerts?limit=10' })).json<
      Array<{ direction: string; symbol: string; triggerPrice: number }>
    >();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ direction: 'BULL_REVERSION', symbol: 'XAUUSD', triggerPrice: 2850 });
  });

  it('returns 404 for an unknown monitor and 409 for a paused one', async () => {
    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/debug/simulate-price',
      headers: ADMIN_HEADERS,
      payload: { symbol: 'XAUUSD', timeframe: '4h', price: 2350 },
    });
    expect(missing.statusCode).toBe(404);

    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/api/monitors',
        headers: ADMIN_HEADERS,
        payload: { symbol: 'XAUUSD', timeframe: '4h' },
      })
    ).json<MonitorView>();
    await h.app.inject({
      method: 'PATCH',
      url: `/api/monitors/${created.id}`,
      headers: ADMIN_HEADERS,
      payload: { isActive: false },
    });
    const paused = await h.app.inject({
      method: 'POST',
      url: '/api/debug/simulate-price',
      headers: ADMIN_HEADERS,
      payload: { symbol: 'XAUUSD', timeframe: '4h', price: 2350 },
    });
    expect(paused.statusCode).toBe(409);
  });
});

describe('public endpoints', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it('serves health and the VAPID public key', async () => {
    const health = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toMatchObject({ status: 'ok', activeSubscriptions: 0 });

    const key = await h.app.inject({ method: 'GET', url: '/api/vapid-public-key' });
    expect(key.json()).toEqual({ publicKey: vapid.publicKey });
  });

  it('upserts and removes a device push subscription', async () => {
    const payload = {
      endpoint: 'https://push.example.test/send/abc123',
      keys: { p256dh: 'BPk0e', auth: 'auth-secret' },
    };
    const created = await h.app.inject({ method: 'POST', url: '/api/subscriptions', payload });
    expect(created.statusCode).toBe(201);

    // Re-subscribing the same endpoint must upsert, not duplicate.
    await h.app.inject({ method: 'POST', url: '/api/subscriptions', payload });
    expect(h.repo.countSubscriptions()).toBe(1);

    const removed = await h.app.inject({
      method: 'DELETE',
      url: '/api/subscriptions',
      payload: { endpoint: payload.endpoint },
    });
    expect(removed.json()).toEqual({ removed: true });
  });

  it('rejects a non-https push endpoint with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      payload: { endpoint: 'http://insecure.example/x', keys: { p256dh: 'a', auth: 'b' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown API routes rather than the SPA fallback', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });
});
