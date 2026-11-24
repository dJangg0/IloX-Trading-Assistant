import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { VapidConfig } from './pushService.js';

export type FeedAdapterName = 'simulated' | 'sifting' | 'custom';

export interface Config {
  port: number;
  host: string;
  adminToken: string;
  vapid: VapidConfig;
  dbPath: string;
  feedAdapter: FeedAdapterName;
  siftingApiKey: string;
  corsOrigins: string[];
  /** Built client to serve from the same origin (for single-tunnel HTTPS). Null when absent. */
  staticDir: string | null;
  sim: { tickMs: number; volatility: number };
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const adminToken = env.ADMIN_TOKEN ?? '';
  if (adminToken.length < 16) {
    throw new ConfigError('ADMIN_TOKEN is required and must be at least 16 characters. See server/.env.example.');
  }

  const publicKey = env.VAPID_PUBLIC_KEY ?? '';
  const privateKey = env.VAPID_PRIVATE_KEY ?? '';
  if (!publicKey || !privateKey) {
    throw new ConfigError('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required. Run: npx web-push generate-vapid-keys');
  }

  const feedAdapter = (env.FEED_ADAPTER ?? 'simulated') as FeedAdapterName;
  if (feedAdapter !== 'simulated' && feedAdapter !== 'sifting' && feedAdapter !== 'custom') {
    throw new ConfigError(`FEED_ADAPTER must be "simulated", "sifting" or "custom", got "${feedAdapter}"`);
  }

  const siftingApiKey = env.SIFTING_API_KEY ?? '';
  if (feedAdapter === 'sifting' && !siftingApiKey) {
    throw new ConfigError('FEED_ADAPTER=sifting requires SIFTING_API_KEY');
  }

  const clientDist = resolve(process.cwd(), env.STATIC_DIR ?? '../client/dist');

  return {
    port: parseIntEnv(env.PORT, 3001, 'PORT'),
    host: env.HOST ?? '127.0.0.1',
    adminToken,
    vapid: {
      subject: env.VAPID_SUBJECT ?? 'mailto:bandalert@example.com',
      publicKey,
      privateKey,
    },
    dbPath: resolve(process.cwd(), env.DB_PATH ?? './data/bandalert.db'),
    feedAdapter,
    siftingApiKey,
    corsOrigins: (env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    staticDir: existsSync(resolve(clientDist, 'index.html')) ? clientDist : null,
    sim: {
      tickMs: parseIntEnv(env.SIM_TICK_MS, 1000, 'SIM_TICK_MS'),
      volatility: Number(env.SIM_VOLATILITY ?? 0.0005),
    },
  };
}

function parseIntEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}
