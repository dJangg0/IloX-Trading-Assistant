# BandAlert — Bollinger Band push-alert PoC

A PWA that watches instruments on Bollinger Bands (N = 20, k = 2) and sends a Web Push when price
touches an outer band and then retraces a set share (default 85%) back toward the median. Each touch
cycle fires once. Implements `engineering_handoff_implementation_guide.md`.

```
server/   Node 22 · Fastify · SQLite (better-sqlite3, WAL) · web-push (VAPID)
client/   React 19 · Vite · PWA (manifest + sw.js)
```

## Quick start

```bash
# 1. Server
cd server
npm install
cp -n .env.example .env       # -n: never overwrite an existing .env; then fill ADMIN_TOKEN and the VAPID keys
npm run dev                  # http://127.0.0.1:3001

# 2. Client (second terminal)
cd client
npm install
npm run dev                  # http://127.0.0.1:5173 (proxies /api to :3001)
```

Generate VAPID keys with `npx web-push generate-vapid-keys` and paste them into `server/.env`.
`ADMIN_TOKEN` is any string of 16+ characters. Paste it into the Admin token field in the app to
unlock changes; it is kept in localStorage.

## Tests

```bash
cd server && npm test        # Phase 2: FSM, Guardrails A–C, candle buffer, REST + end-to-end
cd client && npm run build   # typecheck + production build (served by the server from client/dist)
```

## Production / iPhone testing

Web Push needs HTTPS. Build the client, then serve everything from the Node server and expose it
through a tunnel (Cloudflare Tunnel, ngrok, or a reverse proxy):

```bash
cd client && npm run build
cd ../server && npm start    # serves client/dist and /api on PORT
```

On iPhone: open the HTTPS URL in Safari → Share → Add to Home Screen → launch from the icon → Enable notifications.

## Data feed

| `FEED_ADAPTER` | Source | Needs |
|---|---|---|
| `sifting` | Live commodities (XAUUSD, XAGUSD, NATGAS, …) from Sifting | `SIFTING_API_KEY` |
| `simulated` | Random-walk feed for development. Not market data. | nothing (default) |
| `custom` | Your provider: implement `server/src/adapters/customFeedAdapter.ts` | your code |

**Sifting notes**

- History comes from `/v1/hist/commodities/:symbol/bars`. Commodities have no 4h interval, so 4h candles are built from 1h bars on UTC 4h boundaries.
- Bars still forming are dropped. History is fetched in ascending order. `order=desc` is not used because it anchored on stale bars for 15m in testing.
- Live ticks come from `wss://stream.sifting.io/ws/v1`, product `com`. The key goes in the `?key=` parameter. Price is the bid/ask mid, falling back to last trade.
- Free tier: 60 REST req/min, 10,000 calls/month, 1 WebSocket connection, 5 subscriptions. Keep the monitor count within those limits.
- Check the feed without starting the server: `cd server && npx tsx scripts/sifting-smoke.ts XAUUSD 15`.

## Key behaviour

- Bands use the 19 most recent closed candles plus the live price. Population σ.
- Flat market (σ ≤ 1e-8) halts evaluation for that tick.
- FSM: `NEUTRAL` → `ARMED_LOWER` / `ARMED_UPPER` → fire once at the reversion trigger → `NEUTRAL`.
  Extreme spikes through the opposite band fire and re-arm in one step.
- DB rule update and alert insert commit in one transaction before any push is sent.
- Pushes use `TTL: 300`, `Urgency: high`. Subscriptions returning 404/410 are pruned.
- Every push event calls `showNotification` (required by iOS).
- Feed status is `LIVE` when a tick arrived in the last 15 s, otherwise `STALE` ("Feed Paused / Market Closed").
