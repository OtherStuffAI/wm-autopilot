import type { Database } from "bun:sqlite";

export function prunePromptQueueHistory(db: Database, sessionId: string): void {
  // Retry window: seven days and most recent 1000 terminal records per session.
  db.query(`DELETE FROM prompt_queue WHERE session_id = ? AND state IN ('handled', 'dispatched')
    AND (COALESCE(handled_at, delivery_updated_at, timestamp) < ? OR id NOT IN
      (SELECT id FROM prompt_queue WHERE session_id = ? AND state IN ('handled', 'dispatched')
       ORDER BY COALESCE(handled_at, delivery_updated_at, timestamp) DESC, rowid DESC LIMIT 1000))`)
    .run(sessionId, new Date(Date.now() - 7 * 86400000).toISOString(), sessionId);
  db.query(`UPDATE prompt_queue SET content = '', payload_json = NULL WHERE session_id = ?
    AND state IN ('handled', 'dispatched') AND content != '' AND id NOT IN (SELECT id FROM prompt_queue WHERE session_id = ?
    AND state IN ('handled', 'dispatched') ORDER BY COALESCE(handled_at, delivery_updated_at, timestamp) DESC, rowid DESC LIMIT 100)`)
    .run(sessionId, sessionId);
  db.query(`DELETE FROM prompt_queue_recovery WHERE session_id = ? AND (rowid NOT IN
    (SELECT rowid FROM prompt_queue_recovery WHERE session_id = ? ORDER BY rowid DESC LIMIT 1000) OR item_id NOT IN
    (SELECT id FROM prompt_queue WHERE session_id = ?))` ).run(sessionId, sessionId, sessionId);
}
