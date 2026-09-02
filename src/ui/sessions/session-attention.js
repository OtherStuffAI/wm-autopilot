export function buildSessionAttentionChanges(
  sessions,
  existingRecords,
  now = new Date().toISOString(),
) {
  const existingById = new Map(existingRecords.map((record) => [record.sessionId, record]));
  const updates = [];

  for (const session of sessions) {
    const sessionId = typeof session?.id === "string" ? session.id : null;
    const runtimeStatus = session?.agentRuntimeStatus;
    if (!sessionId || (runtimeStatus !== "running" && runtimeStatus !== "stable")) continue;

    const existing = existingById.get(sessionId) ?? { sessionId };
    const next = { ...existing, runtimeStatus };
    if (runtimeStatus === "running" && existing.runtimeStatus !== "running") {
      next.lastRunningAt = now;
    } else if (runtimeStatus === "stable" && existing.runtimeStatus === "running") {
      next.completedAt = now;
    }
    updates.push(next);
  }

  return { updates };
}
