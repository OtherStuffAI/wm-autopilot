/**
 * Home view renderer — guest landing, running apps table,
 * live agents session list, and archive component.
 *
 * Depends on: state, identity, session/app helpers, navigation (via DI).
 */

import { createArchiveComponent } from "../home/archive.js";
import { createLiveAgentsSection } from "../home/live-agents.js";
import { createRunningPipelinesSection } from "../home/running-pipelines.js";
import { createFlightDeckDispatchView } from "../fd-dispatch/view.js";
import { DEFAULT_LIVE_SESSION_SORT } from "../home/session-table.js";
import { HOME_SESSION_GROUPS } from "../home/session-groups.js";

export const HOME_TABS = Object.freeze([
  { id: "sessions", label: "Sessions" },
  { id: "pipelines", label: "Pipelines" },
  { id: "apps", label: "Apps" },
  { id: "archive", label: "Archive" },
  { id: "fd-dispatch", label: "FD Dispatch" },
]);

export const DEFAULT_HOME_TAB_ID = HOME_TABS[0].id;

export function createHomeTabContent(activeTab, factories) {
  const factory = factories[activeTab];
  if (typeof factory !== "function") {
    throw new Error(`Home tab content factory is missing for ${activeTab}.`);
  }
  return factory();
}

export function initHomeView(deps) {
  const {
    state,
    sessionsStore,
    getCurrentRoute,
    setCurrentRoute,
    render,
    // Navigation
    openIdentityLoginDialog,
    renderApps,
    openDialog,
    ensureFeatureFlagsLoaded,
    isFeatureEnabledForViewer,
    // Session helpers
    isSessionActive,
    resumeSession,
    resumeNativeSession,
    stopSession,
    deleteSession,
    promptRenameSession,
    getSessionDisplayName,
    createAgentStatusIndicator,
    buildSessionFilterOptions,
    fetchSessions,
    bulkCloseStaleAutoSessions,
    openConfirmDialog,
    syncMenuTabs,
    showToast,
    // Utilities
    escapeHtml,
    // Constants
    PRIVACY_ROUTE,
    LIVE_ROUTE_PREFIX,
  } = deps;

  let archiveComponent = null;
  let liveSessionSort = { ...DEFAULT_LIVE_SESSION_SORT };
  let liveSessionGroup = HOME_SESSION_GROUPS[0]?.id ?? 'my';
  let activeHomeTab = DEFAULT_HOME_TAB_ID;
  const sessionActionPending = new Map();

  function getSessionPendingAction(sessionId) {
    if (!sessionId || typeof sessionId !== "string") {
      return null;
    }
    return sessionActionPending.get(sessionId) ?? null;
  }

  function isSessionActionPending(sessionId) {
    return Boolean(getSessionPendingAction(sessionId));
  }

  function rerenderHomeIfVisible() {
    if (getCurrentRoute() === "home") {
      render();
    }
  }

  function setSessionActionPending(sessionId, action) {
    if (!sessionId || typeof sessionId !== "string") {
      return;
    }
    if (!action) {
      sessionActionPending.delete(sessionId);
    } else {
      sessionActionPending.set(sessionId, action);
    }
    rerenderHomeIfVisible();
  }

  async function withPendingSessionAction(sessionId, action, callback) {
    if (isSessionActionPending(sessionId)) {
      return;
    }
    setSessionActionPending(sessionId, action);
    try {
      await callback();
    } finally {
      setSessionActionPending(sessionId, null);
    }
  }
  // ── Main renderer ──────────────────────────────────────────────

  const renderHome = () => {
    const wrapper = document.createElement("div");
    wrapper.className = "wm-home";

    if (!state.identity.authenticated) {
      wrapper.className = "wm-home wm-home-guest-landing";

      const content = document.createElement("div");
      content.className = "wm-home-guest-content";

      const heroText = document.createElement("div");
      heroText.className = "wm-home-guest-hero-text";

      const line1 = document.createElement("div");
      line1.className = "wm-home-guest-hero-line";
      line1.textContent = "YOU";

      const line2 = document.createElement("div");
      line2.className = "wm-home-guest-hero-line";
      line2.textContent = "CAN JUST";

      const line3 = document.createElement("div");
      line3.className = "wm-home-guest-hero-line";
      line3.textContent = "DO THINGS!";

      heroText.append(line1, line2, line3);

      const loginButton = document.createElement("button");
      loginButton.type = "button";
      loginButton.className = "wm-home-guest-login-button";
      loginButton.textContent = "LOG IN";
      loginButton.addEventListener("click", () => {
        openIdentityLoginDialog();
      });

      content.append(heroText, loginButton);

      const footer = document.createElement("footer");
      footer.className = "wm-home-guest-footer";

      const footerText = document.createElement("p");
      footerText.textContent = "Manage your own business - ";

      const footerLink = document.createElement("a");
      footerLink.href = "https://primal.net/pw";
      footerLink.textContent = "pw21";
      footerLink.target = "_blank";
      footerLink.rel = "noopener noreferrer";

      footerText.append(footerLink);

      const footerLinks = document.createElement("div");
      footerLinks.className = "wm-home-guest-footer__links";
      const privacyLink = document.createElement("a");
      privacyLink.href = PRIVACY_ROUTE;
      privacyLink.textContent = "Privacy Policy";
      privacyLink.addEventListener("click", (e) => {
        e.preventDefault();
        setCurrentRoute("privacy");
        window.history.pushState({ route: "privacy" }, "", PRIVACY_ROUTE);
        render();
      });
      footerLinks.append(privacyLink);

      footer.append(footerText, footerLinks);

      wrapper.append(content, footer);
      return wrapper;
    }

    ensureFeatureFlagsLoaded();

    const tabShell = document.createElement("section");
    tabShell.className = "wm-home-tabs";
    tabShell.dataset.testid = "home-tabs";

    const tabList = document.createElement("div");
    tabList.className = "wm-home-tabs__list";
    tabList.setAttribute("role", "tablist");
    tabList.setAttribute("aria-label", "Home sections");

    const activeTab = HOME_TABS.some((tab) => tab.id === activeHomeTab)
      ? activeHomeTab
      : DEFAULT_HOME_TAB_ID;
    activeHomeTab = activeTab;

    HOME_TABS.forEach((tab) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wm-home-tabs__tab";
      button.textContent = tab.label;
      button.dataset.testid = `home-tab-${tab.id}`;
      button.id = `home-tab-${tab.id}-button`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", tab.id === activeTab ? "true" : "false");
      button.setAttribute("aria-controls", "home-tab-panel");
      if (tab.id === activeTab) {
        button.classList.add("is-active");
      }
      button.addEventListener("click", () => {
        activeHomeTab = tab.id;
        rerenderHomeIfVisible();
      });
      tabList.append(button);
    });

    const panel = document.createElement("div");
    panel.id = "home-tab-panel";
    panel.className = "wm-home-tabs__panel";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `home-tab-${activeTab}-button`);
    panel.dataset.testid = "home-tab-panel";

    const createArchiveSection = () => {
      archiveComponent = createArchiveComponent({
        titleText: "Archive Sessions",
        defaultCollapsed: false,
        collapsible: false,
        onViewSession: (session) => {
          const targetPath = `${LIVE_ROUTE_PREFIX}/${session.id}`;
          window.history.pushState({ route: "live", sessionId: session.id }, "", targetPath);
          setCurrentRoute("live");
          render();
        },
        resumeNativeSession,
        getSessionPendingAction,
        isSessionActionPending,
        withPendingSessionAction,
      });
      archiveComponent.element.classList.add("wm-home-quadrant");
      return archiveComponent.element;
    };

    const createLiveSessionsSection = () => createLiveAgentsSection({
        state,
        sessionsStore,
        getCurrentRoute,
        render,
        openDialog,
        isSessionActive,
        resumeSession,
        resumeNativeSession,
        stopSession,
        deleteSession,
        promptRenameSession,
        getSessionDisplayName,
        createAgentStatusIndicator,
        buildSessionFilterOptions,
        fetchSessions,
        bulkCloseStaleAutoSessions,
        openConfirmDialog,
        syncMenuTabs,
        showToast,
        escapeHtml,
        getSessionPendingAction,
        isSessionActionPending,
        withPendingSessionAction,
        collapsible: false,
        sessionSort: liveSessionSort,
        onSessionSortChange(nextSort) {
          liveSessionSort = nextSort;
          rerenderHomeIfVisible();
        },
        sessionGroup: liveSessionGroup,
        onSessionGroupChange(nextGroup) {
          liveSessionGroup = nextGroup;
          rerenderHomeIfVisible();
        },
      });
    const createAppsSection = () => renderApps();
    const createPipelinesSection = () => createRunningPipelinesSection({
        showToast,
        isFeatureEnabledForViewer,
        collapsible: false,
      }).element;

    panel.append(createHomeTabContent(activeTab, {
      sessions: createLiveSessionsSection,
      pipelines: createPipelinesSection,
      apps: createAppsSection,
      archive: createArchiveSection,
      "fd-dispatch": createFlightDeckDispatchView,
    }));

    tabShell.append(tabList, panel);
    wrapper.append(tabShell);

    return wrapper;
  };

  return { renderHome };
}
