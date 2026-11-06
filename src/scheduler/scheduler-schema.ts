import type { Database } from "bun:sqlite";

export function initialiseSchedulerSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      user_npub TEXT NOT NULL,
      agent_id TEXT,
      bot_npub TEXT NOT NULL,
      wrapped_key_ciphertext TEXT NOT NULL,
      wrapped_key_nonce TEXT NOT NULL,
      agent TEXT NOT NULL,
      model TEXT,
      working_directory TEXT NOT NULL,
      initial_prompt TEXT NOT NULL,
      nightwatchman_enabled INTEGER NOT NULL DEFAULT 0,
      action_type TEXT NOT NULL DEFAULT 'session',
      pipeline_definition_id TEXT,
      pipeline_input_json TEXT,
      pipeline_agent TEXT,
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_user
      ON scheduled_jobs(user_npub);
    CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_enabled
      ON scheduled_jobs(enabled);

    CREATE TABLE IF NOT EXISTS scheduled_job_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      session_id TEXT,
      pipeline_run_id TEXT,
      started_at TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job
      ON scheduled_job_runs(job_id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_started
      ON scheduled_job_runs(started_at DESC);
  `);

  // Migration: add trigger_type columns for file watcher support
  const migrations = [
    "ALTER TABLE scheduled_jobs ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'cron'",
    "ALTER TABLE scheduled_jobs ADD COLUMN watch_directory TEXT",
    "ALTER TABLE scheduled_jobs ADD COLUMN file_pattern TEXT DEFAULT '*'",
    "ALTER TABLE scheduled_jobs ADD COLUMN active_start_time TEXT",
    "ALTER TABLE scheduled_jobs ADD COLUMN active_end_time TEXT",
    "ALTER TABLE scheduled_jobs ADD COLUMN action_type TEXT NOT NULL DEFAULT 'session'",
    "ALTER TABLE scheduled_jobs ADD COLUMN pipeline_definition_id TEXT",
    "ALTER TABLE scheduled_jobs ADD COLUMN pipeline_input_json TEXT",
    "ALTER TABLE scheduled_jobs ADD COLUMN pipeline_agent TEXT",
    "ALTER TABLE scheduled_job_runs ADD COLUMN pipeline_run_id TEXT",
    "ALTER TABLE scheduled_jobs ADD COLUMN wapp_activity_installation_id TEXT",
    "ALTER TABLE scheduled_jobs ADD COLUMN model TEXT",
    "ALTER TABLE scheduled_jobs ADD COLUMN agent_id TEXT",
    "ALTER TABLE scheduled_jobs ADD COLUMN flightdeck_context_json TEXT",
  ];
  for (const sql of migrations) {
    const match = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(sql);
    if (!match) throw new Error("Invalid scheduler migration statement");
    const columns = db.query(`PRAGMA table_info(${match[1]})`).all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === match[2])) db.exec(sql);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_agent ON scheduled_jobs(agent_id)");
  db.exec("UPDATE scheduled_jobs SET nightwatchman_enabled = 0 WHERE nightwatchman_enabled <> 0");
}
