import type { Database } from 'bun:sqlite';

/**
 * Durable evidence that an Agent Direct turn already carried a source message on a routing key. Routing keys do not
 * include the subscription, so this survives a profile moving from a shared legacy subscription to its own strict
 * inbox (whose catch-up re-delivers recent requests with bounded transcripts and a fresh session generation).
 * - done: a completed, published, suppressed or halted turn carried it (the request was delivered; never replay it).
 * - active: an in-flight turn carries it (recovery/reconciliation owns it; never a new prompt or a retirement).
 * - failed: only failed turns carried it (ordinary retry behaviour applies).
 */
export type CarriedSourceState = 'done' | 'active' | 'failed';

const DONE_STATES = new Set(['completed', 'published', 'suppressed', 'integrity_halt']);

const stateOf = (states: string[]): CarriedSourceState | null => {
  if (!states.length) return null;
  if (states.some((state) => DONE_STATES.has(state))) return 'done';
  if (states.some((state) => state !== 'failed')) return 'active';
  return 'failed';
};

export function carriedSourceState(db: Database, routingKey: string, messageId: string): CarriedSourceState | null {
  const rows = db.query(`SELECT t.state AS state FROM agent_direct_chat_turns t, json_each(t.source_message_ids_json) j
    WHERE t.routing_key = ?1 AND j.value = ?2 AND COALESCE(t.prompt_type, '') != 'direct_chat_status'`).all(routingKey, messageId) as Array<{ state: string }>;
  return stateOf(rows.map((row) => row.state));
}

/** Source messages already delivered by a finished turn on this routing key. */
export function doneCarriedSourceIds(db: Database, routingKey: string): Set<string> {
  const rows = db.query(`SELECT j.value AS id, t.state AS state FROM agent_direct_chat_turns t, json_each(t.source_message_ids_json) j
    WHERE t.routing_key = ?1 AND COALESCE(t.prompt_type, '') != 'direct_chat_status'`).all(routingKey) as Array<{ id: string; state: string }>;
  return new Set(rows.filter((row) => DONE_STATES.has(row.state)).map((row) => String(row.id)));
}
