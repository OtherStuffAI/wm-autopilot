import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { databaseFile } from '../storage/message-store';

export type FlightDeckSessionTurnState = 'accepted' | 'reply_ready' | 'completed' | 'suppressed' | 'failed';

export interface FlightDeckSessionTurnRecord {
  turnId: string;
  sessionId: string;
  prompt: string;
  promptType: string;
  sourceMessageIds: string[];
  triggerMessageId: string | null;
  clientRequestId: string;
  replyBody: string | null;
  finalMessageIdentity: string | null;
  replyCreatedAt: string | null;
  publishedMessageId: string | null;
  state: FlightDeckSessionTurnState;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export class FlightDeckSessionTurnStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS flightdeck_session_turn_publications (
      turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, prompt_type TEXT NOT NULL,
      source_message_ids_json TEXT NOT NULL, client_request_id TEXT NOT NULL UNIQUE, reply_body TEXT,
      trigger_message_id TEXT, final_message_identity TEXT, reply_created_at TEXT, published_message_id TEXT, state TEXT NOT NULL, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_session_turn_final
      ON flightdeck_session_turn_publications(session_id, final_message_identity)
      WHERE final_message_identity IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_fd_session_turn_pending
      ON flightdeck_session_turn_publications(state, session_id, created_at);`);
    const columns = this.db.query('PRAGMA table_info(flightdeck_session_turn_publications)').all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === 'trigger_message_id')) {
      this.db.exec('ALTER TABLE flightdeck_session_turn_publications ADD COLUMN trigger_message_id TEXT');
    }
    if (!columns.some((column) => column.name === 'reply_created_at')) {
      this.db.exec('ALTER TABLE flightdeck_session_turn_publications ADD COLUMN reply_created_at TEXT');
    }
  }

  get(turnId: string): FlightDeckSessionTurnRecord | null {
    const row = this.db.query('SELECT * FROM flightdeck_session_turn_publications WHERE turn_id = ?1').get(turnId);
    return row ? this.map(row as Record<string, unknown>) : null;
  }

  listRecoverable(): FlightDeckSessionTurnRecord[] {
    const rows = this.db.query("SELECT * FROM flightdeck_session_turn_publications WHERE state NOT IN ('completed','suppressed') AND prompt_type != 'direct_chat' ORDER BY session_id, created_at").all();
    return (rows as Record<string, unknown>[]).map((row) => this.map(row));
  }

  save(record: FlightDeckSessionTurnRecord): FlightDeckSessionTurnRecord {
    this.db.query(`INSERT INTO flightdeck_session_turn_publications
      (turn_id, session_id, prompt, prompt_type, source_message_ids_json, client_request_id, reply_body,
       trigger_message_id, final_message_identity, reply_created_at, published_message_id, state, last_error, created_at, updated_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
      ON CONFLICT(turn_id) DO UPDATE SET reply_body=excluded.reply_body,
        trigger_message_id=COALESCE(excluded.trigger_message_id, trigger_message_id),
        final_message_identity=excluded.final_message_identity,
        reply_created_at=COALESCE(reply_created_at, excluded.reply_created_at), published_message_id=excluded.published_message_id,
        state=excluded.state, last_error=excluded.last_error, updated_at=excluded.updated_at`)
      .run(record.turnId, record.sessionId, record.prompt, record.promptType, JSON.stringify(record.sourceMessageIds),
        record.clientRequestId, record.replyBody, record.triggerMessageId, record.finalMessageIdentity, record.replyCreatedAt,
        record.publishedMessageId, record.state, record.lastError, record.createdAt, record.updatedAt);
    return record;
  }

  private map(row: Record<string, unknown>): FlightDeckSessionTurnRecord {
    let sourceMessageIds: string[] = [];
    try { sourceMessageIds = JSON.parse(String(row.source_message_ids_json ?? '[]')); } catch {}
    return { turnId: String(row.turn_id), sessionId: String(row.session_id), prompt: String(row.prompt),
      promptType: String(row.prompt_type), sourceMessageIds, clientRequestId: String(row.client_request_id),
      triggerMessageId: typeof row.trigger_message_id === 'string' ? row.trigger_message_id : null,
      replyBody: typeof row.reply_body === 'string' ? row.reply_body : null,
      finalMessageIdentity: typeof row.final_message_identity === 'string' ? row.final_message_identity : null,
      replyCreatedAt: typeof row.reply_created_at === 'string' ? row.reply_created_at : null,
      publishedMessageId: typeof row.published_message_id === 'string' ? row.published_message_id : null,
      state: String(row.state) as FlightDeckSessionTurnState,
      lastError: typeof row.last_error === 'string' ? row.last_error : null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }
}

export const flightDeckSessionTurnStore = new FlightDeckSessionTurnStore();
