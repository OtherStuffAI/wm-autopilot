import type { QueuedPrompt } from "./prompt-queue-store";

export const mapQueuedPrompt = (row: Record<string, unknown>): QueuedPrompt => ({
  revision: String(row.revision),
  state: row.state as QueuedPrompt["state"],
  handledAt: row.handled_at as string | null,
  handledBy: row.handled_by as string | null,
  handledReason: row.handled_reason as string | null,
  deliveryState: row.delivery_state as string | null,
  deliveryId: row.delivery_id as string | null,
  deliveryUpdatedAt: row.delivery_updated_at as string | null,
  claimToken: row.claim_token as string | null,
  id: String(row.id),
  sessionId: String(row.session_id),
  content: String(row.content),
  timestamp: String(row.timestamp),
  order: Number(row.queue_order),
  type: typeof row.type === "string" ? row.type : null,
  dedupeKey: typeof row.dedupe_key === "string" ? row.dedupe_key : null,
  payload: typeof row.payload_json === "string"
    ? JSON.parse(row.payload_json) as Record<string, unknown>
    : null,
});
