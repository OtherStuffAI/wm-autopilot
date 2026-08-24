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
    appsStore,
    getCurrentRoute,
    setCurrentRoute,
    render,
    // Navigation
    openIdentityLoginDialog,
    navigateToApps,
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
    // App helpers
    isAppActionDisabled,
    triggerAppAction,
    // Utilities
    escapeHtml,
    // Constants
    APP_STATUS_LABELS,
    APP_ACTION_LABELS,
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

    if (!appsStore().initialized && !appsStore().loading) {
      // void ensureAppsLoaded(); // DISABLED
    }

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
    const createAppsSection = () => createRunningAppsSection({
        appsStore,
        navigateToApps,
        isAppActionDisabled,
        triggerAppAction,
        appStatusLabels: APP_STATUS_LABELS,
        appActionLabels: APP_ACTION_LABELS,
        collapsible: false,
      });
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

export function getHomeRunningApps(apps) {
  return Array.isArray(apps)
    ? apps.filter((app) => app?.status?.status === "running")
    : [];
}

function createRunningAppsSection({
  appsStore,
  navigateToApps,
  isAppActionDisabled,
  triggerAppAction,
  appStatusLabels = {},
  appActionLabels = {},
  collapsible = true,
} = {}) {
  const card = document.createElement("section");
  card.className = "wm-card wm-home-apps wm-home-quadrant";
  card.dataset.collapsible = String(collapsible);
  card.dataset.testid = "home-running-apps";

  const header = document.createElement(collapsible ? "button" : "div");
  if (collapsible) {
    header.type = "button";
  }
  header.className = "wm-home-section-header wm-home-quadrant__header";
  header.setAttribute("aria-expanded", "true");
  header.dataset.testid = "home-running-apps-toggle";

  const titleWrap = document.createElement("span");
  titleWrap.className = "wm-home-quadrant__title";

  const title = document.createElement("h2");
  title.textContent = "Running Apps";

  const badge = document.createElement("span");
  badge.className = "wm-home-quadrant__badge";
  badge.textContent = "0";
  badge.setAttribute("aria-label", "0 running apps");

  titleWrap.append(title, badge);

  const collapseIcon = document.createElement("span");
  collapseIcon.className = "wm-home-quadrant__collapse";
  collapseIcon.setAttribute("aria-hidden", "true");
  collapseIcon.textContent = "▼";
  header.append(titleWrap);
  if (collapsible) {
    header.append(collapseIcon);
  }

  const actions = document.createElement("div");
  actions.className = "wm-home-section-actions wm-home-quadrant__actions";

  const newAppButton = document.createElement("button");
  newAppButton.type = "button";
  newAppButton.className = "wm-button secondary";
  newAppButton.textContent = "New App";
  newAppButton.addEventListener("click", (event) => {
    event.preventDefault();
    navigateToApps?.({ openNewAppDialog: true });
  });
  actions.append(newAppButton);

  const content = document.createElement("div");
  content.className = "wm-home-apps-content wm-home-quadrant__content";

  if (collapsible) {
    header.addEventListener("click", () => {
      const collapsed = card.dataset.collapsed === "true";
      setCollapsed(!collapsed);
    });
  }

  function setCollapsed(collapsed) {
    if (collapsed) {
      card.dataset.collapsed = "true";
      content.hidden = true;
      header.setAttribute("aria-expanded", "false");
      return;
    }
    delete card.dataset.collapsed;
    content.hidden = false;
    header.setAttribute("aria-expanded", "true");
  }

  function render() {
    const store = typeof appsStore === "function" ? appsStore() : {};
    const runningApps = getHomeRunningApps(store.items);
    badge.textContent = String(runningApps.length);
    badge.setAttribute("aria-label", `${runningApps.length} running app${runningApps.length === 1 ? "" : "s"}`);
    content.innerHTML = "";

    if (store.error) {
      content.append(createStatus(store.error));
    } else if (store.loading && !store.initialized) {
      content.append(createStatus("Loading apps..."));
    } else if (runningApps.length === 0) {
      content.append(createStatus("No apps are currently running."));
    } else {
      content.append(createAppsTable(runningApps));
    }
  }

  function createStatus(message) {
    const status = document.createElement("p");
    status.className = "wm-home-apps-status";
    status.textContent = message;
    return status;
  }

  function createAppsTable(runningApps) {
    const table = document.createElement("table");
    table.className = "wm-home-apps-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    ["App", "Status", "Root", "Actions"].forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headerRow.append(th);
    });
    thead.append(headerRow);
    table.append(thead);

    const tbody = document.createElement("tbody");
    runningApps.forEach((app) => {
      tbody.append(createAppRow(app));
    });
    table.append(tbody);
    return table;
  }

  function createAppRow(app) {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    const nameLink = document.createElement("a");
    nameLink.className = "wm-home-apps-link";
    nameLink.textContent = app.label ?? app.id;
    nameLink.href = "/apps";
    nameLink.addEventListener("click", (event) => {
      event.preventDefault();
      navigateToApps?.({ focusAppId: app.id });
    });
    nameCell.append(nameLink);
    row.append(nameCell);

    const statusCell = document.createElement("td");
    const statusValue = app?.status?.status ?? "unknown";
    statusCell.textContent = appStatusLabels[statusValue] ?? statusValue;
    row.append(statusCell);

    const rootCell = document.createElement("td");
    rootCell.textContent = app.root ?? "-";
    rootCell.title = app.root ?? "";
    row.append(rootCell);

    const actionsCell = document.createElement("td");
    actionsCell.className = "wm-home-apps-actions";
    addActionButton(actionsCell, app, "stop");
    addActionButton(actionsCell, app, "restart");
    if (!actionsCell.hasChildNodes()) {
      actionsCell.textContent = "-";
    }
    row.append(actionsCell);

    return row;
  }

  function addActionButton(target, app, action) {
    if (!app.availableScripts?.[action]) return;
    if (app.id === "wingman-core" && action === "stop") return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = action === "stop" ? "wm-button secondary" : "wm-button";
    button.textContent = appActionLabels[action] ?? action;
    button.disabled = isAppActionDisabled?.(app, action) ?? false;
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      const success = await triggerAppAction?.(app.id, action);
      if (!success && button.isConnected) {
        button.disabled = false;
      }
    });
    target.append(button);
  }

  card.append(header, actions, content);
  render();
  setCollapsed(false);
  return card;
}
