// Live smoke test for the Sifting adapter. Reads SIFTING_API_KEY from server/.env (never prints it).
// Usage: npx tsx scripts/sifting-smoke.ts [SYMBOL] [STREAM_SECONDS]
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SiftingFeedAdapter } from '../src/adapters/siftingFeedAdapter.js';
import { TIMEFRAMES, type MarketTick } from '../src/types/market.js';

if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));
const apiKey = process.env.SIFTING_API_KEY;
if (!apiKey) throw new Error('SIFTING_API_KEY is not set in server/.env');

const symbol = process.argv[2] ?? 'XAUUSD';
const seconds = Number(process.argv[3] ?? 15);
const adapter = new SiftingFeedAdapter({ apiKey, log: { info: console.log, warn: console.warn, error: console.error } });

async function main() {
  for (const tf of TIMEFRAMES) {
    const candles = await adapter.fetchHistoricalCandles(symbol, tf, 25);
    const last = candles.at(-1);
    const ok = candles.every((c, i) => i === 0 || c.openTimeMs > candles[i - 1].openTimeMs);
    console.log(
      `${tf.padEnd(4)} candles=${String(candles.length).padStart(2)} ascending=${ok} ` +
        (last ? `last open=${new Date(last.openTimeMs).toISOString()} close=${last.close} closed=${last.isClosed}` : 'NONE'),
    );
  }

  const ticks: MarketTick[] = [];
  await adapter.subscribe([symbol], (t) => ticks.push(t));
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await adapter.disconnect();
  const first = ticks[0];
  const last = ticks.at(-1);
  console.log(
    `stream ${symbol}: ticks=${ticks.length} in ${seconds}s` +
      (first && last ? ` first=${first.price}@${new Date(first.timestampMs).toISOString()} last=${last.price}` : ''),
  );
  process.exit(ticks.length > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
