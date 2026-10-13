import type { Database } from "bun:sqlite";

export function findInterruptedDirectChatSessionTurn(db: Database, sessionId: string, routingKey: string) {
  return db.query(`SELECT * FROM agent_direct_chat_turns WHERE session_id=?1 AND routing_key=?2
    AND state='failed' AND last_error_class IN ('session_missing','session_stopped')
    AND publication_payload_json IS NULL ORDER BY created_at DESC LIMIT 1`)
    .get(sessionId, routingKey) as Record<string, unknown> | null;
}

/** Same-native recovery preserves the prompt and refuses to rewind frozen finals. */
export function rebindAcceptedDirectChatSession(db: Database, turnId: string, sourceId: string, targetId: string) {
  return db.query(`UPDATE agent_direct_chat_turns SET session_id=?3,updated_at=?4,state='awaiting_reply',
    lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=?4
    WHERE turn_id=?1 AND session_id=?2 AND publication_payload_json IS NULL
      AND (state IN ('accepted','awaiting_reply') OR (state='failed'
        AND last_error_class IN ('session_missing','session_stopped'))) RETURNING *`)
    .get(turnId, sourceId, targetId, new Date().toISOString()) as Record<string, unknown> | null;
}
