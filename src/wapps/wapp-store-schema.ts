import { Database } from "bun:sqlite";

function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function ensureWappStoreSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS wapp_records (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      owner_npub TEXT NOT NULL,
      created_by_npub TEXT NOT NULL,
      workspace_owner_npub TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      scope_lineage_json TEXT NOT NULL,
      allowed_npubs_json TEXT NOT NULL,
      launch_url TEXT NOT NULL,
      source_wingman_url TEXT,
      subdomain_alias TEXT,
      record_state TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_published_at TEXT
    )
  `);
  ensureColumn(db, "wapp_records", "status", "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, "wapp_records", "schedule_json", "TEXT");
  ensureColumn(db, "wapp_records", "tower_binding_id", "TEXT");
  ensureColumn(db, "wapp_records", "app_npub", "TEXT");
  ensureColumn(db, "wapp_records", "app_nsec_encrypted", "TEXT");
  ensureColumn(db, "wapp_records", "registered_open_origins_json", "TEXT");
  ensureColumn(db, "wapp_records", "pending_app_npub", "TEXT");
  ensureColumn(db, "wapp_records", "pending_app_nsec_encrypted", "TEXT");
  db.run(`
    CREATE TABLE IF NOT EXISTS wapp_tower_bindings (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      tower_url TEXT NOT NULL,
      workspace_id TEXT,
      workspace_owner_npub TEXT NOT NULL,
      user_alias TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  ensureColumn(db, "wapp_tower_bindings", "workspace_id", "TEXT");
  db.run("CREATE INDEX IF NOT EXISTS idx_wapp_records_app_id ON wapp_records(app_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_wapp_records_owner ON wapp_records(owner_npub)");
  db.run("CREATE INDEX IF NOT EXISTS idx_wapp_records_scope ON wapp_records(workspace_owner_npub, scope_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_wapp_records_tower_binding ON wapp_records(tower_binding_id)");
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_wapp_tower_bindings_default ON wapp_tower_bindings(is_default) WHERE is_default = 1");
}
