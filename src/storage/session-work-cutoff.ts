import type { Database } from "bun:sqlite";

/** A per-store, durable cutoff. The caller supplies only internal table names.
 * Capture and retirement share an immediate transaction; retries never widen it. */
export function retireSessionWork(db: Database, scope: string, sessionId: string, triggerId: string,
  table: string, retire: (cutoff: number, at: string) => void): number {
  db.exec(`CREATE TABLE IF NOT EXISTS session_work_cutoffs (
    scope TEXT NOT NULL, session_id TEXT NOT NULL, trigger_id TEXT NOT NULL,
    generation INTEGER NOT NULL, row_cutoff INTEGER NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(scope, session_id, trigger_id)
  )`);
  return db.transaction(() => {
    const existing = db.query("SELECT generation FROM session_work_cutoffs WHERE scope=? AND session_id=? AND trigger_id=?")
      .get(scope, sessionId, triggerId) as { generation: number } | null;
    if (existing) return existing.generation;
    const generation = sessionWorkGeneration(db, scope, sessionId) + 1;
    const cutoff = (db.query(`SELECT COALESCE(MAX(rowid),0) AS cutoff FROM ${table}`).get() as { cutoff: number }).cutoff;
    const at = new Date().toISOString();
    db.query("INSERT INTO session_work_cutoffs VALUES (?,?,?,?,?,?)").run(scope, sessionId, triggerId, generation, cutoff, at);
    retire(cutoff, at);
    return generation;
  }).immediate();
}

export function sessionWorkGeneration(db: Database, scope: string, sessionId: string): number {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_work_cutoffs'").get()) return 0;
  return (db.query("SELECT COALESCE(MAX(generation),0) AS generation FROM session_work_cutoffs WHERE scope=? AND session_id=?")
    .get(scope, sessionId) as { generation: number }).generation;
}
