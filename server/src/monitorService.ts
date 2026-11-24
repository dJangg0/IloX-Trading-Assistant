import { randomUUID } from 'node:crypto';
import { CandleManager } from './candleManager.js';
import {
  computeBands,
  computeTriggers,
  evaluateTick,
  isFlatMarket,
  isValidReversionPct,
  retracementFraction,
  DEFAULT_REVERSION_PCT,
  type Bands,
  type Direction,
  type FsmState,
} from './bollingerEngine.js';
import { badRequest, conflict, notFound } from './errors.js';
import type { InsertAlert, RuleRow, Repo } from './db.js';
import { buildAlertPayload, type PushService } from './pushService.js';
import { TIMEFRAMES, type Candle, type IMarketFeedAdapter, type MarketTick, type Timeframe } from './types/market.js';

export const FEED_STALE_MS = 15_000;
export const WARMUP_MIN_CANDLES = 25;
const WARMUP_RETRY_MS = 5_000;
const BB_PERIOD_DEFAULT = 20;
const BB_STD_DEV_DEFAULT = 2;
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{0,19}$/;

export type FeedStatus = 'LIVE' | 'STALE';

export function computeFeedStatus(lastTickAtMs: number | undefined, nowMs: number): FeedStatus {
  if (lastTickAtMs === undefined) return 'STALE';
  return nowMs - lastTickAtMs < FEED_STALE_MS ? 'LIVE' : 'STALE';
}

export interface MonitorView {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  isActive: boolean;
  reversionPct: number;
  fsmState: FsmState;
  lastArmedPrice: number | null;
  lastTriggeredAt: string | null;
  ready: boolean;
  price: number | null;
  upper: number | null;
  middle: number | null;
  lower: number | null;
  tBull: number | null;
  tBear: number | null;
  feedStatus: FeedStatus;
}

export interface LiveTail {
  closed: Candle[];
  active: Candle | null;
  price: number | null;
  feedStatus: FeedStatus;
  monitor: MonitorView | null;
}

export interface AlertView {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  reversionPct: number;
  triggerPrice: number;
  upper: number;
  middle: number;
  lower: number;
  /** Share of the band-touch → median move completed when the alert fired. */
  retracedPct: number | null;
  createdAt: string;
}

interface RuleRuntime {
  rule: RuleRow;
  candles: CandleManager;
  /** Evaluation is paused until history has been fetched (startup, rule activation, reconnect). */
  warmedUp: boolean;
  lastPrice: number | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

export interface MonitorServiceDeps {
  repo: Repo;
  adapter: IMarketFeedAdapter;
  push: PushService;
  now?: () => number;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
  warmupRetryMs?: number;
}

/**
 * Orchestrates the live path: feed tick → candle buffer → Bollinger/FSM → atomic DB write → push.
 * Ticks are processed synchronously, so there is no interleaving between evaluation and persistence.
 */
export class MonitorService {
  private readonly runtimes = new Map<string, RuleRuntime>();
  private readonly lastTickAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly retryMs: number;
  private readonly startedAtMs: number;
  private stopped = false;

  constructor(private readonly deps: MonitorServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? console;
    this.retryMs = deps.warmupRetryMs ?? WARMUP_RETRY_MS;
    this.startedAtMs = this.now();
  }

  /** Loads persisted rules, subscribes to the feed and warms up history. Warm-up never blocks startup. */
  async start(): Promise<void> {
    for (const rule of this.deps.repo.listRules()) {
      this.runtimes.set(rule.id, this.createRuntime(rule));
    }

    this.deps.adapter.onReconnect?.(() => this.resyncAll());
    await this.deps.adapter.subscribe(this.activeSymbols(), (tick) => this.handleTick(tick));

    for (const rt of this.runtimes.values()) {
      if (rt.rule.isActive) void this.warmUp(rt);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const rt of this.runtimes.values()) {
      if (rt.retryTimer) clearTimeout(rt.retryTimer);
    }
    await this.deps.adapter.disconnect();
  }

  // ---------------------------------------------------------------------------
  // Feed path
  // ---------------------------------------------------------------------------

  handleTick(tick: MarketTick): void {
    this.lastTickAt.set(tick.symbol, this.now());
    for (const rt of this.runtimes.values()) {
      if (rt.rule.symbol === tick.symbol && rt.rule.isActive) this.processTick(rt, tick);
    }
  }

