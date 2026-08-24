function readMessageField(message, ...keys) {
  for (const key of keys) {
    const value = message?.[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function readMessageIdentity(message) {
  const explicitId = readMessageField(message, "messageId", "message_id");
  if (explicitId) {
    return explicitId;
  }
  const id = message?.id;
  return typeof id === "string" && id.length > 0 ? id : "";
}

export function normalizeConversationMessage(message, fallbackCreatedAt = new Date().toISOString()) {
  const role = readMessageField(message, "role", "type") || "assistant";
  const content = readMessageField(message, "content", "message");
  const createdAt = readMessageField(message, "createdAt", "created_at") || fallbackCreatedAt;
  const messageId = readMessageIdentity(message);
  const normalized = {
    role,
    content,
    createdAt,
  };

  const turnId = readMessageField(message, "turnId", "turn_id");
  const order = message?.order ?? message?.messageOrder ?? message?.message_order;

  if (messageId) {
    normalized.messageId = messageId;
  }
  if (turnId) normalized.turnId = turnId;
  if (typeof order === "number" && Number.isFinite(order)) normalized.order = order;
  if (message?.speech && typeof message.speech === "object") {
    normalized.speech = message.speech;
  }

  return normalized;
}

export function normalizeConversationMessages(messages, fallbackCreatedAt = new Date().toISOString()) {
  const items = Array.isArray(messages) ? messages : [];
  return items.map((message) => normalizeConversationMessage(message, fallbackCreatedAt));
}

const OPTIMISTIC_USER_MATCH_WINDOW_MS = 10_000;

/**
 * Decide whether a canonical snapshot proves that a local user row is a
 * duplicate. Confirmed legacy rows require the exact server timestamp.
 * Optimistic rows have a browser timestamp, so accept only the same content
 * created within the short send/reconciliation window.
 */
export function hasEquivalentIncomingUser(message, incomingMessages) {
  if (message?.role !== "user") return false;
  return incomingMessages.some((candidate) => {
    if (candidate?.role !== "user" || candidate.content !== message.content) return false;
    if (candidate.createdAt === message.createdAt) return true;
    if (message.pending !== true) return false;
    const localTime = Date.parse(message.createdAt);
    const canonicalTime = Date.parse(candidate.createdAt);
    return Number.isFinite(localTime) &&
      Number.isFinite(canonicalTime) &&
      Math.abs(canonicalTime - localTime) <= OPTIMISTIC_USER_MATCH_WINDOW_MS;
  });
}

/**
 * Decide whether an unmatched local user row is older than the canonical
 * snapshot. A snapshot may legitimately lag behind a newly-sent prompt, so
 * preserve rows newer than its watermark. Once the snapshot has advanced
 * past a row, retaining that unmatched row only leaves stale transport echoes
 * visible forever.
 */
export function isUserMessageCoveredBySnapshot(message, incomingMessages) {
  if (message?.role !== "user" || message.pending === true || message.optimistic === true) {
    return false;
  }
  if (hasEquivalentIncomingUser(message, incomingMessages)) {
    return true;
  }

  const messageTime = Date.parse(message.createdAt);
  if (!Number.isFinite(messageTime)) return false;

  const snapshotWatermark = incomingMessages.reduce((latest, candidate) => {
    const candidateTime = Date.parse(candidate?.createdAt);
    return Number.isFinite(candidateTime) ? Math.max(latest, candidateTime) : latest;
  }, Number.NEGATIVE_INFINITY);

  return Number.isFinite(snapshotWatermark) && messageTime <= snapshotWatermark;
}

export function areConversationMessagesEqual(previousMessages, nextMessages) {
  const previous = Array.isArray(previousMessages) ? previousMessages : [];
  const next = Array.isArray(nextMessages) ? nextMessages : [];

  if (previous.length !== next.length) {
    return false;
  }

  for (let index = 0; index < previous.length; index += 1) {
    const current = previous[index] ?? {};
    const incoming = next[index] ?? {};

    if (
      readMessageIdentity(current) !== readMessageIdentity(incoming) ||
      readMessageField(current, "role", "type") !== readMessageField(incoming, "role", "type") ||
      readMessageField(current, "content", "message") !== readMessageField(incoming, "content", "message") ||
      readMessageField(current, "createdAt", "created_at") !== readMessageField(incoming, "createdAt", "created_at") ||
      readMessageField(current, "turnId", "turn_id") !== readMessageField(incoming, "turnId", "turn_id") ||
      (current.order ?? null) !== (incoming.order ?? null) ||
      JSON.stringify(current.speech ?? null) !== JSON.stringify(incoming.speech ?? null)
    ) {
      return false;
    }
  }

  return true;
}
