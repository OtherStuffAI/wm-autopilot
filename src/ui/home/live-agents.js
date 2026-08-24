import {
  createSessionTable,
  formatSessionDirectoryDisplay,
  formatSessionStartedAt,
  getSessionDirectoryValue,
  sortSessions,
} from "./session-table.js";
import {
  countSessionsByHomeGroup,
  filterSessionsForHomeGroup,
  HOME_SESSION_GROUPS,
} from "./session-groups.js";
import { createSessionGroupTabs } from "./session-group-tabs.js";
import { canResumeNativeAgentSession } from "./native-session-resume.js";
import { createBulkCloseAutoSessionsButton } from "./bulk-close-auto-sessions.js";
export { canResumeNativeAgentSession };

function shouldRenderSessionCards() {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 720px)").matches;
}

function renderSessionActions(target, session, deps) {
  const {
    getSessionPendingAction,
    isSessionActionPending,
    isSessionActive,
    resumeSession,
    resumeNativeSession,
    stopSession,
    deleteSession,
    withPendingSessionAction,
  } = deps;

  const pendingAction = getSessionPendingAction(session.id);
  const pending = isSessionActionPending(session.id);

  const resumeBtn = document.createElement("button");
  resumeBtn.className = "wm-button";
  resumeBtn.textContent = "View";
  resumeBtn.disabled = pending;
  resumeBtn.setAttribute("aria-label", `View session ${session.name || session.id}`);
  resumeBtn.addEventListener("click", () => resumeSession(session.id));
  target.append(resumeBtn);

  if (isSessionActive(session)) {
    const stopBtn = document.createElement("button");
    stopBtn.className = "wm-button secondary";
    if (pendingAction) {
      stopBtn.textContent = "Stopping…";
      stopBtn.dataset.state = "loading";
      stopBtn.setAttribute("aria-busy", "true");
    } else {
      stopBtn.textContent = "Stop";
    }
    stopBtn.disabled = pending;
    stopBtn.addEventListener("click", () => {
      void withPendingSessionAction(session.id, "stop", async () => {
        await stopSession(session.id);
      });
    });
    target.append(stopBtn);
    return;
  }

  if (canResumeNativeAgentSession(session)) {
    const nativeResumeBtn = document.createElement("button");
    nativeResumeBtn.className = "wm-button";
    nativeResumeBtn.textContent = "Resume";
    nativeResumeBtn.disabled = pending;
    nativeResumeBtn.setAttribute("aria-label", `Resume agent session for ${session.name || session.id}`);
    nativeResumeBtn.dataset.testid = "resume-native-session";
    nativeResumeBtn.addEventListener("click", () => {
      void withPendingSessionAction(session.id, "resume-native", async () => {
        await resumeNativeSession(session.id);
      });
    });
    target.append(nativeResumeBtn);
  }

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "wm-button secondary";
  if (pendingAction) {
    deleteBtn.textContent = pendingAction === "stop"
      ? "Stopping…"
      : pendingAction === "resume-native"
        ? "Resuming…"
        : "Deleting…";
    deleteBtn.dataset.state = "loading";
    deleteBtn.setAttribute("aria-busy", "true");
  } else {
    deleteBtn.textContent = "Delete";
  }
  deleteBtn.disabled = pending;
  deleteBtn.addEventListener("click", () => {
    void withPendingSessionAction(session.id, "delete", async () => {
      await deleteSession(session.id);
    });
  });
  target.append(deleteBtn);
}

