/**
 * Live refresh controller.
 * Keeps live sessions SSE-first while preserving explicit polling fallbacks for
 * heartbeat-only adapters and degraded recovery windows.
 */

export const LIVE_STREAM_MODE = Object.freeze({
  unknown: "unknown",
  eventStream: "event-stream",
  heartbeatOnly: "heartbeat-only",
  degraded: "degraded",
});

export const LIVE_POLL_MODE = Object.freeze({
  off: "off",
  compatibility: "compatibility",
  recovery: "recovery",
});

const COMPATIBILITY_POLL_INTERVAL_MS = 1000;
const RECOVERY_POLL_INTERVAL_MS = 2000;
const MOBILE_COMPOSER_POLL_INTERVAL_MS = 3000;

function supportsStreamModeTracking(sseManager) {
  return typeof sseManager.getStreamMode === "function";
}

function shouldUseCompatibilityPolling({ streamMode, runtimeStatus, streamModeTracked }) {
  if (streamMode === LIVE_STREAM_MODE.heartbeatOnly) {
    return true;
  }

  if (runtimeStatus !== "running") {
    return false;
  }

  if (!streamModeTracked) {
    return true;
  }

  return false;
}

export function createLiveRefreshController(deps) {
  const {
    sseManager,
    getCurrentRoute,
    getActiveSessionId,
    getSessionRuntimeStatus,
    fetchConversation,
    fetchLogs,
    fetchSessionQueue,
    fetchSessionDetails,
    applySessionDetails,
    isComposerInteractionActive,
    isMobileKeyboardOpen,
  } = deps;

  let activeSessionId = null;
  let activePollMode = LIVE_POLL_MODE.off;
  let pollIntervalId = null;
  let pollInFlight = false;
  let lastComposerAwarePollAt = 0;
  let shouldCatchUpOnConnect = false;
  let shouldCatchUpAfterDegraded = false;
  const resourceRequests = new Map();

  const runCoalesced = (key, operation) => {
    const existing = resourceRequests.get(key);
    if (existing) return existing;
    let result;
    try {
      result = operation();
    } catch (error) {
      return Promise.reject(error);
    }
    const request = Promise.resolve(result).finally(() => {
      resourceRequests.delete(key);
    });
    resourceRequests.set(key, request);
    return request;
  };

  const refreshSession = async (sessionId, options = {}) => {
    const {
      includeConversation = true,
      includeLogs = false,
      includeQueue = true,
      includeStatus = true,
      allowComposerThrottle = false,
      reason = "manual",
    } = options;

    if (!sessionId) {
      return;
    }

    const composerActive = isComposerInteractionActive() || isMobileKeyboardOpen();
    const now = Date.now();
    const composerPollDue = now - lastComposerAwarePollAt >= MOBILE_COMPOSER_POLL_INTERVAL_MS;
    const shouldThrottleForComposer = allowComposerThrottle && composerActive && !composerPollDue;

    if (allowComposerThrottle && composerActive && composerPollDue) {
      lastComposerAwarePollAt = now;
    }

    try {
      const refreshTasks = [];

      if (includeConversation && !shouldThrottleForComposer) {
        refreshTasks.push(runCoalesced(`${sessionId}:conversation`, () => fetchConversation(sessionId)));
      }

      if (includeLogs) {
        refreshTasks.push(runCoalesced(`${sessionId}:logs`, () => fetchLogs(sessionId)));
      }

      if (includeQueue && !shouldThrottleForComposer) {
        refreshTasks.push(runCoalesced(`${sessionId}:queue`, () => fetchSessionQueue(sessionId)));
      }

      if (includeStatus && !shouldThrottleForComposer) {
        refreshTasks.push(runCoalesced(`${sessionId}:status`, () =>
          Promise.resolve(fetchSessionDetails(sessionId)).then((sessionData) => {
            if (sessionData) {
              applySessionDetails(sessionId, sessionData, { reason });
            }
          }),
        ));
      }

      await Promise.all(refreshTasks);
    } catch (error) {
      console.warn(`[live-refresh] Failed to refresh ${sessionId} (${reason})`, error);
    }
  };

  const stopPolling = () => {
    if (pollIntervalId !== null) {
      window.clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
    activePollMode = LIVE_POLL_MODE.off;
    pollInFlight = false;
    lastComposerAwarePollAt = 0;
  };

  const runPollingTick = async (pollMode) => {
    if (pollInFlight || !activeSessionId) {
      return;
    }

    if (getCurrentRoute() !== "live" || getActiveSessionId() !== activeSessionId) {
      stopPolling();
      return;
    }

    pollInFlight = true;
    try {
      await refreshSession(activeSessionId, {
        includeConversation: pollMode === LIVE_POLL_MODE.recovery,
        includeLogs: false,
        includeQueue: true,
        includeStatus: true,
        allowComposerThrottle: true,
        reason: `poll:${pollMode}`,
      });
    } finally {
      pollInFlight = false;
    }
  };

  const startPolling = (pollMode) => {
    const intervalMs =
      pollMode === LIVE_POLL_MODE.compatibility
        ? COMPATIBILITY_POLL_INTERVAL_MS
        : RECOVERY_POLL_INTERVAL_MS;

    if (pollIntervalId !== null && activePollMode === pollMode) {
      return;
    }

    stopPolling();
    activePollMode = pollMode;
    pollIntervalId = window.setInterval(() => {
      void runPollingTick(pollMode);
    }, intervalMs);
    console.log(`[live-refresh] ${pollMode} polling active for ${activeSessionId} (${intervalMs}ms)`);
  };

  const resolvePollMode = (sessionId) => {
    if (!sessionId) {
      return LIVE_POLL_MODE.off;
    }

    const connectionState = sseManager.getConnectionState(sessionId);
    const streamModeTracked = supportsStreamModeTracking(sseManager);
    const streamMode = streamModeTracked
      ? sseManager.getStreamMode(sessionId)
      : LIVE_STREAM_MODE.unknown;
    const runtimeStatus = typeof getSessionRuntimeStatus === "function"
      ? getSessionRuntimeStatus(sessionId)
      : null;

    if (
      streamMode === LIVE_STREAM_MODE.degraded ||
      connectionState === "disconnected"
    ) {
      return LIVE_POLL_MODE.recovery;
    }

    // Heartbeat-only and legacy streams still need compatibility checks. A
    // healthy event stream receives durable-message refresh signals from the
    // persistence loop and must not duplicate that work with steady polling.
    if (shouldUseCompatibilityPolling({ streamMode, runtimeStatus, streamModeTracked })) {
      return LIVE_POLL_MODE.compatibility;
    }

    return LIVE_POLL_MODE.off;
  };

  const syncPollingForSession = (sessionId) => {
    if (!sessionId || sessionId !== activeSessionId || getCurrentRoute() !== "live") {
      stopPolling();
      return;
    }

    const nextPollMode = resolvePollMode(sessionId);
    if (nextPollMode === LIVE_POLL_MODE.off) {
      stopPolling();
      return;
    }

    startPolling(nextPollMode);
  };

  const activateSession = (sessionId, options = {}) => {
    const { refresh = true } = options;
    if (!sessionId) {
      return;
    }

    const switchedSessions = activeSessionId !== sessionId;
    if (switchedSessions && activeSessionId) {
      sseManager.disconnect(activeSessionId);
      stopPolling();
    }

    activeSessionId = sessionId;
    shouldCatchUpOnConnect = false;
    shouldCatchUpAfterDegraded = false;
    sseManager.connect(sessionId);
    syncPollingForSession(sessionId);

    if (refresh || switchedSessions) {
      void refreshSession(sessionId, {
        includeConversation: true,
        includeLogs: true,
        includeQueue: true,
        includeStatus: true,
        allowComposerThrottle: false,
        reason: switchedSessions ? "bootstrap" : "route-refresh",
      });
    }
  };

  const deactivateSession = (sessionId = activeSessionId) => {
    if (!sessionId) {
      stopPolling();
      activeSessionId = null;
      return;
    }

    if (activeSessionId === sessionId) {
      stopPolling();
      activeSessionId = null;
    }

    sseManager.disconnect(sessionId);
  };

  sseManager.onConnectionChange((sessionId, state) => {
    if (sessionId !== activeSessionId) {
      return;
    }

    if (state === "connected") {
      if (shouldCatchUpOnConnect) {
        shouldCatchUpOnConnect = false;
        void refreshSession(sessionId, {
          includeConversation: true,
          includeLogs: true,
          includeQueue: true,
          includeStatus: true,
          allowComposerThrottle: false,
          reason: "reconnected",
        });
      }
    } else if (state === "error" || state === "disconnected") {
      shouldCatchUpOnConnect = true;
    }

    syncPollingForSession(sessionId);
  });

  if (typeof sseManager.onStreamModeChange === "function") {
    sseManager.onStreamModeChange((sessionId, streamMode) => {
      if (sessionId !== activeSessionId) {
        return;
      }

      if (streamMode === LIVE_STREAM_MODE.degraded) {
        shouldCatchUpAfterDegraded = true;
        void refreshSession(sessionId, {
          includeConversation: true,
          includeLogs: false,
          includeQueue: true,
          includeStatus: true,
          allowComposerThrottle: false,
          reason: "degraded-window",
        });
      } else if (streamMode === LIVE_STREAM_MODE.eventStream && shouldCatchUpAfterDegraded) {
        shouldCatchUpAfterDegraded = false;
        void refreshSession(sessionId, {
          includeConversation: true,
          includeLogs: true,
          includeQueue: true,
          includeStatus: true,
          allowComposerThrottle: false,
          reason: "upstream-reconnected",
        });
      }

      syncPollingForSession(sessionId);
    });
  }

  if (typeof sseManager.onRefresh === "function") {
    sseManager.onRefresh((sessionId) => {
      if (sessionId !== activeSessionId || getCurrentRoute() !== "live") return;
      void refreshSession(sessionId, {
        includeConversation: true,
        includeLogs: false,
        includeQueue: false,
        includeStatus: false,
        allowComposerThrottle: false,
        reason: "server-messages-updated",
      });
    });
  }

  return {
    activateSession,
    deactivateSession,
    getActiveSessionId() {
      return activeSessionId;
    },
    getPollMode() {
      return activePollMode;
    },
    syncPollingForSession,
    refreshSession,
  };
}