  private processTick(rt: RuleRuntime, tick: MarketTick): void {
    rt.candles.ingest(tick);
    rt.lastPrice = tick.price;

    if (!rt.warmedUp || rt.candles.closedCount() < rt.candles.capacity) return;

    // Window = 19 closed candles + the live price as C_t (handoff §3.1).
    const window = [...rt.candles.closedCloses(), tick.price];
    const bands = computeBands(window, rt.rule.bbStdDev);
    const result = evaluateTick({
      state: rt.rule.fsmState,
      lastArmedPrice: rt.rule.lastArmedPrice,
      price: tick.price,
      bands,
      reversionPct: rt.rule.reversionPct,
    });

    if (result.halted) return;
    if (result.nextState === rt.rule.fsmState && result.fired.length === 0) return;

    this.commitTransition(rt, result.nextState, result.lastArmedPrice, result.fired, bands, tick.price);
  }

  /**
   * §5.3: rule update and alert insert commit in one synchronous transaction, and only then is the
   * push handed to the async dispatcher. A restart therefore cannot re-send an alert that was committed.
   */
  private commitTransition(
    rt: RuleRuntime,
    nextState: FsmState,
    lastArmedPrice: number | null,
    fired: Direction[],
    bands: Bands,
    price: number,
  ): void {
    const { rule } = rt;
    const nowMs = this.now();
    const triggeredAt = fired.length > 0 ? new Date(nowMs).toISOString() : null;

    const alerts: InsertAlert[] = fired.map((direction) => ({
      id: randomUUID(),
      ruleId: rule.id,
      symbol: rule.symbol,
      timeframe: rule.timeframe,
      direction,
      reversionPct: rule.reversionPct,
      triggerPrice: price,
      upperBand: bands.upper,
      middleBand: bands.middle,
      lowerBand: bands.lower,
    }));

    const repo = this.deps.repo;
    repo.db.transaction(() => {
      if (triggeredAt) repo.updateFsmTriggered(rule.id, nextState, lastArmedPrice, triggeredAt);
      else repo.updateFsm(rule.id, nextState, lastArmedPrice);
      for (const a of alerts) repo.insertAlert(a);
    })();

    rt.rule = {
      ...rule,
      fsmState: nextState,
      lastArmedPrice,
      lastTriggeredAt: triggeredAt ?? rule.lastTriggeredAt,
    };

    for (const a of alerts) {
      this.log.info(
        `[alert] ${a.direction} ${a.symbol} ${a.timeframe} @ ${price} (r=${rule.reversionPct})`,
      );
      const payload = buildAlertPayload({
        symbol: a.symbol,
        timeframe: a.timeframe,
        direction: a.direction,
        triggerPrice: price,
        reversionPct: a.reversionPct,
        timestamp: nowMs,
      });
      this.deps.push.dispatch(payload).catch((err) => this.log.error('alert dispatch failed', err));
    }
  }

  // ---------------------------------------------------------------------------
  // History warm-up & reconnect re-sync (handoff §4.1)
  // ---------------------------------------------------------------------------

  private async warmUp(rt: RuleRuntime): Promise<void> {
    if (this.stopped) return;
    const { symbol, timeframe } = rt.rule;
    const limit = Math.max(WARMUP_MIN_CANDLES, rt.rule.bbPeriod + 5);
    try {
      const candles = await this.deps.adapter.fetchHistoricalCandles(symbol, timeframe, limit);
      if (this.stopped || this.runtimes.get(rt.rule.id) !== rt) return;
      rt.candles.setHistory(candles);
      rt.warmedUp = true;
      if (rt.retryTimer) {
        clearTimeout(rt.retryTimer);
        rt.retryTimer = null;
      }
      this.log.info(`[warmup] ${symbol} ${timeframe}: ${rt.candles.closedCount()} closed candles loaded`);
    } catch (err) {
      this.log.warn(`[warmup] ${symbol} ${timeframe} failed, retrying in ${this.retryMs}ms`, err);
      if (this.stopped || this.runtimes.get(rt.rule.id) !== rt) return;
      rt.retryTimer = setTimeout(() => void this.warmUp(rt), this.retryMs);
    }
  }

