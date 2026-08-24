/**
 * Synchronize live-route transport ownership between the raw SSE manager and
 * the higher-level live refresh controller.
 */

export function syncLiveRouteTransport(options) {
  const {
    previousRoute,
    currentRoute,
    activeSessionId,
    sseManager,
    liveRefreshController,
  } = options;

  const routeChanged = previousRoute !== currentRoute;
  if (!routeChanged) {
    return previousRoute;
  }

  if (previousRoute === "live" && currentRoute !== "live") {
    liveRefreshController?.deactivateSession?.();
    sseManager.disconnectAll();
    return currentRoute;
  }

  if (currentRoute === "live" && activeSessionId) {
    if (liveRefreshController?.activateSession) {
      liveRefreshController.activateSession(activeSessionId, { refresh: false });
    } else {
      sseManager.connect(activeSessionId);
    }
  }

  return currentRoute;
}
