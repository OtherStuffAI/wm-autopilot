import { sortSessionsForTabs } from "./session-order.js";

function parseTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function isSessionComplete(session, attention) {
  if (session?.agentRuntimeStatus !== "stable") return false;
  const completedAt = parseTimestamp(attention?.completedAt);
  return completedAt > 0 && completedAt > parseTimestamp(attention?.viewedAt);
}

export function getSessionTabState(session, attention, activeSessionId) {
  if (isSessionComplete(session, attention)) return "complete";
  if (session?.id === activeSessionId) return "selected";
  if (session?.agentRuntimeStatus === "running") return "running";
  return "ready";
}

export function sortSessionsForTabState(sessions, attentionById = {}) {
  const ordered = sortSessionsForTabs(sessions);
  const complete = [];
  const remaining = [];

  for (const session of ordered) {
    const attention = attentionById?.[session?.id] ?? null;
    (isSessionComplete(session, attention) ? complete : remaining).push(session);
  }

  return [...complete, ...remaining];
}
