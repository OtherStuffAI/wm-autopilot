export function resolveLiveSessionUiReconciliation({
  sessions,
  routeSessionId,
  activeSessionId,
  lastActiveSessionId,
  mountedSessionId,
}) {
  const items = Array.isArray(sessions) ? sessions : [];
  const sessionIds = new Set(items.map((session) => session?.id).filter(Boolean));

  if (routeSessionId && !sessionIds.has(routeSessionId)) {
    return { action: "render", sessionId: null };
  }

  const expectedSessionId = routeSessionId
    || (activeSessionId && sessionIds.has(activeSessionId) ? activeSessionId : null)
    || (lastActiveSessionId && sessionIds.has(lastActiveSessionId) ? lastActiveSessionId : null);

  if (!expectedSessionId || !mountedSessionId) {
    return { action: "render", sessionId: expectedSessionId };
  }

  if (mountedSessionId !== expectedSessionId) {
    return { action: "switch", sessionId: expectedSessionId };
  }

  return { action: "refresh", sessionId: expectedSessionId };
}
