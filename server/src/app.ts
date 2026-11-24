import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Repo } from './db.js';
import { HttpError } from './errors.js';
import type { ChartService } from './chartService.js';
import type { MonitorService } from './monitorService.js';
import type { PushService } from './pushService.js';
import { registerRoutes } from './routes.js';

export interface AppDeps {
  service: MonitorService;
  chart: ChartService;
  repo: Repo;
  push: PushService;
  adminToken: string;
  vapidPublicKey: string;
  corsOrigins: string[];
  /** Directory with the built PWA (index.html). Served same-origin, with SPA fallback. */
  staticDir: string | null;
  logger?: boolean;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 16 * 1024 });

  await app.register(cors, {
    origin: deps.corsOrigins.length > 0 ? deps.corsOrigins : false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-Admin-Token'],
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    const status = typeof err.statusCode === 'number' && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) app.log.error(err);
    return reply.code(status).send({ error: status === 500 ? 'internal error' : err.message });
  });

  registerRoutes(app, {
    service: deps.service,
    chart: deps.chart,
    repo: deps.repo,
    push: deps.push,
    adminToken: deps.adminToken,
    vapidPublicKey: deps.vapidPublicKey,
  });

  if (deps.staticDir) {
    // wildcard: serve whatever is in the build directory at request time (no restart needed after a rebuild).
    await app.register(fastifyStatic, { root: deps.staticDir, prefix: '/', wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0];
      // Missing assets (paths ending in an extension) must 404, never return index.html as JS/CSS.
      const looksLikeFile = /\.[A-Za-z0-9]+$/.test(path);
      if (req.method === 'GET' && !path.startsWith('/api/') && !looksLikeFile) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}