function createSessionCards(orderedSessions, deps) {
  const {
    state,
    createAgentStatusIndicator,
    getSessionDisplayName,
    promptRenameSession,
    isSessionActionPending,
    emptyLabel = 'No active sessions',
  } = deps;

  const cardsContainer = document.createElement("div");
  cardsContainer.className = "session-card-list";

  if (orderedSessions.length === 0) {
    const emptyCard = document.createElement("article");
    emptyCard.className = "session-card empty";
    emptyCard.textContent = emptyLabel;
    cardsContainer.append(emptyCard);
    return cardsContainer;
  }

  orderedSessions.forEach((session) => {
    const card = document.createElement("article");
    card.className = "session-card";

    const header = document.createElement("header");
    header.className = "session-card-header";

    const title = document.createElement("h3");
    title.textContent = getSessionDisplayName(session);

    const statusContainer = document.createElement("div");
    statusContainer.className = "session-status-container";

    const statusIndicator = createAgentStatusIndicator(session.id);
    statusIndicator.className += " status-small";

    const status = document.createElement("span");
    status.className = `session-status ${session.status}`;
    status.textContent = session.status;
    statusContainer.append(statusIndicator, status);

    const headerActions = document.createElement("div");
    headerActions.className = "session-card-header-actions";

    const editLink = document.createElement("button");
    editLink.type = "button";
    editLink.className = "wm-link-button session-card-edit";
    editLink.textContent = "Edit name";
    editLink.disabled = isSessionActionPending(session.id);
    editLink.addEventListener("click", (event) => {
      event.preventDefault();
      promptRenameSession(session);
    });

    headerActions.append(statusContainer, editLink);
    header.append(title, headerActions);
    card.append(header);

    const details = document.createElement("div");
    details.className = "session-card-details";

    function addDetail(label, value, title = value) {
      const item = document.createElement("div");
      item.className = "session-card-detail";

      const term = document.createElement("span");
      term.className = "session-card-detail-label";
      term.textContent = label;

      const desc = document.createElement("span");
      desc.className = "session-card-detail-value";
      desc.textContent = value ?? "-";
      if (title && title !== "-") {
        desc.title = title;
      }

      item.append(term, desc);
      details.append(item);
    }

    const directoryValue = getSessionDirectoryValue(session, state.config?.defaultDirectory);
    addDetail("Started", formatSessionStartedAt(session.startedAt));
    addDetail("Last updated", formatSessionStartedAt(session.lastUpdatedAt));
    addDetail("Directory", formatSessionDirectoryDisplay(directoryValue), directoryValue);
    addDetail("Agent", session.agent);
    card.append(details);

    const actionRow = document.createElement("div");
    actionRow.className = "session-card-actions";
    renderSessionActions(actionRow, session, deps);
    card.append(actionRow);

    cardsContainer.append(card);
  });

  return cardsContainer;
}

