import type { DirectChatTurnRecord, DirectChatTurnStore } from "./direct-chat-turn-store";

export const DIRECT_CHAT_STATUS_PROMPT_TYPE = "direct_chat_status";

export function isDirectChatStatus(record: DirectChatTurnRecord): boolean {
  return record.promptType === DIRECT_CHAT_STATUS_PROMPT_TYPE;
}

/** Status has its own immutable request, leaving the accepted final recoverable. */
export function queueDirectChatStatus(
  store: DirectChatTurnStore,
  turn: DirectChatTurnRecord,
  kind: "interrupted" | "recovery",
  at: string,
): DirectChatTurnRecord {
  const turnId = `${turn.turnId}:status:${kind}`;
  const existing = store.get(turnId);
  if (existing) return existing;
  const body = kind === "interrupted"
    ? "Work was interrupted before a verified final response. The accepted context was retained without automatic resubmission. Completion and any dispatched worker results require independent verification."
    : "The session has been replaced for recovery. Existing supervised workers and their callbacks remain owned by the replacement session; this is not a completion report.";
  return store.save({ ...turn, turnId, clientRequestId: `${turn.clientRequestId}:status:${kind}`,
    promptType: DIRECT_CHAT_STATUS_PROMPT_TYPE, state: "reply_ready", replyBody: body,
    publicationPayload: null, payloadHash: null, publishedMessageId: null, publishedAt: null,
    createdAt: at, updatedAt: at, replyReadyAt: at, nextAttemptAt: at,
    leaseOwner: null, leaseExpiresAt: null, attemptCount: 0, lastError: null, lastErrorClass: null });
}
