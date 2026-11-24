import webpush from 'web-push';
import type { Repo, SubscriptionRow } from './db.js';
import type { Direction } from './bollingerEngine.js';
import type { Timeframe } from './types/market.js';

export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export interface PushPayload {
  type: 'alert' | 'test';
  title: string;
  body: string;
  symbol: string;
  timeframe: Timeframe | 'TEST';
  direction?: Direction;
  triggerPrice?: number;
  reversionPct?: number;
  timestamp: number;
}

export interface DispatchResult {
  sent: number;
  failed: number;
  pruned: number;
}

/** Handoff §7.5: TTL expires stale trading alerts after 5 minutes; Urgency high for non-silent delivery. */
export const PUSH_OPTIONS = { TTL: 300, headers: { Urgency: 'high' } } as const;

export class PushService {
  constructor(
    private readonly repo: Repo,
    vapid: VapidConfig,
    private readonly log: Pick<Console, 'warn' | 'error' | 'info'> = console,
  ) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  activeSubscriptions(): number {
    return this.repo.countSubscriptions();
  }

  /** Fans out to every registered device. Never throws; failures are counted and logged. */
  async dispatch(payload: PushPayload): Promise<DispatchResult> {
    const subs = this.repo.listSubscriptions();
    if (subs.length === 0) return { sent: 0, failed: 0, pruned: 0 };

    const body = JSON.stringify(payload);
    const results = await Promise.allSettled(subs.map((s) => this.sendOne(s, body)));

    let sent = 0;
    let failed = 0;
    let pruned = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value === 'sent') sent++;
        else if (r.value === 'pruned') pruned++;
        else failed++;
      } else {
        failed++;
        this.log.error('push dispatch crashed', r.reason);
      }
    }

    if (pruned > 0) this.log.info(`pruned ${pruned} expired push subscription(s)`);
    return { sent, failed, pruned };
  }

  private async sendOne(sub: SubscriptionRow, body: string): Promise<'sent' | 'pruned' | 'failed'> {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        PUSH_OPTIONS,
      );
      return 'sent';
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        this.repo.deleteSubscriptionById(sub.id);
        return 'pruned';
      }
      this.log.warn(`push to subscription ${sub.id} failed (status ${status ?? 'n/a'})`);
      return 'failed';
    }
  }
}

export function buildAlertPayload(input: {
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  triggerPrice: number;
  reversionPct: number;
  timestamp: number;
}): PushPayload {
  const bullish = input.direction === 'BULL_REVERSION';
  const pct = Math.round(input.reversionPct * 100);
  return {
    type: 'alert',
    title: `${bullish ? '🟢 Bullish' : '🔴 Bearish'} reversion · ${input.symbol} ${input.timeframe}`,
    body: `Price ${input.triggerPrice} retraced ${pct}% back toward the middle band.`,
    symbol: input.symbol,
    timeframe: input.timeframe,
    direction: input.direction,
    triggerPrice: input.triggerPrice,
    reversionPct: input.reversionPct,
    timestamp: input.timestamp,
  };
}

export function buildTestPayload(timestamp: number): PushPayload {
  return {
    type: 'test',
    title: 'BandAlert test',
    body: 'Push delivery is working.',
    symbol: 'TEST',
    timeframe: 'TEST',
    timestamp,
  };
}