export function createLiveAgentsSection(deps) {
  const {
    state,
    sessionsStore,
    getCurrentRoute,
    render,
    openDialog,
    buildSessionFilterOptions,
    fetchSessions,
    bulkCloseStaleAutoSessions,
    openConfirmDialog,
    syncMenuTabs,
    sessionSort,
    onSessionSortChange,
    sessionGroup,
    onSessionGroupChange,
    collapsible = true,
  } = deps;

  const liveCard = document.createElement("section");
  liveCard.className = "wm-card wm-home-live wm-home-quadrant";
  liveCard.dataset.collapsible = String(collapsible);

  const liveHeader = document.createElement("div");
  liveHeader.className = "wm-home-section-header wm-home-quadrant__header";
  if (collapsible) {
    liveHeader.setAttribute("role", "button");
    liveHeader.setAttribute("tabindex", "0");
  }

  const titleWrap = document.createElement("span");
  titleWrap.className = "wm-home-quadrant__title";

  const liveTitle = document.createElement("h2");
  liveTitle.textContent = "Live Sessions";

  const groupCounts = countSessionsByHomeGroup(sessionsStore().items);
  const totalCount = Object.values(groupCounts).reduce((sum, count) => sum + Number(count ?? 0), 0);
  const badge = document.createElement("span");
  badge.className = "wm-home-quadrant__badge";
  badge.textContent = String(totalCount);
  badge.setAttribute("aria-label", `${totalCount} live session${totalCount === 1 ? "" : "s"}`);
  titleWrap.append(liveTitle, badge);

  const collapseIcon = document.createElement("span");
  collapseIcon.className = "wm-home-quadrant__collapse";
  collapseIcon.setAttribute("aria-hidden", "true");
  collapseIcon.textContent = "▼";

  const liveContent = document.createElement("div");
  liveContent.className = "wm-home-live-content";
  liveContent.id = "live-agents-content";

  function setCollapsed(collapsed) {
    if (collapsed) {
      liveCard.dataset.collapsed = "true";
      liveContent.hidden = true;
      liveHeader.setAttribute("aria-expanded", "false");
      return;
    }
    delete liveCard.dataset.collapsed;
    liveContent.hidden = false;
    liveHeader.setAttribute("aria-expanded", "true");
  }

  if (collapsible) {
    liveHeader.addEventListener("click", () => {
      const currentlyCollapsed = liveCard.dataset.collapsed === "true";
      setCollapsed(!currentlyCollapsed);
    });
    liveHeader.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      const currentlyCollapsed = liveCard.dataset.collapsed === "true";
      setCollapsed(!currentlyCollapsed);
    });
  }

  liveHeader.append(titleWrap);
  if (collapsible) {
    liveHeader.append(collapseIcon);
  }
  liveCard.append(liveHeader);

  const actions = document.createElement("div");
  actions.className = "wm-actions";

  if (state.identity.isAdmin) {
    const filterContainer = document.createElement("div");
    filterContainer.className = "wm-session-filter";

    const filterLabel = document.createElement("label");
    filterLabel.textContent = "Identities";

    const filterSelect = document.createElement("select");
    filterSelect.className = "wm-select";
    buildSessionFilterOptions().forEach((option) => {
      const opt = document.createElement("option");
      opt.value = option.value;
      opt.textContent = option.label;
      if (option.value === sessionsStore().filters.npub) {
        opt.selected = true;
      }
      filterSelect.append(opt);
    });
    filterSelect.addEventListener("change", (event) => {
      const target = event.target;
      const value = target instanceof HTMLSelectElement && target.value ? target.value : "all";
      const store = sessionsStore();
      store.filters.npub = value;
      store.filters.initialized = true;
      void fetchSessions().then(() => {
        syncMenuTabs();
        const route = getCurrentRoute();
        if (route === "home" || route === "live") {
          render();
        }
      });
    });

    filterLabel.append(filterSelect);
    filterContainer.append(filterLabel);
    actions.append(filterContainer);
  }

  const launchBtn = document.createElement("button");
  launchBtn.className = "wm-button";
  launchBtn.textContent = "Launch Agent Session";
  launchBtn.addEventListener("click", openDialog);
  actions.append(launchBtn);

  actions.append(createBulkCloseAutoSessionsButton({
    closeSessions: bulkCloseStaleAutoSessions,
    confirmClose: openConfirmDialog,
    refreshSessions: fetchSessions,
    showToast: deps.showToast,
  }));

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "wm-button secondary";
  refreshBtn.textContent = "Refresh";
  refreshBtn.title = "Refresh sessions";
  refreshBtn.addEventListener("click", () => {
    void fetchSessions();
  });
  actions.append(refreshBtn);

  const activeGroup = HOME_SESSION_GROUPS.some((group) => group.id === sessionGroup)
    ? sessionGroup
    : HOME_SESSION_GROUPS[0].id;
  const activeGroupDef =
    HOME_SESSION_GROUPS.find((group) => group.id === activeGroup) ?? HOME_SESSION_GROUPS[0];
  const groupedSessions = filterSessionsForHomeGroup(sessionsStore().items, activeGroup);
  const orderedSessions = sortSessions(groupedSessions, sessionSort, {
    getSessionDisplayName: deps.getSessionDisplayName,
    isSessionActive: deps.isSessionActive,
    defaultDirectory: state.config?.defaultDirectory,
  });

  const groupTabs = createSessionGroupTabs(activeGroup, groupCounts, onSessionGroupChange);
  const renderCards = shouldRenderSessionCards();

  liveContent.append(groupTabs, actions);
  if (renderCards) {
    liveContent.append(
      createSessionCards(orderedSessions, {
        ...deps,
        emptyLabel: activeGroupDef.emptyLabel,
      }),
    );
  } else {
    const tableContainer = document.createElement("div");
    tableContainer.className = "wm-table-container session-table-wrapper";
    tableContainer.append(
      createSessionTable(orderedSessions, {
        ...deps,
        renderSessionActions: (target, session) => renderSessionActions(target, session, deps),
        emptyLabel: activeGroupDef.emptyLabel,
      }),
    );
    liveContent.append(tableContainer);
  }
  liveCard.append(liveContent);

  setCollapsed(false);
  return liveCard;
}
