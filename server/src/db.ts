import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Direction, FsmState } from './bollingerEngine.js';
import type { Timeframe } from './types/market.js';

export type Db = Database.Database;

export interface RuleRow {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  bbPeriod: number;
  bbStdDev: number;
  reversionPct: number;
  fsmState: FsmState;
  lastArmedPrice: number | null;
  lastTriggeredAt: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: string;
}

export interface AlertRow {
  id: string;
  ruleId: string;
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  reversionPct: number;
  triggerPrice: number;
  upperBand: number;
  middleBand: number;
  lowerBand: number;
  createdAt: string;
}

export interface InsertAlert {
  id: string;
  ruleId: string;
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  reversionPct: number;
  triggerPrice: number;
  upperBand: number;
  middleBand: number;
  lowerBand: number;
}

interface RawRule {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  bb_period: number;
  bb_std_dev: number;
  reversion_pct: number;
  fsm_state: FsmState;
  last_armed_price: number | null;
  last_triggered_at: string | null;
  is_active: number;
  created_at: string;
}

interface RawSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
}

interface RawAlert {
  id: string;
  rule_id: string;
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  reversion_pct: number;
  trigger_price: number;
  upper_band: number;
  middle_band: number;
  lower_band: number;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS monitor_rules (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    bb_period INTEGER NOT NULL DEFAULT 20,
    bb_std_dev REAL NOT NULL DEFAULT 2.0,
    reversion_pct REAL NOT NULL DEFAULT 0.85 CHECK (reversion_pct >= 0.10 AND reversion_pct <= 1.00),
    fsm_state TEXT NOT NULL DEFAULT 'NEUTRAL' CHECK (fsm_state IN ('NEUTRAL', 'ARMED_LOWER', 'ARMED_UPPER')),
    last_armed_price REAL,
    last_triggered_at DATETIME,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(symbol, timeframe)
);

CREATE TABLE IF NOT EXISTS alert_history (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('BULL_REVERSION', 'BEAR_REVERSION')),
    reversion_pct REAL NOT NULL,
    trigger_price REAL NOT NULL,
    upper_band REAL NOT NULL,
    middle_band REAL NOT NULL,
    lower_band REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(rule_id) REFERENCES monitor_rules(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alert_history_created_at ON alert_history(created_at DESC);
`;

/** Opens (or creates) the SQLite file with the handoff §5.1 pragmas and applies the schema. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

function toRule(r: RawRule): RuleRow {
  return {
    id: r.id,
    symbol: r.symbol,
    timeframe: r.timeframe,
    bbPeriod: r.bb_period,
    bbStdDev: r.bb_std_dev,
    reversionPct: r.reversion_pct,
    fsmState: r.fsm_state,
    lastArmedPrice: r.last_armed_price,
    lastTriggeredAt: r.last_triggered_at,
    isActive: r.is_active === 1,
    createdAt: r.created_at,
  };
}

function toSubscription(r: RawSubscription): SubscriptionRow {
  return {
    id: r.id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    userAgent: r.user_agent,
    createdAt: r.created_at,
  };
}

function toAlert(r: RawAlert): AlertRow {
  return {
    id: r.id,
    ruleId: r.rule_id,
    symbol: r.symbol,
    timeframe: r.timeframe,
    direction: r.direction,
    reversionPct: r.reversion_pct,
    triggerPrice: r.trigger_price,
    upperBand: r.upper_band,
    middleBand: r.middle_band,
    lowerBand: r.lower_band,
    createdAt: r.created_at,
  };
}

export class Repo {
  private readonly stmts;

  constructor(readonly db: Db) {
    this.stmts = {
      listRules: db.prepare<[], RawRule>('SELECT * FROM monitor_rules ORDER BY created_at, id'),
      getRule: db.prepare<[string], RawRule>('SELECT * FROM monitor_rules WHERE id = ?'),
      insertRule: db.prepare<[string, string, Timeframe, number, number, number]>(
        `INSERT INTO monitor_rules (id, symbol, timeframe, bb_period, bb_std_dev, reversion_pct)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      updateReversion: db.prepare<[number, string]>('UPDATE monitor_rules SET reversion_pct = ? WHERE id = ?'),
      updateActive: db.prepare<[number, string]>('UPDATE monitor_rules SET is_active = ? WHERE id = ?'),
      updateFsm: db.prepare<[FsmState, number | null, string]>(
        'UPDATE monitor_rules SET fsm_state = ?, last_armed_price = ? WHERE id = ?',
      ),
      updateFsmTriggered: db.prepare<[FsmState, number | null, string, string]>(
        'UPDATE monitor_rules SET fsm_state = ?, last_armed_price = ?, last_triggered_at = ? WHERE id = ?',
      ),
      resetFsm: db.prepare<[string]>(
        "UPDATE monitor_rules SET fsm_state = 'NEUTRAL', last_armed_price = NULL WHERE id = ?",
      ),
      deleteRule: db.prepare<[string]>('DELETE FROM monitor_rules WHERE id = ?'),

      insertAlert: db.prepare<
        [string, string, string, Timeframe, Direction, number, number, number, number, number]
      >(
        `INSERT INTO alert_history
           (id, rule_id, symbol, timeframe, direction, reversion_pct, trigger_price, upper_band, middle_band, lower_band)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      listAlerts: db.prepare<[number], RawAlert>('SELECT * FROM alert_history ORDER BY created_at DESC, rowid DESC LIMIT ?'),
      listAlertsFor: db.prepare<[string, string, number], RawAlert>(
        'SELECT * FROM alert_history WHERE symbol = ? AND timeframe = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      ),

      upsertSubscription: db.prepare<[string, string, string, string, string | null]>(
        `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           user_agent = excluded.user_agent`,
      ),
      listSubscriptions: db.prepare<[], RawSubscription>('SELECT * FROM push_subscriptions'),
      countSubscriptions: db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions'),
      deleteSubscriptionByEndpoint: db.prepare<[string]>('DELETE FROM push_subscriptions WHERE endpoint = ?'),
      deleteSubscriptionById: db.prepare<[string]>('DELETE FROM push_subscriptions WHERE id = ?'),
    };
  }

  listRules(): RuleRow[] {
    return this.stmts.listRules.all().map(toRule);
  }

  getRule(id: string): RuleRow | undefined {
    const row = this.stmts.getRule.get(id);
    return row ? toRule(row) : undefined;
  }

  insertRule(input: { id: string; symbol: string; timeframe: Timeframe; bbPeriod: number; bbStdDev: number; reversionPct: number }): void {
    this.stmts.insertRule.run(input.id, input.symbol, input.timeframe, input.bbPeriod, input.bbStdDev, input.reversionPct);
  }

  updateReversion(id: string, reversionPct: number): void {
    this.stmts.updateReversion.run(reversionPct, id);
  }

  updateActive(id: string, isActive: boolean): void {
    this.stmts.updateActive.run(isActive ? 1 : 0, id);
  }

  updateFsm(id: string, state: FsmState, lastArmedPrice: number | null): void {
    this.stmts.updateFsm.run(state, lastArmedPrice, id);
  }

  updateFsmTriggered(id: string, state: FsmState, lastArmedPrice: number | null, triggeredAt: string): void {
    this.stmts.updateFsmTriggered.run(state, lastArmedPrice, triggeredAt, id);
  }

  resetFsm(id: string): void {
    this.stmts.resetFsm.run(id);
  }

  deleteRule(id: string): void {
    this.stmts.deleteRule.run(id);
  }

  insertAlert(a: InsertAlert): void {
    this.stmts.insertAlert.run(
      a.id,
      a.ruleId,
      a.symbol,
      a.timeframe,
      a.direction,
      a.reversionPct,
      a.triggerPrice,
      a.upperBand,
      a.middleBand,
      a.lowerBand,
    );
  }

  listAlerts(limit: number): AlertRow[] {
    return this.stmts.listAlerts.all(limit).map(toAlert);
  }

  listAlertsFor(symbol: string, timeframe: Timeframe, limit: number): AlertRow[] {
    return this.stmts.listAlertsFor.all(symbol, timeframe, limit).map(toAlert);
  }

  upsertSubscription(input: { id: string; endpoint: string; p256dh: string; auth: string; userAgent: string | null }): void {
    this.stmts.upsertSubscription.run(input.id, input.endpoint, input.p256dh, input.auth, input.userAgent);
  }

  listSubscriptions(): SubscriptionRow[] {
    return this.stmts.listSubscriptions.all().map(toSubscription);
  }

  countSubscriptions(): number {
    return this.stmts.countSubscriptions.get()?.n ?? 0;
  }

  deleteSubscriptionByEndpoint(endpoint: string): number {
    return this.stmts.deleteSubscriptionByEndpoint.run(endpoint).changes;
  }

  deleteSubscriptionById(id: string): void {
    this.stmts.deleteSubscriptionById.run(id);
  }
}
