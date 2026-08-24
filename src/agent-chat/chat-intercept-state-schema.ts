import type { Database } from 'bun:sqlite';

function hasColumn(db: Database, columnName: string): boolean {
  const rows = db.query('PRAGMA table_info(chat_intercept_state)').all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

export function initialiseChatInterceptStateSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_intercept_state (
    routing_key TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '', session_id TEXT,
    session_generation INTEGER NOT NULL DEFAULT 1, previous_session_ids_json TEXT NOT NULL DEFAULT '[]',
    session_class TEXT NOT NULL, workspace_owner_npub TEXT NOT NULL, source_app_npub TEXT NOT NULL,
    tower_service_npub TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL DEFAULT '', channel_id TEXT NOT NULL,
    thread_id TEXT NOT NULL, target_bot_npub TEXT NOT NULL, last_message_id_seen TEXT, last_event_cursor_seen TEXT,
    last_human_message_id_delivered TEXT, last_agent_message_id_published TEXT, last_completed_turn_id TEXT,
    pending_message_count INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, last_decision TEXT NOT NULL DEFAULT 'pending',
    last_activity_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const migrations: Array<[string, string]> = [
    ['pending_message_count', 'INTEGER NOT NULL DEFAULT 0'], ['agent_id', "TEXT NOT NULL DEFAULT ''"],
    ['last_decision', "TEXT NOT NULL DEFAULT 'pending'"], ['session_generation', 'INTEGER NOT NULL DEFAULT 1'],
    ['previous_session_ids_json', "TEXT NOT NULL DEFAULT '[]'"], ['tower_service_npub', "TEXT NOT NULL DEFAULT ''"],
    ['workspace_id', "TEXT NOT NULL DEFAULT ''"], ['last_event_cursor_seen', 'TEXT'],
    ['last_human_message_id_delivered', 'TEXT'], ['last_agent_message_id_published', 'TEXT'], ['last_completed_turn_id', 'TEXT'],
  ];
  for (const [column, definition] of migrations) {
    if (!hasColumn(db, column)) db.exec(`ALTER TABLE chat_intercept_state ADD COLUMN ${column} ${definition}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_intercept_state_subscription ON chat_intercept_state(subscription_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_intercept_state_agent ON chat_intercept_state(agent_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_intercept_state_session ON chat_intercept_state(session_id);
    CREATE TABLE IF NOT EXISTS chat_intercept_message_revisions (
      routing_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      message_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (routing_key, message_id, message_revision)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_intercept_message_revisions_created
      ON chat_intercept_message_revisions(created_at DESC)`);
}
