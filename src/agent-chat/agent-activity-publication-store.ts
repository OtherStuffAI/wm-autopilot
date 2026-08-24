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
      PRIMARY KEY(activity_id, event_key),
      UNIQUE(activity_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_activity_publication_sequence
      ON agent_activity_publications(activity_id, sequence DESC);`);
  }

  claim(activityId: string, eventKey: string, sequenceBase: number, at = new Date().toISOString()): AgentActivityPublicationClaim {
    const transaction = this.db.transaction(() => {
      const existing = this.db.query(`SELECT event_key,sequence,status FROM agent_activity_publications
        WHERE activity_id=?1 AND event_key=?2`).get(activityId, eventKey) as Record<string, unknown> | null;
      if (existing && existing.status !== 'failed') {
        return { eventKey, sequence: Number(existing.sequence), duplicate: true, accepted: existing.status === 'accepted' };
      }
      const latest = this.db.query('SELECT MAX(sequence) sequence FROM agent_activity_publications WHERE activity_id=?1')
        .get(activityId) as { sequence?: number | null } | null;
      const sequence = Math.max(sequenceBase, Number(latest?.sequence ?? sequenceBase)) + 1;
      this.db.query(`INSERT INTO agent_activity_publications
        (activity_id,event_key,sequence,status,attempt_count,last_error,created_at,updated_at)
        VALUES (?1,?2,?3,'emitted',1,NULL,?4,?4)
        ON CONFLICT(activity_id,event_key) DO UPDATE SET sequence=excluded.sequence,status='emitted',
          attempt_count=agent_activity_publications.attempt_count+1,last_error=NULL,updated_at=excluded.updated_at`)
        .run(activityId, eventKey, sequence, at);
      return { eventKey, sequence, duplicate: false, accepted: false };
    });
    return transaction.immediate();
  }

  markAccepted(activityId: string, eventKey: string, at = new Date().toISOString()): void {
    this.db.query(`UPDATE agent_activity_publications SET status='accepted',last_error=NULL,updated_at=?3
      WHERE activity_id=?1 AND event_key=?2`).run(activityId, eventKey, at);
  }

  markFailed(activityId: string, eventKey: string, error: string, at = new Date().toISOString()): void {
    this.db.query(`UPDATE agent_activity_publications SET status='failed',last_error=?3,updated_at=?4
      WHERE activity_id=?1 AND event_key=?2`).run(activityId, eventKey, error, at);
  }
}

export const agentActivityPublicationStore = new AgentActivityPublicationStore();
