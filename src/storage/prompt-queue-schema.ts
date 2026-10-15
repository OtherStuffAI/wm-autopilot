import type { Database } from "bun:sqlite";

export function initialisePromptQueueSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS prompt_queue_recovery (
    session_id TEXT, item_id TEXT, revision TEXT, delivery_id TEXT, actor TEXT, reason TEXT, resolution TEXT, created_at TEXT
  )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_queue (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      queue_order INTEGER NOT NULL,
      type TEXT,
      dedupe_key TEXT,
      payload_json TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_queue_session_order
    ON prompt_queue(session_id, queue_order);
  `);
  const columns = db.query("PRAGMA table_info(prompt_queue)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  for (const [name, definition] of Object.entries({
    revision: "INTEGER NOT NULL DEFAULT 1", state: "TEXT NOT NULL DEFAULT 'pending'",
    handled_at: "TEXT", handled_by: "TEXT", handled_reason: "TEXT", claim_token: "TEXT", delivery_state: "TEXT", delivery_id: "TEXT", delivery_updated_at: "TEXT",
  })) {
    if (!names.has(name)) db.exec(`ALTER TABLE prompt_queue ADD COLUMN ${name} ${definition}`);
  }
  if (!names.has("type")) db.exec("ALTER TABLE prompt_queue ADD COLUMN type TEXT");
  if (!names.has("dedupe_key")) db.exec("ALTER TABLE prompt_queue ADD COLUMN dedupe_key TEXT");
  if (!names.has("payload_json")) db.exec("ALTER TABLE prompt_queue ADD COLUMN payload_json TEXT");
  db.exec("DROP INDEX IF EXISTS idx_prompt_queue_dedupe");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_queue_dedupe
    ON prompt_queue(session_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'claimed')`);
}
