import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';

import { databaseFile } from '../storage/message-store';

export type AgentWorkBindingType = 'task' | 'flow_run' | 'thread';
export type AgentWorkBindingState = 'active' | 'stale';

export interface AgentWorkSessionBindingRecord {
  subscriptionId: string;
  agentId: string;
  bindingType: AgentWorkBindingType;
  bindingId: string;
  sessionId: string;
  lastRecordIdSeen: string | null;
  state: AgentWorkBindingState;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_DB_PATH = databaseFile;

class AgentWorkSessionBindingStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.initialise();
  }

  getByBinding(
    subscriptionId: string,
    agentId: string,
    bindingType: AgentWorkBindingType,
    bindingId: string,
  ): AgentWorkSessionBindingRecord | null {
    const row = this.db.query(
      `SELECT
         subscription_id AS subscriptionId,
         agent_id AS agentId,
         binding_type AS bindingType,
         binding_id AS bindingId,
         session_id AS sessionId,
         last_record_id_seen AS lastRecordIdSeen,
         state,
         last_activity_at AS lastActivityAt,
         created_at AS createdAt,
         updated_at AS updatedAt
       FROM agent_work_session_bindings
       WHERE subscription_id = ?1
         AND agent_id = ?2
         AND binding_type = ?3
         AND binding_id = ?4
       LIMIT 1`,
    ).get(subscriptionId, agentId, bindingType, bindingId) as AgentWorkSessionBindingRecord | null;
    return row ?? null;
  }

  listBySession(
    subscriptionId: string,
    agentId: string,
    sessionId: string,
  ): AgentWorkSessionBindingRecord[] {
    return this.db.query(
      `SELECT
         subscription_id AS subscriptionId,
         agent_id AS agentId,
         binding_type AS bindingType,
         binding_id AS bindingId,
         session_id AS sessionId,
         last_record_id_seen AS lastRecordIdSeen,
         state,
         last_activity_at AS lastActivityAt,
         created_at AS createdAt,
         updated_at AS updatedAt
       FROM agent_work_session_bindings
       WHERE subscription_id = ?1
         AND agent_id = ?2
         AND session_id = ?3
       ORDER BY binding_type ASC, binding_id ASC`,
    ).all(subscriptionId, agentId, sessionId) as AgentWorkSessionBindingRecord[];
  }

  save(record: AgentWorkSessionBindingRecord): AgentWorkSessionBindingRecord {
    this.db.query(
      `INSERT INTO agent_work_session_bindings (
         subscription_id, agent_id, binding_type, binding_id, session_id,
         last_record_id_seen, state, last_activity_at, created_at, updated_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5,
         ?6, ?7, ?8, ?9, ?10
       )
       ON CONFLICT(subscription_id, agent_id, binding_type, binding_id) DO UPDATE SET
         session_id = excluded.session_id,
         last_record_id_seen = excluded.last_record_id_seen,
         state = excluded.state,
         last_activity_at = excluded.last_activity_at,
         updated_at = excluded.updated_at`,
    ).run(
      record.subscriptionId,
      record.agentId,
      record.bindingType,
      record.bindingId,
      record.sessionId,
      record.lastRecordIdSeen,
      record.state,
      record.lastActivityAt,
      record.createdAt,
      record.updatedAt,
    );
    return this.getByBinding(
      record.subscriptionId,
      record.agentId,
      record.bindingType,
      record.bindingId,
    )!;
  }

  markStaleForSession(sessionId: string): void {
    const now = new Date().toISOString();
    this.db.query(
      `UPDATE agent_work_session_bindings
       SET state = 'stale',
           updated_at = ?2
       WHERE session_id = ?1`,
    ).run(sessionId, now);
  }

  private initialise(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_work_session_bindings (
        subscription_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        binding_type TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_record_id_seen TEXT,
        state TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (subscription_id, agent_id, binding_type, binding_id)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_work_bindings_session
        ON agent_work_session_bindings(session_id, updated_at DESC);
    `);
  }
}

export const agentWorkSessionBindingStore = new AgentWorkSessionBindingStore();
export { AgentWorkSessionBindingStore };