  private async resyncAll(): Promise<void> {
    this.log.info('[feed] reconnected, re-syncing candle history');
    const tasks: Promise<void>[] = [];
    for (const rt of this.runtimes.values()) {
      if (!rt.rule.isActive) continue;
      rt.warmedUp = false;
      tasks.push(this.warmUp(rt));
    }
    await Promise.all(tasks);
  }

  // ---------------------------------------------------------------------------
  // Rule management (called from REST handlers)
  // ---------------------------------------------------------------------------

  createRule(input: { symbol: string; timeframe: Timeframe; reversionPct?: number }): MonitorView {
    const symbol = normalizeSymbol(input.symbol);
    if (!TIMEFRAMES.includes(input.timeframe)) {
      throw badRequest(`timeframe must be one of ${TIMEFRAMES.join(', ')}`);
    }
    const reversionPct = input.reversionPct ?? DEFAULT_REVERSION_PCT;
    if (!isValidReversionPct(reversionPct)) {
      throw badRequest('reversionPct must be between 0.10 and 1.00');
    }
    if (this.findRuntime(symbol, input.timeframe)) {
      throw conflict(`a monitor for ${symbol} ${input.timeframe} already exists`);
    }

    const id = randomUUID();
    this.deps.repo.insertRule({
      id,
      symbol,
      timeframe: input.timeframe,
      bbPeriod: BB_PERIOD_DEFAULT,
      bbStdDev: BB_STD_DEV_DEFAULT,
      reversionPct,
    });
    const rule = this.deps.repo.getRule(id);
    if (!rule) throw new Error('rule vanished after insert');

    const rt = this.createRuntime(rule);
    this.runtimes.set(id, rt);
    void this.syncSubscriptions();
    void this.warmUp(rt);
    return this.view(rt);
  }

  updateRule(id: string, patch: { reversionPct?: number; isActive?: boolean }): MonitorView {
    const rt = this.requireRuntime(id);

    if (patch.reversionPct !== undefined) {
      if (!isValidReversionPct(patch.reversionPct)) {
        throw badRequest('reversionPct must be between 0.10 and 1.00');
      }
      // Guardrail C: persisted immediately; the next tick evaluates against the new threshold.
      this.deps.repo.updateReversion(id, patch.reversionPct);
      rt.rule = { ...rt.rule, reversionPct: patch.reversionPct };
    }

    if (patch.isActive !== undefined && patch.isActive !== rt.rule.isActive) {
      this.deps.repo.updateActive(id, patch.isActive);
      rt.rule = { ...rt.rule, isActive: patch.isActive };
      if (patch.isActive) {
        rt.candles = newBuffer(rt.rule);
        rt.lastPrice = null;
        rt.warmedUp = false;
        void this.warmUp(rt);
      } else {
        // Paused rules restart from NEUTRAL on resume, so a stale armed state can never fire late.
        this.deps.repo.resetFsm(id);
        rt.rule = { ...rt.rule, fsmState: 'NEUTRAL', lastArmedPrice: null };
        if (rt.retryTimer) {
          clearTimeout(rt.retryTimer);
          rt.retryTimer = null;
        }
      }
      void this.syncSubscriptions();
    }

    return this.view(rt);
  }

  deleteRule(id: string): void {
    const rt = this.requireRuntime(id);
    this.deps.repo.deleteRule(id);
    if (rt.retryTimer) clearTimeout(rt.retryTimer);
    this.runtimes.delete(id);
    void this.syncSubscriptions();
  }

  /** Debug/QA: injects a synthetic price into one rule's engine (handoff §6.1). Does not mark the feed LIVE. */
  simulatePrice(input: { symbol: string; timeframe: Timeframe; price: number }): MonitorView {
    const symbol = normalizeSymbol(input.symbol);
    const rt = this.findRuntime(symbol, input.timeframe);
    if (!rt) throw notFound(`monitor ${symbol} ${input.timeframe}`);
    if (!rt.rule.isActive) throw conflict('monitor is paused');
    if (!Number.isFinite(input.price) || input.price <= 0) throw badRequest('price must be a positive number');

    this.processTick(rt, { symbol, price: input.price, timestampMs: this.now() });
    return this.view(rt);
  }

  // ---------------------------------------------------------------------------
  // Read models
  // ---------------------------------------------------------------------------

  listMonitors(): MonitorView[] {
    return [...this.runtimes.values()].map((rt) => this.view(rt));
  }

