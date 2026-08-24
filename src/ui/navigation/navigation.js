/**
 * Navigation module.
 *
 * Extracted from app.js. Provides the six navigateTo* functions and
 * a setupNavListeners function that wires up all nav-related DOM event
 * listeners. Uses dependency injection so callers supply all external
 * references.
 *
 * @param {object} deps
 * @param {Function} deps.closeMenu                       - closes the hamburger menu
 * @param {Function} deps.closeIdentityLoginDialog        - closes the identity login dialog
 * @param {Function} deps.openIdentityLoginDialog         - opens the identity login dialog
 * @param {Function} deps.deactivateLiveSessionRefresh    - tears down live session refresh when leaving /live
 * @param {Function} deps.render                          - re-renders the page
 * @param {() => string} deps.getCurrentRoute             - returns the current route string
 * @param {(route: string) => void} deps.setCurrentRoute  - sets the current route string
 * @param {() => string|null} deps.getLastLoggedSessionId - returns lastLoggedSessionId
 * @param {(id: string|null) => void} deps.setLastLoggedSessionId - sets lastLoggedSessionId
 * @param {() => object} deps.appsStore                   - lazy accessor for Alpine apps store
 * @param {() => object} deps.sessionsStore               - lazy accessor for sessions store
 * @param {Function} deps.setActiveSession                - sets active session
 * @param {object} deps.state                             - global UI state object
 * @param {Function} deps.showToast                       - displays a toast notification
 * @param {Function} deps.projectsFeatureEnabledForViewer - feature flag: projects visible
 * @param {Function} deps.isFeatureEnabledForViewer       - generic feature flag checker
 * @param {object|null} deps.projectFeature               - project feature module (may be null)
 * @param {Function} deps.ensureNightWatchPageLoaded      - lazy loader for night watch page
 * @param {Function} deps.ensureSchedulerPageLoaded       - lazy loader for scheduler page
 * @param {Function} deps.ensurePipelinesPageLoaded       - lazy loader for pipelines page
 * @param {Function} deps.loadFilesTree                   - loads the files tree
 * @param {Function} deps.updateFilesUrl                  - updates the URL for the files view
 * @param {Function} deps.getActiveSessionForIndicator    - returns the active session for the indicator
 * @param {string} deps.HOME_ROUTE                        - route path constant
 * @param {string} deps.APPS_ROUTE                        - route path constant
 * @param {string} deps.PROJECTS_ROUTE                    - route path constant
 * @param {string} deps.NIGHTWATCH_ROUTE                  - route path constant
 * @param {string} deps.TRIGGERS_ROUTE                    - route path constant
 * @param {string} deps.SCHEDULER_ROUTE                   - route path constant
 * @param {string} deps.PIPELINES_ROUTE                   - route path constant
 * @param {string} deps.TERMINAL_ROUTE                    - route path constant
 * @param {string} deps.SETTINGS_ROUTE                    - route path constant
 * @param {string} deps.PRIVACY_ROUTE                     - route path constant
 * @param {Element[]} deps.navLinks                       - nav anchor elements with data-route
 * @param {Element|null} deps.menuToggle                  - hamburger menu toggle button
 * @param {Element|null} deps.menuPanel                   - hamburger menu panel element
 * @param {Function} deps.toggleMenu                      - toggles the hamburger menu open/closed
 * @param {() => Function} deps.getHandleIdentityLogout   - getter for the identity logout handler
 *   (resolved lazily so the factory can be called before identity modules are initialised)
 * @param {() => Function} deps.getHandleIdentityCopy    - getter for the copy-active-npub handler
 * @param {() => WeakMap} deps.getIdentityDomEntryByNode - getter for the node→identity-entry WeakMap
 */
