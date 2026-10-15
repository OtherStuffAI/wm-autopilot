import type { Database } from "bun:sqlite";
import { retireSessionWork } from "../storage/session-work-cutoff";

/** Persist the complete cutoff vector before mutating any queue database. */
export function freshSessionSnapshot<T>(db: Database, sessionId: string, triggerId: string, capture: () => T): T {
  db.exec(`CREATE TABLE IF NOT EXISTS fresh_session_work_snapshots (
    session_id TEXT NOT NULL, trigger_id TEXT NOT NULL, snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(session_id,trigger_id))`);
  return db.transaction(() => {
    const row = db.query("SELECT snapshot_json FROM fresh_session_work_snapshots WHERE session_id=? AND trigger_id=?")
      .get(sessionId, triggerId) as { snapshot_json: string } | null;
    if (row) return JSON.parse(row.snapshot_json) as T;
    const snapshot = capture();
    db.query("INSERT INTO fresh_session_work_snapshots VALUES (?,?,?,?)")
      .run(sessionId, triggerId, JSON.stringify(snapshot), new Date().toISOString());
    return snapshot;
  }).immediate();
}

export function captureFreshHumanCutoff(db: Database, sessionId: string, routingKey: string): string[] {
  return (db.query("SELECT turn_id FROM agent_direct_chat_turns WHERE (session_id=? OR routing_key=?) AND state NOT IN ('completed','published','suppressed')")
    .all(sessionId, routingKey) as Array<{ turn_id: string }>).map(row => row.turn_id);
}

export function retireDirectChatWork(db: Database, sessionId: string, triggerId: string, routingKey: string, snapshot?: string[]): void {
  retireSessionWork(db, "direct-turns", sessionId, triggerId, "agent_direct_chat_turns", (cutoff, at) => {
    db.query(`UPDATE agent_direct_chat_turns SET state='suppressed',lease_owner=NULL,lease_expires_at=NULL,
      next_attempt_at=NULL,last_error_class='fresh_human_supersession',last_error=?,updated_at=?
      WHERE (session_id=? OR routing_key=?) AND rowid<=? AND state NOT IN ('completed','published','suppressed')
        AND (? IS NULL OR turn_id IN (SELECT value FROM json_each(?)))`)
      .run(`Superseded by fresh human trigger ${triggerId}; old work completion unverified`, at, sessionId, routingKey, cutoff, snapshot ? JSON.stringify(snapshot) : null, snapshot ? JSON.stringify(snapshot) : null);
  });
}
