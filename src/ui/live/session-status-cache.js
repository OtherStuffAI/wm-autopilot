import { ApiSessionStore, SessionStore } from "./db.js";

const RUNTIME_STATUSES = new Set(["running", "stable"]);

export function normalizeRuntimeStatus(status) {
  if (typeof status !== "string") {
    return null;
  }

  const normalized = status.trim();
  return RUNTIME_STATUSES.has(normalized) ? normalized : null;
}

export function normalizeSessionStatus(status) {
  if (typeof status !== "string") {
    return null;
  }

  const normalized = status.trim();
  return normalized.length > 0 ? normalized : null;
}

export async function syncSessionStatusCaches(sessionId, updates = {}) {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return {
      status: null,
      agentRuntimeStatus: null,
    };
  }

  const nextStatus = normalizeSessionStatus(updates.status);
  const hasRuntimeStatus = Object.prototype.hasOwnProperty.call(updates, "agentRuntimeStatus");
  const nextRuntimeStatus = hasRuntimeStatus
    ? normalizeRuntimeStatus(updates.agentRuntimeStatus)
    : undefined;

  const sessionUpdates = {};
  if (nextStatus !== null) {
    sessionUpdates.status = nextStatus;
  }
  if (hasRuntimeStatus) {
    sessionUpdates.agentRuntimeStatus = nextRuntimeStatus ?? null;
  }

  const apiSessionUpdates = {};
  if (nextStatus !== null) {
    apiSessionUpdates.status = nextStatus;
  }
  if (hasRuntimeStatus) {
    apiSessionUpdates.agentRuntimeStatus = nextRuntimeStatus ?? null;
  }

  const tasks = [];
  if (Object.keys(sessionUpdates).length > 0) {
    tasks.push(SessionStore.patchSession(sessionId, sessionUpdates));
  }
  if (Object.keys(apiSessionUpdates).length > 0) {
    tasks.push(ApiSessionStore.patchSession(sessionId, apiSessionUpdates));
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }

  return {
    status: nextStatus,
    agentRuntimeStatus: hasRuntimeStatus ? nextRuntimeStatus ?? null : null,
  };
}
