import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';

import { databaseFile } from '../storage/message-store';

export interface AgentActivityPublicationClaim {
  eventKey: string;
  sequence: number;
  duplicate: boolean;
  accepted: boolean;
}

export class AgentActivityPublicationStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_activity_publications (
      activity_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(activity_id, event_key),
      UNIQUE(activity_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_activity_publication_sequence
      ON agent_activity_publications(activity_id, sequence DESC);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_activity_commentary_sources (
      activity_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 1,
      generation INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER NOT NULL DEFAULT 0
    )`);
    const sourceColumns = this.db.query('PRAGMA table_info(agent_activity_commentary_sources)').all() as { name: string }[];
    for (const column of ['generation', 'last_attempt_at']) {
      if (!sourceColumns.some((existing) => existing.name === column)) {
        this.db.exec(`ALTER TABLE agent_activity_commentary_sources ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
      }
    }
    const columns = this.db.query('PRAGMA table_info(agent_activity_publications)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'next_attempt_at')) {
      this.db.exec('ALTER TABLE agent_activity_publications ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some((column) => column.name === 'payload_json')) {
      this.db.exec('ALTER TABLE agent_activity_publications ADD COLUMN payload_json TEXT');
    }
  }

  hasPending(activityId: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM agent_activity_publications WHERE activity_id=?1 AND status!='accepted' LIMIT 1")
      .get(activityId));
  }

  migrateLegacyCommentary(activityId: string, eventKey: string, legacyKey: string): void {
    this.db.query(`UPDATE agent_activity_publications SET event_key=?2 WHERE activity_id=?1 AND event_key=?3
      AND NOT EXISTS (SELECT 1 FROM agent_activity_publications WHERE activity_id=?1 AND event_key=?2)`)
      .run(activityId, eventKey, legacyKey);
  }

  contextFor(activityId: string): Record<string, unknown> | null {
    const row = this.db.query('SELECT payload_json FROM agent_activity_publications WHERE activity_id=?1 AND payload_json IS NOT NULL ORDER BY sequence LIMIT 1')
      .get(activityId) as { payload_json: string } | null;
    return row ? JSON.parse(row.payload_json) : null;
  }

  commentarySourceFor(activityId: string): any | null {
    const row = this.db.query('SELECT payload_json FROM agent_activity_commentary_sources WHERE activity_id=?1')
      .get(activityId) as { payload_json: string } | null;
    return row ? JSON.parse(row.payload_json).source : null;
  }

  saveCommentarySource(activityId: string, payload: unknown): number {
    const row = this.db.query(`INSERT INTO agent_activity_commentary_sources(activity_id,payload_json,pending,generation) VALUES (?1,?2,1,1)
      ON CONFLICT(activity_id) DO UPDATE SET payload_json=excluded.payload_json,pending=1,
        generation=agent_activity_commentary_sources.generation+1 RETURNING generation`)
      .get(activityId, JSON.stringify(payload)) as { generation: number };
    return row.generation;
  }

  finishCommentarySource(activityId: string, generation: number): void {
    this.db.query('UPDATE agent_activity_commentary_sources SET pending=0 WHERE activity_id=?1 AND generation=?2').run(activityId, generation);
  }

  touchCommentarySource(activityId: string): void {
    this.db.query('UPDATE agent_activity_commentary_sources SET last_attempt_at=?2 WHERE activity_id=?1').run(activityId, Date.now());
  }

  pendingCommentarySources(limit = 100): { activityId: string; payload: any }[] {
    return (this.db.query('SELECT activity_id,payload_json FROM agent_activity_commentary_sources WHERE pending=1 ORDER BY last_attempt_at LIMIT ?1')
      .all(limit) as { activity_id: string; payload_json: string }[])
      .map((row) => ({ activityId: row.activity_id, payload: JSON.parse(row.payload_json) }));
  }

  savePayload(activityId: string, eventKey: string, payload: unknown): void {
    this.db.query('UPDATE agent_activity_publications SET payload_json=?3 WHERE activity_id=?1 AND event_key=?2')
      .run(activityId, eventKey, JSON.stringify(payload));
  }

  pending(limit = 100): { activityId: string; eventKey: string; sequence: number; payload: Record<string, unknown> }[] {
    return (this.db.query(`SELECT activity_id,event_key,sequence,payload_json FROM agent_activity_publications
      WHERE status != 'accepted' AND payload_json IS NOT NULL AND next_attempt_at<=?2 ORDER BY sequence LIMIT ?1`).all(limit, Date.now()) as any[])
      .map((row) => ({ activityId: row.activity_id, eventKey: row.event_key, sequence: row.sequence,
        payload: JSON.parse(row.payload_json) }));
  }

  claim(activityId: string, eventKey: string, sequenceBase: number, at = new Date().toISOString(), payload?: Record<string, unknown>): AgentActivityPublicationClaim {
    const transaction = this.db.transaction(() => {
      const existing = this.db.query(`SELECT event_key,sequence,status FROM agent_activity_publications
        WHERE activity_id=?1 AND event_key=?2`).get(activityId, eventKey) as Record<string, unknown> | null;
      if (existing && existing.status === 'accepted') {
        return { eventKey, sequence: Number(existing.sequence), duplicate: true, accepted: existing.status === 'accepted' };
      }
      const latest = this.db.query('SELECT MAX(sequence) sequence FROM agent_activity_publications WHERE activity_id=?1')
        .get(activityId) as { sequence?: number | null } | null;
      const sequence = existing ? Number(existing.sequence) : Math.max(sequenceBase, Number(latest?.sequence ?? sequenceBase)) + 1;
      this.db.query(`INSERT INTO agent_activity_publications
        (activity_id,event_key,sequence,status,attempt_count,last_error,created_at,updated_at)
        VALUES (?1,?2,?3,'emitted',1,NULL,?4,?4)
        ON CONFLICT(activity_id,event_key) DO UPDATE SET sequence=excluded.sequence,status='emitted',
          attempt_count=agent_activity_publications.attempt_count+1,last_error=NULL,updated_at=excluded.updated_at`)
        .run(activityId, eventKey, sequence, at);
      if (payload) this.savePayload(activityId, eventKey, { ...payload, sequence });
      return { eventKey, sequence, duplicate: false, accepted: false };
    });
    return transaction.immediate();
  }

  defer(activityId: string, eventKey: string, delayMs = 10_000): void {
    this.db.query('UPDATE agent_activity_publications SET next_attempt_at=?3 WHERE activity_id=?1 AND event_key=?2')
      .run(activityId, eventKey, Date.now() + delayMs);
  }

  deferAfterFailure(activityId: string, eventKey: string, options: {
    baseDelayMs?: number;
    maxDelayMs?: number;
  } = {}): number {
    const row = this.db.query(`UPDATE agent_activity_publications
      SET attempt_count=attempt_count+1,
        next_attempt_at=?3 + MIN(?4 * (1 << MIN(attempt_count, 16)), ?5)
      WHERE activity_id=?1 AND event_key=?2
      RETURNING next_attempt_at`).get(
        activityId,
        eventKey,
        Date.now(),
        options.baseDelayMs ?? 10_000,
        options.maxDelayMs ?? 900_000,
      ) as { next_attempt_at: number } | null;
    return row?.next_attempt_at ?? 0;
  }

  markAccepted(activityId: string, eventKey: string, at = new Date().toISOString()): void {
    this.db.query(`UPDATE agent_activity_publications SET status='accepted',last_error=NULL,updated_at=?3
      WHERE activity_id=?1 AND event_key=?2`).run(activityId, eventKey, at);
  }

  markFailed(activityId: string, eventKey: string, error: string, at = new Date().toISOString()): void {
    this.db.query(`UPDATE agent_activity_publications SET status='failed',last_error=?3,updated_at=?4
      WHERE activity_id=?1 AND event_key=?2 AND status!='accepted'`).run(activityId, eventKey, error, at);
  }
}

export const agentActivityPublicationStore = new AgentActivityPublicationStore();