export function createNavigation(deps) {
  const {
    closeMenu,
    closeIdentityLoginDialog,
    openIdentityLoginDialog,
    deactivateLiveSessionRefresh,
    render,
    getCurrentRoute,
    setCurrentRoute,
    setLastLoggedSessionId,
    appsStore,
    sessionsStore,
    setActiveSession,
    state,
    showToast,
    projectsFeatureEnabledForViewer,
    isFeatureEnabledForViewer,
    projectFeature,
    ensureNightWatchPageLoaded,
    ensureSchedulerPageLoaded,
    ensurePipelinesPageLoaded,
    loadFilesTree,
    updateFilesUrl,
    getActiveSessionForIndicator,
    HOME_ROUTE,
    APPS_ROUTE,
    PROJECTS_ROUTE,
    NIGHTWATCH_ROUTE,
    TRIGGERS_ROUTE,
    SCHEDULER_ROUTE,
    PIPELINES_ROUTE,
    TERMINAL_ROUTE,
    SETTINGS_ROUTE,
    PRIVACY_ROUTE,
    navLinks,
    menuToggle,
    menuPanel,
    toggleMenu,
    getHandleIdentityLogout,
    getHandleIdentityCopy,
    getIdentityDomEntryByNode,
  } = deps;

  function navigateToHome({ replaceHistory = false, skipMenuClose = false } = {}) {
    if (!skipMenuClose) {
      closeMenu();
    }
    closeIdentityLoginDialog();
    deactivateLiveSessionRefresh();
    setCurrentRoute("home");
    setLastLoggedSessionId(null);
    if (replaceHistory) {
      window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
    } else if (window.location.pathname !== HOME_ROUTE) {
      window.history.pushState({ route: "home" }, "", HOME_ROUTE);
    }
    render();
  }

  function navigateToApps({ openNewAppDialog = false, skipMenuClose = false, focusAppId = null } = {}) {
    if (!state.identity.authenticated) {
      openIdentityLoginDialog();
      return;
    }
    if (!skipMenuClose) {
      closeMenu();
    }
    deactivateLiveSessionRefresh();
    if (openNewAppDialog) {
      appsStore().pendingOpenDialog = "create";
    }
    if (focusAppId) {
      appsStore().pendingFocusId = focusAppId;
    }
    setCurrentRoute("apps");
    setLastLoggedSessionId(null);
    if (window.location.pathname !== APPS_ROUTE) {
      window.history.pushState({ route: "apps" }, "", APPS_ROUTE);
    }
    // void ensureAppsLoaded(); // DISABLED
    render();
  }

  function navigateToProjects({ skipMenuClose = false } = {}) {
    if (!state.identity.authenticated) {
      openIdentityLoginDialog();
      return;
    }
    if (!projectsFeatureEnabledForViewer()) {
      showToast?.("Projects are disabled right now", { variant: "info" });
      return;
    }
    if (!skipMenuClose) {
      closeMenu();
    }
    closeIdentityLoginDialog();
    deactivateLiveSessionRefresh();
    setCurrentRoute("projects");
    setLastLoggedSessionId(null);
    if (window.location.pathname !== PROJECTS_ROUTE) {
      window.history.pushState({ route: "projects" }, "", PROJECTS_ROUTE);
    }
    if (projectFeature) {
      void projectFeature.ensureLoaded();
    }
    render();
  }

  function navigateToNightWatch({ skipMenuClose = false } = {}) {
    if (!state.identity.authenticated) {
      openIdentityLoginDialog();
      return;
    }
    if (!state.identity.isAdmin) {
      showToast?.("Night Watchman is admin-only", { variant: "info" });
      return;
    }
    if (!isFeatureEnabledForViewer("nightwatch_enabled")) {
      showToast?.("Night Watchman is disabled", { variant: "info" });
      return;
    }
    if (!skipMenuClose) {
      closeMenu();
    }
    closeIdentityLoginDialog();
    deactivateLiveSessionRefresh();
    setCurrentRoute("nightwatch");
    setLastLoggedSessionId(null);
    if (window.location.pathname !== NIGHTWATCH_ROUTE) {
      window.history.pushState({ route: "nightwatch" }, "", NIGHTWATCH_ROUTE);
    }
    void ensureNightWatchPageLoaded();
    render();
  }

  function navigateToScheduler({ skipMenuClose = false } = {}) {
    if (!state.identity.authenticated) {
      openIdentityLoginDialog();
      return;
    }
    if (!state.identity.isAdmin) {
      showToast?.("Triggers is admin-only", { variant: "info" });
      return;
    }
    if (!skipMenuClose) {
      closeMenu();
    }
    closeIdentityLoginDialog();
    deactivateLiveSessionRefresh();
    setCurrentRoute("scheduler");
    setLastLoggedSessionId(null);
    if (window.location.pathname !== TRIGGERS_ROUTE && window.location.pathname !== SCHEDULER_ROUTE) {
      window.history.pushState({ route: "scheduler" }, "", TRIGGERS_ROUTE);
    }
    void ensureSchedulerPageLoaded();
    render();
  }

  function navigateToPipelines({ skipMenuClose = false } = {}) {
    if (!state.identity.authenticated) {
      openIdentityLoginDialog();
      return;
    }
    if (!skipMenuClose) {
      closeMenu();
    }
    closeIdentityLoginDialog();
    deactivateLiveSessionRefresh();
    setCurrentRoute("pipelines");
    setLastLoggedSessionId(null);
    if (window.location.pathname !== PIPELINES_ROUTE) {
      window.history.pushState({ route: "pipelines" }, "", PIPELINES_ROUTE);
    }
    void ensurePipelinesPageLoaded();
    render();
  }

  function navigateToTerminal({ skipMenuClose = false } = {}) {
    if (!state.identity.authenticated) {
      openIdentityLoginDialog();
      return;
    }
    if (!state.identity.isAdmin) {
      showToast?.("Terminal is admin-only", { variant: "info" });
      return;
    }
    if (state.config?.terminalConfigured !== true) {
      showToast?.("Terminal is disabled until an administrator sets a PIN", { variant: "info" });
      return;
    }
    if (!skipMenuClose) {
      closeMenu();
    }
    closeIdentityLoginDialog();
    deactivateLiveSessionRefresh();
    setCurrentRoute("terminal");
    setLastLoggedSessionId(null);
    if (window.location.pathname !== TERMINAL_ROUTE) {
      window.history.pushState({ route: "terminal" }, "", TERMINAL_ROUTE);
    }
    render();
  }

  function navigateToFiles({ skipMenuClose = false } = {}) {
    if (!state.identity.authenticated) {
      openIdentityLoginDialog();
      return;
    }
    if (!skipMenuClose) {
      closeMenu();
    }
    closeIdentityLoginDialog();
    const activeSession = getCurrentRoute() === "live" ? getActiveSessionForIndicator() : null;
    const sessionDir = activeSession?.workingDirectory;
    deactivateLiveSessionRefresh();
    setCurrentRoute("files");
    setLastLoggedSessionId(null);
    if (!state.files.initialized) {
      state.files.initialized = true;
      void loadFilesTree(sessionDir);
    } else if (sessionDir) {
      void loadFilesTree(sessionDir);
    } else {
      updateFilesUrl({ replace: true });
    }
    render();
  }

  function navigateToSettings({ skipMenuClose = false } = {}) {
    if (!skipMenuClose) {
      closeMenu();
    }
    closeIdentityLoginDialog();
    deactivateLiveSessionRefresh();
    setCurrentRoute("settings");
    setLastLoggedSessionId(null);
    if (window.location.pathname !== SETTINGS_ROUTE) {
      window.history.pushState({ route: "settings" }, "", SETTINGS_ROUTE);
    }
    render();
  }

  function setupNavListeners() {
    navLinks.forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const targetRoute = link.dataset.route;
        if (!targetRoute || targetRoute === getCurrentRoute()) return;
        if (!state.identity.authenticated) {
          openIdentityLoginDialog();
          return;
        }
        closeMenu();
        if (targetRoute === "live") {
          setCurrentRoute("live");
          const ss = sessionsStore();
          const navSessions = ss.items;
          const navActiveId = ss.activeSessionId;
          const navLastId = ss.lastActiveSessionId;
          const hasActive = navActiveId && navSessions.some((session) => session.id === navActiveId);
          const hasLast = navLastId && navSessions.some((session) => session.id === navLastId);
          const targetSessionId = hasActive ? navActiveId : hasLast ? navLastId : null;
          if (targetSessionId) {
            setActiveSession(targetSessionId, { updateHistory: true, forceLog: true });
          } else {
            setActiveSession(null, { updateHistory: true });
          }
        } else if (targetRoute === "apps") {
          navigateToApps({ skipMenuClose: true });
          return;
        } else if (targetRoute === "projects") {
          navigateToProjects({ skipMenuClose: true });
          return;
        } else if (targetRoute === "nightwatch") {
          navigateToNightWatch({ skipMenuClose: true });
          return;
        } else if (targetRoute === "scheduler") {
          navigateToScheduler({ skipMenuClose: true });
          return;
        } else if (targetRoute === "pipelines") {
          navigateToPipelines({ skipMenuClose: true });
          return;
        } else if (targetRoute === "terminal") {
          navigateToTerminal({ skipMenuClose: true });
          return;
        } else if (targetRoute === "files") {
          navigateToFiles({ skipMenuClose: true });
          return;
        } else if (targetRoute === "settings") {
          navigateToSettings({ skipMenuClose: true });
          return;
        } else {
          navigateToHome({ skipMenuClose: true });
          return;
        }
        render();
      });
    });

    // Handle menu footer links (privacy policy, etc.)
    const menuFooterLinks = Array.from(document.querySelectorAll(".wm-menu-footer a[data-route]"));
    menuFooterLinks.forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const targetRoute = link.dataset.route;
        if (!targetRoute || targetRoute === getCurrentRoute()) return;
        closeMenu();
        if (targetRoute === "privacy") {
          setCurrentRoute("privacy");
          if (window.location.pathname !== PRIVACY_ROUTE) {
            window.history.pushState({ route: "privacy" }, "", PRIVACY_ROUTE);
          }
          render();
        }
      });
    });

    if (typeof window !== "undefined") {
      window.navigateToProjects = navigateToProjects;
    }

    menuToggle?.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!state.identity.authenticated) {
        openIdentityLoginDialog();
        return;
      }
      toggleMenu();
    });

    document.addEventListener("click", (event) => {
      if (document.body.dataset.menuOpen === "true") {
        const target = event.target;
        if (target instanceof Node && !menuToggle?.contains(target) && !menuPanel?.contains(target)) {
          closeMenu();
        }
      }

      const clickTarget = event.target;
      if (clickTarget instanceof HTMLElement) {
        if (clickTarget.matches('[data-action="identity-logout"]')) {
          if (!clickTarget.disabled) {
            void getHandleIdentityLogout()(event, getIdentityDomEntryByNode().get(clickTarget) ?? null);
          } else {
            event.preventDefault();
          }
          return;
        }
        if (clickTarget.matches('[data-action="copy-active-npub"]')) {
          void getHandleIdentityCopy()(event, getIdentityDomEntryByNode().get(clickTarget) ?? null);
          return;
        }
      }
    });
  }

  return {
    navigateToHome,
    navigateToApps,
    navigateToProjects,
    navigateToNightWatch,
    navigateToScheduler,
    navigateToPipelines,
    navigateToTerminal,
    navigateToFiles,
    navigateToSettings,
    setupNavListeners,
  };
}
