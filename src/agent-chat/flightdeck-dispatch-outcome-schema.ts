import type { Database } from 'bun:sqlite';

const TABLE = 'flightdeck_dispatch_outcomes';

function createTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outcome_key TEXT NOT NULL UNIQUE,
    subscription_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('chat', 'task', 'doc')),
    outcome TEXT NOT NULL CHECK (outcome IN ('queued', 'launched', 'suppressed', 'ignored', 'failed')),
    action TEXT CHECK (action IN ('pipeline', 'session')),
    action_id TEXT,
    record_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    dispatch_action TEXT NOT NULL,
    status TEXT,
    reason_code TEXT,
    reason_label TEXT,
    source_label TEXT,
    details_json TEXT,
    updated_at TEXT NOT NULL
  )`);
}

function addCompatibilityColumns(db: Database): void {
  const columns = new Set((db.query(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!columns.has('reason_code')) db.exec(`ALTER TABLE ${TABLE} ADD COLUMN reason_code TEXT`);
  if (!columns.has('reason_label')) db.exec(`ALTER TABLE ${TABLE} ADD COLUMN reason_label TEXT`);
  if (!columns.has('source_label')) db.exec(`ALTER TABLE ${TABLE} ADD COLUMN source_label TEXT`);
}

function supportsQueuedOutcome(db: Database): boolean {
  const row = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?1").get(TABLE) as { sql?: string } | null;
  return Boolean(row?.sql?.includes("'queued'"));
}

function rebuildWithQueuedOutcome(db: Database): void {
  db.transaction(() => {
    db.exec(`ALTER TABLE ${TABLE} RENAME TO ${TABLE}_legacy`);
    createTable(db);
    db.exec(`INSERT INTO ${TABLE} (
      id, outcome_key, subscription_id, received_at, trigger, outcome, action, action_id,
      record_id, agent_id, dispatch_action, status, reason_code, reason_label, source_label,
      details_json, updated_at
    ) SELECT
      id, outcome_key, subscription_id, received_at, trigger,
      CASE WHEN dispatch_action = 'chat_dispatch_queued' AND action_id IS NULL THEN 'queued' ELSE outcome END,
      action, action_id, record_id, agent_id, dispatch_action, status, reason_code, reason_label,
      source_label, details_json, updated_at
    FROM ${TABLE}_legacy`);
    db.exec(`DROP TABLE ${TABLE}_legacy`);
  })();
}

export function initialiseFlightDeckDispatchOutcomeSchema(db: Database): void {
  createTable(db);
  addCompatibilityColumns(db);
  if (!supportsQueuedOutcome(db)) rebuildWithQueuedOutcome(db);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_flightdeck_dispatch_outcomes_subscription_received
    ON ${TABLE}(subscription_id, received_at DESC, id DESC)`);
  db.exec(`UPDATE ${TABLE}
    SET outcome='queued', reason_code=COALESCE(reason_code, 'session_creation_pending'),
      reason_label=COALESCE(reason_label, 'Waiting for durable session')
    WHERE dispatch_action='chat_dispatch_queued' AND action_id IS NULL AND outcome IN ('queued', 'launched')`);
}
