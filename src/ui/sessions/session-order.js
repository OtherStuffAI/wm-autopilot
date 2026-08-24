function getSessionStartedAt(session) {
  const time = Date.parse(session?.startedAt ?? "");
  return Number.isFinite(time) ? time : 0;
}

function getSessionTabOrder(session) {
  return typeof session?.tabOrder === "number" && Number.isFinite(session.tabOrder)
    ? session.tabOrder
    : Number.MAX_SAFE_INTEGER;
}

export function compareSessionsForTabs(a, b) {
  const byOrder = getSessionTabOrder(a) - getSessionTabOrder(b);
  if (byOrder !== 0) return byOrder;
  const byStartedAt = getSessionStartedAt(a) - getSessionStartedAt(b);
  if (byStartedAt !== 0) return byStartedAt;
  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

export function sortSessionsForTabs(sessions) {
  return Array.isArray(sessions) ? [...sessions].sort(compareSessionsForTabs) : [];
}

export function getSessionPosition(session, sessions) {
  const ordered = sortSessionsForTabs(sessions);
  const index = ordered.findIndex((entry) => entry?.id === session?.id);
  return index >= 0 ? index + 1 : ordered.length + 1;
}
