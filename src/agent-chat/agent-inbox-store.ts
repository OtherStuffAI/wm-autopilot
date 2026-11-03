import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { databaseFile } from '../storage/database-path';

/**
 * Durable strict-inbox state per workspace subscription.
 *
 * `mode = 'inbox_required'` is an explicit opt-in: such a subscription is served ONLY by Tower's agent notification
 * inbox. It never falls back to `/events`, audience registration or broad hydration, including when Tower lacks the
 * capability (it reports `agent_inbox_unsupported` instead).
 */
export type AgentInboxMode = 'legacy' | 'inbox_required';
export type AgentInboxEnvelopeLike = { id: string; seq: number; state: string; kind?: string; source?: { type: string; id: string; channel_id: string | null; thread_id: string | null; task_id: string | null; doc_id: string | null; version?: number | null } };

export interface AgentInboxState {
  subscriptionId: string;
  mode: AgentInboxMode;
  consumerId: string | null;
  towerSubscriptionId: string | null;
  cursor: string | null;
  floorAt: string | null;
  lastOkAt: string | null;
  lastErrorCode: string | null;
  lastErrorClass: string | null;
  lastErrorAt: string | null;
  lastGap: string | null;
  updatedAt: string;
}

export interface AgentInboxLedgerEntry {
  subscriptionId: string;
  notificationId: string;
  seq: number;
  attempts: number;
  outcome: string | null;
  code: string | null;
  startedAt: string | null;
  handledAt: string | null;
  ackedAt: string | null;
}

export class AgentInboxStore {
  private readonly db: Database;

  private schemaReady = false;

