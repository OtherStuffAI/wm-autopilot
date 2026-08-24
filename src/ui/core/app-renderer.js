import {
  applyAuthRouteRedirect,
  renderAuthPendingView as defaultRenderAuthPendingView,
  shouldHoldProtectedRoute,
} from "./auth-route-guard.js";

export function shouldFullRenderOnSessionUpdate(route) {
  return route !== "home" && route !== "files" && route !== "live" && route !== "settings" && route !== "pipelines" && route !== "terminal";
}

export function renderRouteErrorView(route, error) {
  const wrapper = document.createElement("section");
  wrapper.className = "wm-card wm-route-error";
  wrapper.dataset.testid = "route-render-error";
  wrapper.setAttribute("role", "alert");

  const title = document.createElement("h2");
  title.textContent = "This view failed to render";

  const message = document.createElement("p");
  const errorMessage = error instanceof Error ? error.message : String(error ?? "Unknown error");
  message.textContent = `${route || "current"}: ${errorMessage}`;

  wrapper.append(title, message);
  return wrapper;
}

export function createAppRenderer({
  appRoot,
  sessionsStore,
  getCurrentRoute,
  setCurrentRoute,
  sseManager,
  getLiveRefreshController,
  syncLiveRouteTransport,
  syncProjectsNavigationVisibility,
  syncNightWatchNavigationVisibility,
  syncTerminalNavigationVisibility = () => true,
  homeRoute,
  projectsRoute,
  nightwatchRoute,
  terminalRoute = "/terminal",
  captureFocusSnapshot,
  restoreFocusFromSnapshot,
  renderRouteView,
  renderFileEditorOverlay,
  renderWorktreeModal,
  renderAuthPendingView = defaultRenderAuthPendingView,
  focusComposerTextarea,
  setActiveNav,
  syncMenuTabs,
  updateAgentStatusIndicators,
  reconcileLiveSessionUi = () => false,
  updateDocumentTitle,
  isAuthenticated = () => true,
  isAuthResolved = () => true,
}) {
  let renderDebounceTimer = null;
  let isRendering = false;
  let previousRenderRoute = null;
  let previousRenderPath = null;
  const stablePages = new Set(["scheduler", "jobs", "pipelines", "terminal"]);

  function render() {
    if (isRendering) {
      return;
    }

    if (renderDebounceTimer) {
      clearTimeout(renderDebounceTimer);
    }

    renderDebounceTimer = setTimeout(() => {
      isRendering = true;
      try {
        const authenticated = Boolean(isAuthenticated());
        const authResolved = Boolean(isAuthResolved());
        const initialRoute = getCurrentRoute();
        const authPending = shouldHoldProtectedRoute(initialRoute, {
          authenticated,
          authResolved,
        });
        const currentRoute = authPending
          ? initialRoute
          : applyAuthRouteRedirect({
              route: initialRoute,
              authenticated,
              authResolved,
              setCurrentRoute,
              fallbackRoute: "home",
              fallbackPath: homeRoute,
              replaceHistory: true,
            });
        const routeChanged = previousRenderRoute !== currentRoute;
        previousRenderRoute = syncLiveRouteTransport({
          previousRoute: previousRenderRoute,
          currentRoute: authPending ? "home" : currentRoute,
          activeSessionId: authPending ? null : sessionsStore().activeSessionId,
          sseManager,
          liveRefreshController: getLiveRefreshController(),
        });

        const projectsEnabled = syncProjectsNavigationVisibility();
        if (!projectsEnabled && getCurrentRoute() === "projects") {
          setCurrentRoute("home");
          if (window.location.pathname === projectsRoute) {
            window.history.replaceState({ route: "home" }, "", homeRoute);
          }
        }

        const nightwatchEnabled = syncNightWatchNavigationVisibility();
        if (!nightwatchEnabled && getCurrentRoute() === "nightwatch") {
          setCurrentRoute("home");
          if (window.location.pathname === nightwatchRoute) {
            window.history.replaceState({ route: "home" }, "", homeRoute);
          }
        }

        const terminalEnabled = syncTerminalNavigationVisibility();
        if (!terminalEnabled && getCurrentRoute() === "terminal") {
          setCurrentRoute("home");
          if (window.location.pathname === terminalRoute) {
            window.history.replaceState({ route: "home" }, "", homeRoute);
          }
        }

        const resolvedRoute = authPending ? currentRoute : getCurrentRoute();
        const currentPath = window.location.pathname;
        const pathChanged = previousRenderPath !== currentPath;
        const focusSnapshot = captureFocusSnapshot();
        if (!routeChanged && !pathChanged && stablePages.has(resolvedRoute)) {
          setActiveNav();
          syncMenuTabs();
          updateAgentStatusIndicators();
          updateDocumentTitle();
          return;
        }
        previousRenderPath = currentPath;

        appRoot.innerHTML = "";
        try {
          const view = authPending ? renderAuthPendingView() : renderRouteView(resolvedRoute);
          appRoot.append(view);
        } catch (error) {
          console.error("[render] failed to render route", resolvedRoute, error);
          appRoot.append(renderRouteErrorView(resolvedRoute, error));
        }
        if (!authPending) {
          renderFileEditorOverlay();
          renderWorktreeModal();
        }
        appRoot.dataset.route = authPending ? "auth" : resolvedRoute;
        restoreFocusFromSnapshot(focusSnapshot);

        if (!authPending && resolvedRoute === "live" && (!document.activeElement || document.activeElement === document.body)) {
          const textarea = document.querySelector(".wm-composer textarea");
          focusComposerTextarea(textarea, "restore");
        }

        setActiveNav();
        syncMenuTabs();
        updateAgentStatusIndicators();
        if (authPending) {
          document.title = "Wingman";
        } else {
          updateDocumentTitle();
        }
      } finally {
        isRendering = false;
        renderDebounceTimer = null;
      }
    }, 50);
  }

  function handleSessionsStoreItemsChanged() {
    syncMenuTabs();
    const currentRoute = getCurrentRoute();
    if (currentRoute === "live") {
      reconcileLiveSessionUi();
      updateAgentStatusIndicators();
    } else if (shouldFullRenderOnSessionUpdate(currentRoute)) {
      render();
    } else {
      updateAgentStatusIndicators();
    }
  }

  return {
    render,
    handleSessionsStoreItemsChanged,
  };
}