  listAlerts(limit: number): AlertView[] {
    return this.deps.repo.listAlerts(limit).map((a) => ({
      id: a.id,
      symbol: a.symbol,
      timeframe: a.timeframe,
      direction: a.direction,
      reversionPct: a.reversionPct,
      triggerPrice: a.triggerPrice,
      upper: a.upperBand,
      middle: a.middleBand,
      lower: a.lowerBand,
      retracedPct: retracementFraction(a.direction, a.triggerPrice, {
        upper: a.upperBand,
        middle: a.middleBand,
        lower: a.lowerBand,
      }),
      createdAt: a.createdAt,
    }));
  }

  /**
   * Live tail for one (symbol, timeframe), used by the chart. Only pairs that have a monitor build candles
   * from ticks, so other pairs return an empty tail and rely on vendor history.
   */
  liveFor(symbol: string, timeframe: Timeframe): LiveTail {
    const rt = this.findRuntime(symbol, timeframe);
    return {
      closed: rt ? rt.candles.closedCandles() : [],
      active: rt?.candles.activeCandle() ?? null,
      price: rt?.lastPrice ?? null,
      feedStatus: computeFeedStatus(this.lastTickAt.get(symbol), this.now()),
      monitor: rt ? this.view(rt) : null,
    };
  }

  health(): { status: 'ok'; activeSubscriptions: number; uptimeSec: number } {
    return {
      status: 'ok',
      activeSubscriptions: this.activeSymbols().length,
      uptimeSec: Math.floor((this.now() - this.startedAtMs) / 1000),
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private createRuntime(rule: RuleRow): RuleRuntime {
    return { rule, candles: newBuffer(rule), warmedUp: false, lastPrice: null, retryTimer: null };
  }

  private findRuntime(symbol: string, timeframe: Timeframe): RuleRuntime | undefined {
    for (const rt of this.runtimes.values()) {
      if (rt.rule.symbol === symbol && rt.rule.timeframe === timeframe) return rt;
    }
    return undefined;
  }

  private requireRuntime(id: string): RuleRuntime {
    const rt = this.runtimes.get(id);
    if (!rt) throw notFound('monitor');
    return rt;
  }

  private activeSymbols(): string[] {
    const set = new Set<string>();
    for (const rt of this.runtimes.values()) if (rt.rule.isActive) set.add(rt.rule.symbol);
    return [...set];
  }

  private async syncSubscriptions(): Promise<void> {
    try {
      await this.deps.adapter.updateSubscriptions(this.activeSymbols());
    } catch (err) {
      this.log.error('feed subscription update failed', err);
    }
  }

  private view(rt: RuleRuntime): MonitorView {
    const { rule } = rt;
    const price = rt.lastPrice;
    const ready = rt.warmedUp && rt.candles.closedCount() >= rt.candles.capacity && price !== null;

    let bands: Bands | null = null;
    let tBull: number | null = null;
    let tBear: number | null = null;
    if (ready && price !== null) {
      bands = computeBands([...rt.candles.closedCloses(), price], rule.bbStdDev);
      if (!isFlatMarket(bands)) {
        const t = computeTriggers(bands, rule.reversionPct);
        tBull = t.tBull;
        tBear = t.tBear;
      }
    }

    return {
      id: rule.id,
      symbol: rule.symbol,
      timeframe: rule.timeframe,
      isActive: rule.isActive,
      reversionPct: rule.reversionPct,
      fsmState: rule.fsmState,
      lastArmedPrice: rule.lastArmedPrice,
      lastTriggeredAt: rule.lastTriggeredAt,
      ready,
      price,
      upper: bands?.upper ?? null,
      middle: bands?.middle ?? null,
      lower: bands?.lower ?? null,
      tBull,
      tBear,
      feedStatus: computeFeedStatus(this.lastTickAt.get(rule.symbol), this.now()),
    };
  }
}

function newBuffer(rule: RuleRow): CandleManager {
  // The window is bbPeriod − 1 closed candles plus the live price (handoff §3.1).
  return new CandleManager(rule.symbol, rule.timeframe, rule.bbPeriod - 1);
}

export function normalizeSymbol(raw: string): string {
  const symbol = String(raw ?? '').trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) {
    throw badRequest('symbol must be 1–20 chars: A–Z, 0–9, and . _ / -');
  }
  return symbol;
}