  /**
   * Opening never writes: the schema is created on the first WRITE (an explicit operator opt-in or inbox handling).
   * Reads against a database without the tables simply report legacy mode, so ordinary runtimes and test runs that
   * share the instance database never alter it.
   */
  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath, { create: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  /** Read-only existence check (never migrates; migrations run only on the write path). */
  private hasSchema(): boolean {
    if (this.schemaReady) return true;
    return Boolean(this.db.query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'agent_inbox_state'").get());
  }

  private ensureSchema() {
    if (this.schemaReady) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_inbox_state (
        subscription_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'legacy' CHECK (mode IN ('legacy', 'inbox_required')),
        consumer_id TEXT,
        tower_subscription_id TEXT,
        cursor TEXT,
        floor_at TEXT,
        last_ok_at TEXT,
        last_error_code TEXT,
        last_error_class TEXT,
        last_error_at TEXT,
        last_gap TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_inbox_ledger (
        subscription_id TEXT NOT NULL,
        notification_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        outcome TEXT,
        code TEXT,
        started_at TEXT,
        handled_at TEXT,
        acked_at TEXT,
        envelope_json TEXT,
        source_channel_id TEXT,
        source_thread_id TEXT,
        source_task_id TEXT,
        source_doc_id TEXT,
        PRIMARY KEY (subscription_id, notification_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_inbox_ledger_binding ON agent_inbox_ledger (subscription_id, seq);
    `);
    const columns = new Set((this.db.query('PRAGMA table_info(agent_inbox_ledger)').all() as Array<{ name: string }>).map((c) => c.name));
    for (const column of ['envelope_json', 'source_channel_id', 'source_thread_id', 'source_task_id', 'source_doc_id']) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE agent_inbox_ledger ADD COLUMN ${column} TEXT`);
    }
    this.schemaReady = true;
  }

  get(subscriptionId: string): AgentInboxState | null {
    if (!this.hasSchema()) return null;
    const row = this.db.query('SELECT * FROM agent_inbox_state WHERE subscription_id = ?1').get(subscriptionId) as Record<string, any> | null;
    return row ? {
      subscriptionId: row.subscription_id, mode: row.mode, consumerId: row.consumer_id, towerSubscriptionId: row.tower_subscription_id,
      cursor: row.cursor, floorAt: row.floor_at, lastOkAt: row.last_ok_at, lastErrorCode: row.last_error_code, lastErrorClass: row.last_error_class,
      lastErrorAt: row.last_error_at, lastGap: row.last_gap, updatedAt: row.updated_at,
    } : null;
  }

  isInboxRequired(subscriptionId: string): boolean {
    return this.get(subscriptionId)?.mode === 'inbox_required';
  }

  /** Explicit opt-in/out. Opting out keeps the durable cursor so a later opt-in resumes without replay. */
  setMode(subscriptionId: string, mode: AgentInboxMode, consumerId: string): AgentInboxState {
    this.ensureSchema();
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO agent_inbox_state (subscription_id, mode, consumer_id, updated_at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (subscription_id) DO UPDATE SET mode = excluded.mode, consumer_id = COALESCE(agent_inbox_state.consumer_id, excluded.consumer_id), updated_at = excluded.updated_at
    `).run(subscriptionId, mode, consumerId, now);
    return this.get(subscriptionId)!;
  }

  update(subscriptionId: string, patch: Partial<Omit<AgentInboxState, 'subscriptionId' | 'updatedAt' | 'mode'>>): AgentInboxState | null {
    const columns: Record<string, string> = {
      consumerId: 'consumer_id', towerSubscriptionId: 'tower_subscription_id', cursor: 'cursor', floorAt: 'floor_at', lastOkAt: 'last_ok_at',
      lastErrorCode: 'last_error_code', lastErrorClass: 'last_error_class', lastErrorAt: 'last_error_at', lastGap: 'last_gap',
    };
    const entries = Object.entries(patch).filter(([key]) => key in columns);
    if (!entries.length) return this.get(subscriptionId);
    this.ensureSchema();
    const sets = entries.map(([key], index) => `${columns[key]} = ?${index + 2}`).join(', ');
    this.db.query(`UPDATE agent_inbox_state SET ${sets}, updated_at = ?${entries.length + 2} WHERE subscription_id = ?1`)
      .run(subscriptionId, ...entries.map(([, value]) => (value ?? null) as any), new Date().toISOString());
    return this.get(subscriptionId);
  }

  ledger(subscriptionId: string, notificationId: string): AgentInboxLedgerEntry | null {
    if (!this.hasSchema()) return null;
    const row = this.db.query('SELECT * FROM agent_inbox_ledger WHERE subscription_id = ?1 AND notification_id = ?2').get(subscriptionId, notificationId) as Record<string, any> | null;
    return row ? {
      subscriptionId: row.subscription_id, notificationId: row.notification_id, seq: row.seq, attempts: row.attempts, outcome: row.outcome,
      code: row.code, startedAt: row.started_at, handledAt: row.handled_at, ackedAt: row.acked_at,
    } : null;
  }

  /** Records an attempt BEFORE dispatch, so attempts survive crashes and bound poison retries. */
  beginAttempt(subscriptionId: string, notificationId: string, seq: number, envelope?: AgentInboxEnvelopeLike): AgentInboxLedgerEntry {
    this.ensureSchema();
    const source = envelope?.source;
    this.db.query(`
      INSERT INTO agent_inbox_ledger (subscription_id, notification_id, seq, attempts, started_at, envelope_json, source_channel_id, source_thread_id, source_task_id, source_doc_id)
      VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT (subscription_id, notification_id) DO UPDATE SET attempts = agent_inbox_ledger.attempts + 1,
        started_at = COALESCE(agent_inbox_ledger.started_at, excluded.started_at),
        envelope_json = COALESCE(excluded.envelope_json, agent_inbox_ledger.envelope_json)
    `).run(subscriptionId, notificationId, seq, new Date().toISOString(), envelope ? JSON.stringify(envelope) : null,
      source?.channel_id ?? null, source?.thread_id ?? null, source?.task_id ?? null, source?.doc_id ?? null);
    return this.ledger(subscriptionId, notificationId)!;
  }

  /**
   * The newest notification this subscription handled for a bound location (thread, task or document). Agent session
   * tools read only through that notification's recipient-bound context.
   */
  latestBound(subscriptionId: string, where: { channelId?: string | null; threadId?: string | null; taskId?: string | null; docId?: string | null }): AgentInboxEnvelopeLike | null {
    if (!this.hasSchema()) return null;
    const clauses: string[] = [];
    const args: Array<string | null> = [subscriptionId];
    const add = (sql: string, value: string | null | undefined) => { if (value) { args.push(value); clauses.push(sql.replace('?', `?${args.length}`)); } };
    add('source_task_id = ?', where.taskId);
    add('source_doc_id = ?', where.docId);
    if (where.threadId) add('source_thread_id = ?', where.threadId);
    else if (where.channelId && !where.taskId && !where.docId) { add('source_channel_id = ?', where.channelId); clauses.push('source_thread_id IS NULL'); }
    if (!clauses.length) return null;
    if (!this.schemaReady) {
      const columns = new Set((this.db.query('PRAGMA table_info(agent_inbox_ledger)').all() as Array<{ name: string }>).map((c) => c.name));
      if (!columns.has('envelope_json')) return null;
    }
    const row = this.db.query(`SELECT envelope_json FROM agent_inbox_ledger WHERE subscription_id = ?1 AND envelope_json IS NOT NULL AND ${clauses.join(' AND ')}
      ORDER BY seq DESC LIMIT 1`).get(...args) as { envelope_json: string } | null;
    return row ? JSON.parse(row.envelope_json) as AgentInboxEnvelopeLike : null;
  }

  /** The recorded envelope and handling state of one exact notification (origin liveness checks). */
  bindingRecord(subscriptionId: string, notificationId: string): { envelope: AgentInboxEnvelopeLike; outcome: string | null; handledAt: string | null } | null {
    if (!this.hasSchema()) return null;
    const row = this.db.query('SELECT envelope_json, outcome, handled_at FROM agent_inbox_ledger WHERE subscription_id = ?1 AND notification_id = ?2 AND envelope_json IS NOT NULL')
      .get(subscriptionId, notificationId) as { envelope_json: string; outcome: string | null; handled_at: string | null } | null;
    return row ? { envelope: JSON.parse(row.envelope_json) as AgentInboxEnvelopeLike, outcome: row.outcome, handledAt: row.handled_at } : null;
  }

  /** True when this subscription handled any notification sourced in the channel (documents/files created there). */
  boundInChannel(subscriptionId: string, channelId: string): boolean {
    if (!this.hasSchema() || !channelId) return false;
    return Boolean(this.db.query('SELECT 1 AS ok FROM agent_inbox_ledger WHERE subscription_id = ?1 AND source_channel_id = ?2 AND envelope_json IS NOT NULL LIMIT 1')
      .get(subscriptionId, channelId));
  }

  /** The handled outcome is durable before the ack, so a crash between them never re-executes the work. */
  markHandled(subscriptionId: string, notificationId: string, seq: number, outcome: string, code: string | null) {
    this.ensureSchema();
    this.db.query(`
      INSERT INTO agent_inbox_ledger (subscription_id, notification_id, seq, attempts, outcome, code, handled_at) VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6)
      ON CONFLICT (subscription_id, notification_id) DO UPDATE SET outcome = excluded.outcome, code = excluded.code, handled_at = excluded.handled_at
    `).run(subscriptionId, notificationId, seq, outcome, code, new Date().toISOString());
  }

  markAcked(subscriptionId: string, notificationId: string) {
    this.ensureSchema();
    this.db.query('UPDATE agent_inbox_ledger SET acked_at = ?3 WHERE subscription_id = ?1 AND notification_id = ?2')
      .run(subscriptionId, notificationId, new Date().toISOString());
  }

  pruneAcked(olderThanIso: string) {
    if (!this.hasSchema()) return;
    this.db.query('DELETE FROM agent_inbox_ledger WHERE acked_at IS NOT NULL AND acked_at < ?1').run(olderThanIso);
  }
}

let shared: AgentInboxStore | null = null;
export function agentInboxStore(): AgentInboxStore {
  shared ??= new AgentInboxStore();
  return shared;
}
