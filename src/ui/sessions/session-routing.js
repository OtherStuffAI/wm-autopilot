/**
 * Session routing module.
 *
 * Extracted from app.js. Provides setActiveSession, ensureActiveSession, and
 * applyRouteSessionFromPath. Uses dependency injection so callers supply all
 * external references.
 *
 * @param {object} deps
 * @param {() => object} deps.sessionsStore                - lazy accessor for Alpine sessions store
 * @param {() => string} deps.getCurrentRoute              - returns the current route string
 * @param {(route: string) => void} deps.setCurrentRoute   - sets the current route string
 * @param {() => string|null} deps.getLastLoggedSessionId  - returns lastLoggedSessionId
 * @param {(id: string|null) => void} deps.setLastLoggedSessionId - sets lastLoggedSessionId
 * @param {string} deps.LIVE_ROUTE_PREFIX                  - route prefix constant (e.g. "/live")
 * @param {Function} deps.getSessionById                   - returns a session object by id
 * @param {Function} deps.getActiveSessions                - returns array of active sessions
 * @param {Function} deps.getSessionIdFromPath             - extracts session id from a URL pathname
 * @param {Function} deps.updateDocumentTitle              - updates the document title
 * @param {Function} deps.activateLiveSessionRefresh       - boots live refresh for a session
 * @param {Function} deps.deactivateLiveSessionRefresh     - tears down live refresh for a session
 * @param {Function} deps.getLiveRefreshSessionId          - returns the session currently owned by live refresh
 * @param {Function} deps.isAlpineChatEnabled              - returns whether Alpine chat is enabled
 * @param {Function} deps.scheduleLiveScroll               - schedules a live scroll for a session
 * @param {Function} deps.scrollConversationAreaToBottom   - scrolls the conversation area to bottom
 * @param {Function} [deps.onSessionVisited]               - records session visits for command surfaces
 */

