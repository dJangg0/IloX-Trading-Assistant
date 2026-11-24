import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Repo } from './db.js';
import type { ChartService } from './chartService.js';
import { HttpError } from './errors.js';
import { normalizeSymbol, type MonitorService } from './monitorService.js';
import { buildTestPayload, type PushService } from './pushService.js';
import { TIMEFRAMES, type Timeframe } from './types/market.js';

export interface RouteDeps {
  service: MonitorService;
  chart: ChartService;
  repo: Repo;
  push: PushService;
  adminToken: string;
  vapidPublicKey: string;
}

const TIMEFRAME_ENUM = [...TIMEFRAMES];

/** Protects `Admin` endpoints (handoff §6.2). The token is compared via SHA-256 digests in constant time. */
function requireAdmin(expected: string) {
  const expectedDigest = createHash('sha256').update(expected).digest();
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers['x-admin-token'];
    if (typeof header !== 'string' || header.length === 0) {
      return reply.code(401).send({ error: 'X-Admin-Token header required' });
    }
    const digest = createHash('sha256').update(header).digest();
    if (!timingSafeEqual(digest, expectedDigest)) {
      return reply.code(403).send({ error: 'invalid admin token' });
    }
  };
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { service, repo, push } = deps;
  const admin = { preHandler: requireAdmin(deps.adminToken) };

  // ---- Public ---------------------------------------------------------------

  app.get('/api/health', async () => service.health());

  app.get('/api/vapid-public-key', async () => ({ publicKey: deps.vapidPublicKey }));

  app.post<{
    Body: { endpoint: string; keys: { p256dh: string; auth: string } };
  }>(
    '/api/subscriptions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['endpoint', 'keys'],
          properties: {
            endpoint: { type: 'string', minLength: 8, maxLength: 2048, pattern: '^https://' },
            keys: {
              type: 'object',
              required: ['p256dh', 'auth'],
              properties: {
                p256dh: { type: 'string', minLength: 1, maxLength: 256 },
                auth: { type: 'string', minLength: 1, maxLength: 256 },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const ua = req.headers['user-agent'];
      repo.upsertSubscription({
        id: randomUUID(),
        endpoint: req.body.endpoint,
        p256dh: req.body.keys.p256dh,
        auth: req.body.keys.auth,
        userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
      });
      return reply.code(201).send({ subscribed: true });
    },
  );

  app.delete<{ Body: { endpoint: string } }>(
    '/api/subscriptions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['endpoint'],
          properties: { endpoint: { type: 'string', minLength: 8, maxLength: 2048 } },
        },
      },
    },
    async (req) => ({ removed: repo.deleteSubscriptionByEndpoint(req.body.endpoint) > 0 }),
  );

  app.get('/api/monitors', async () => service.listMonitors());

  app.get<{ Querystring: { symbol: string; timeframe: Timeframe; limit?: number } }>(
    '/api/chart',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['symbol', 'timeframe'],
          properties: {
            symbol: { type: 'string', minLength: 1, maxLength: 40 },
            timeframe: { type: 'string', enum: TIMEFRAME_ENUM },
            limit: { type: 'integer', minimum: 20, maximum: 500, default: 200 },
          },
        },
      },
    },
    async (req) => {
      const symbol = normalizeSymbol(req.query.symbol);
      try {
        return await deps.chart.getChart(symbol, req.query.timeframe, req.query.limit ?? 200);
      } catch (err) {
        throw new HttpError(502, `market history unavailable: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    },
  );

  app.get<{ Querystring: { limit?: number } }>(
    '/api/alerts',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        },
      },
    },
    async (req) => service.listAlerts(req.query.limit ?? 50),
  );

  // ---- Admin ----------------------------------------------------------------

  app.post<{ Body: { symbol: string; timeframe: Timeframe; reversionPct?: number } }>(
    '/api/monitors',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['symbol', 'timeframe'],
          properties: {
            symbol: { type: 'string', minLength: 1, maxLength: 40 },
            timeframe: { type: 'string', enum: TIMEFRAME_ENUM },
            reversionPct: { type: 'number' },
          },
        },
      },
    },
    async (req, reply) => reply.code(201).send(service.createRule(req.body)),
  );

  app.patch<{ Params: { id: string }; Body: { reversionPct?: number; isActive?: boolean } }>(
    '/api/monitors/:id',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            reversionPct: { type: 'number' },
            isActive: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => service.updateRule(req.params.id, req.body),
  );

  app.delete<{ Params: { id: string } }>('/api/monitors/:id', admin, async (req, reply) => {
    service.deleteRule(req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Body: { symbol: string; timeframe: Timeframe; price: number } }>(
    '/api/debug/simulate-price',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          required: ['symbol', 'timeframe', 'price'],
          properties: {
            symbol: { type: 'string', minLength: 1, maxLength: 40 },
            timeframe: { type: 'string', enum: TIMEFRAME_ENUM },
            price: { type: 'number' },
          },
        },
      },
    },
    async (req) => service.simulatePrice(req.body),
  );

  app.post('/api/notifications/test', admin, async () => push.dispatch(buildTestPayload(Date.now())));
}

