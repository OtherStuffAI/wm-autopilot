const STOPPED_SESSION_STATUSES = new Set(["stopped", "completed"]);
const ERROR_SESSION_STATUSES = new Set(["error", "failed"]);

export const HOME_SESSION_STATUS_ORDER = Object.freeze({
  active: 0,
  online: 1,
  stopped: 2,
  error: 3,
});

function normalizeStatusValue(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;
}

export function resolveHomeSessionStatus(session) {
  const lifecycleStatus = normalizeStatusValue(session?.status);
  const runtimeStatus = normalizeStatusValue(session?.agentRuntimeStatus);

  if (STOPPED_SESSION_STATUSES.has(lifecycleStatus)) {
    return {
      key: "stopped",
      label: "Stopped",
      description: "Session has been stopped but has not been archived yet.",
    };
  }

  if (ERROR_SESSION_STATUSES.has(lifecycleStatus)) {
    return {
      key: "error",
      label: "Error",
      description: "Session is not responding.",
    };
  }

  if (runtimeStatus === "running") {
    return {
      key: "active",
      label: "Active",
      description: "Session has an active turn in progress.",
    };
  }

  if (runtimeStatus === "stable" || lifecycleStatus === "starting") {
    return {
      key: "online",
      label: "Online",
      description: lifecycleStatus === "starting"
        ? "Session is starting and will accept input when ready."
        : "Session is on and waiting for input.",
    };
  }

  return {
    key: "error",
    label: "Error",
    description: "Session runtime status is missing or inconsistent.",
  };
}