function afterNextPaint(callback) {
  if (typeof requestAnimationFrame !== "function") {
    setTimeout(callback, 0);
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

export function createSessionRouting(deps) {
  const {
    sessionsStore,
    getCurrentRoute,
    getLastLoggedSessionId,
    setLastLoggedSessionId,
    LIVE_ROUTE_PREFIX,
    getSessionById,
    getActiveSessions,
    getSessionIdFromPath,
    updateDocumentTitle,
    activateLiveSessionRefresh,
    deactivateLiveSessionRefresh,
    getLiveRefreshSessionId,
    isAlpineChatEnabled,
    scheduleLiveScroll,
    onSessionVisited,
  } = deps;

  const setActiveSession = (sessionId, options = {}) => {
    const { updateHistory = true, logPort = true, allowPending = false, forceLog = false } = options;
    const ss = sessionsStore();
    const previousSessionId = ss.activeSessionId;
    const allSessions = ss.items;

    if (sessionId) {
      const sessionExists = allSessions.some((session) => session.id === sessionId);
      if (!sessionExists && !allowPending) {
        ss.activeSessionId = null;
        setLastLoggedSessionId(null);
        return false;
      }

      ss.activeSessionId = sessionId;
      ss.lastActiveSessionId = sessionId;
      const visitedSession = allSessions.find((session) => session.id === sessionId) ?? null;
      if (visitedSession && typeof onSessionVisited === "function") {
        onSessionVisited(visitedSession);
      }

      if (updateHistory && getCurrentRoute() === "live") {
        const targetPath = `${LIVE_ROUTE_PREFIX}/${sessionId}`;
        if (window.location.pathname !== targetPath) {
          window.history.pushState({ route: "live", sessionId }, "", targetPath);
        }
      }

      if (logPort && sessionExists) {
        const shouldLog = forceLog
          ? getLastLoggedSessionId() !== sessionId
          : sessionId !== previousSessionId;
        if (shouldLog) {
          const session = getSessionById(sessionId);
          if (session) {
            console.log("This session is sending to port:", session.port);
            setLastLoggedSessionId(sessionId);
          }
        }
      }

      updateDocumentTitle();

      // Manage live refresh for the active live session.
      if (getCurrentRoute() === "live" && sessionExists) {
        const switchedSessions = previousSessionId !== sessionId;
        const refreshOwnedSessionId = typeof getLiveRefreshSessionId === "function"
          ? getLiveRefreshSessionId()
          : null;
        const alreadyOwnedByRefresh = refreshOwnedSessionId === sessionId;

        if (previousSessionId && switchedSessions) {
          deactivateLiveSessionRefresh(previousSessionId);
        }
        if (switchedSessions || !alreadyOwnedByRefresh) {
          activateLiveSessionRefresh(sessionId, { refresh: switchedSessions || !alreadyOwnedByRefresh });
        }

        // Dispatch session-change event for Alpine.js chat component
        if (isAlpineChatEnabled() && switchedSessions) {
          window.wingman = window.wingman || {};
          window.wingman.activeSessionId = sessionId;
          window.dispatchEvent(new CustomEvent("session-change", { detail: { sessionId } }));
        }

        // Scroll after the tab switch render has replaced the conversation pane.
        if (switchedSessions) {
          afterNextPaint(() => {
            scheduleLiveScroll(sessionId, { includeWindow: true, force: true });
          });
        }
      }

      return true;
    }

    // No session selected - stop live refresh
    ss.activeSessionId = null;
    setLastLoggedSessionId(null);
    deactivateLiveSessionRefresh(previousSessionId);
    if (updateHistory && getCurrentRoute() === "live" && window.location.pathname !== LIVE_ROUTE_PREFIX) {
      window.history.pushState({ route: "live" }, "", LIVE_ROUTE_PREFIX);
    }
    updateDocumentTitle();
    return true;
  };

  const ensureActiveSession = () => {
    const allSessions = sessionsStore().items;
    const activeId = sessionsStore().activeSessionId;
    const lastId = sessionsStore().lastActiveSessionId;

    if (activeId && allSessions.some((session) => session.id === activeId)) {
      return activeId;
    }
    if (lastId && allSessions.some((session) => session.id === lastId)) {
      setActiveSession(lastId, { updateHistory: false, logPort: false });
      return sessionsStore().activeSessionId;
    }
    if (getCurrentRoute() === "live") {
      setActiveSession(null, { updateHistory: false, logPort: false });
      return null;
    }
    const activeSessions = getActiveSessions();
    const fallback = activeSessions[0] ?? allSessions[0] ?? null;
    if (fallback) {
      setActiveSession(fallback.id, { updateHistory: false, logPort: false });
    } else {
      setActiveSession(null, { updateHistory: false, logPort: false });
    }
    return sessionsStore().activeSessionId;
  };

  const applyRouteSessionFromPath = (options = {}) => {
    const { allowHistoryUpdate = false, logPort = true } = options;
    const routeSessionId = getSessionIdFromPath(window.location.pathname);
    const allSessions = sessionsStore().items;
    const activeId = sessionsStore().activeSessionId;
    const lastId = sessionsStore().lastActiveSessionId;

    if (routeSessionId) {
      if (allSessions.some((session) => session.id === routeSessionId)) {
        const shouldEnsureLiveTransport = getCurrentRoute() === "live" && activeId === routeSessionId;
        if (activeId !== routeSessionId || shouldEnsureLiveTransport) {
          setActiveSession(routeSessionId, { updateHistory: false, logPort });
        }
        return;
      }
      if (activeId) {
        setActiveSession(null, { updateHistory: false, logPort: false });
      }
      return;
    }

    if (allowHistoryUpdate && lastId && allSessions.some((session) => session.id === lastId)) {
      setActiveSession(lastId, { updateHistory: true, logPort });
      return;
    }

    if (activeId && !allSessions.some((session) => session.id === activeId)) {
      setActiveSession(null, { updateHistory: allowHistoryUpdate, logPort: false });
    }
  };

  return {
    setActiveSession,
    ensureActiveSession,
    applyRouteSessionFromPath,
  };
}
