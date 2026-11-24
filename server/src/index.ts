import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { SimulatedFeedAdapter } from './adapters/simulatedFeedAdapter.js';
import { CustomFeedAdapter } from './adapters/customFeedAdapter.js';
import { SiftingFeedAdapter } from './adapters/siftingFeedAdapter.js';
import { ChartService } from './chartService.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { openDb, Repo, type Db } from './db.js';
import { MonitorService } from './monitorService.js';
import { PushService } from './pushService.js';
import type { IMarketFeedAdapter } from './types/market.js';

// Node 22: load server/.env into process.env when present (no dotenv dependency).
const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function createAdapter(config: Config): IMarketFeedAdapter {
  if (config.feedAdapter === 'custom') return new CustomFeedAdapter();
  if (config.feedAdapter === 'sifting') return new SiftingFeedAdapter({ apiKey: config.siftingApiKey });
  return new SimulatedFeedAdapter({ tickMs: config.sim.tickMs, volatility: config.sim.volatility });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db: Db = openDb(config.dbPath);
  const repo = new Repo(db);
  const push = new PushService(repo, config.vapid);
  const adapter = createAdapter(config);
  const service = new MonitorService({ repo, adapter, push });
  const chart = new ChartService({ adapter, repo, live: (symbol, tf) => service.liveFor(symbol, tf) });

  await service.start();

  const app = await buildApp({
    service,
    chart,
    repo,
    push,
    adminToken: config.adminToken,
    vapidPublicKey: config.vapid.publicKey,
    corsOrigins: config.corsOrigins,
    staticDir: config.staticDir,
    logger: true,
  });

  await app.listen({ port: config.port, host: config.host });
  console.log(
    `BandAlert server on http://${config.host}:${config.port} · feed=${config.feedAdapter} · db=${config.dbPath}` +
      (config.staticDir ? ` · serving ${config.staticDir}` : ''),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    try {
      await service.stop(); // adapter.disconnect()
      await app.close();
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (err) {
      console.error('error during shutdown', err);
      process.exitCode = 1;
    } finally {
      process.exit(process.exitCode ?? 0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`Config error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
