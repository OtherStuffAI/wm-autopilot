export function createSessionStartHandler(deps) {
  const {
    getCurrentRoute,
    setCurrentRoute,
    setActiveSession,
    updateWorkingDirectory,
    fetchSessions,
    fetchConversation,
    fetchLogs,
    render,
  } = deps;

  return async function handleSessionStart(session, options = {}) {
    const {
      suppressRouteChange = false,
      activateSessionInOriginWindow = true,
    } = options;

    if (!session || !session.id) {
      return;
    }

    const shouldActivateSession = activateSessionInOriginWindow;
    const switchingToLive = getCurrentRoute() !== "live";

    if (shouldActivateSession) {
      if (switchingToLive && !suppressRouteChange) {
        setCurrentRoute("live");
      }
      setActiveSession(session.id, {
        allowPending: true,
        logPort: false,
        updateHistory: !suppressRouteChange,
      });
    }

    updateWorkingDirectory(session);
    await fetchSessions();

    if (shouldActivateSession) {
      await Promise.all([fetchConversation(session.id), fetchLogs(session.id)]);
    }

    render();
  };
}
