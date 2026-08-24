import { fetchConfigApi, normaliseConnectRelays } from "../services/config.js";
import { fetchSessionLogsApi, fetchSessionMessagesApi } from "../services/sessions.js";

export function buildSessionFilterOptions({
  isAdmin,
  viewerNpub,
  filterOptions,
  abbreviateNpub,
}) {
  const seen = new Set();
  const options = [];

  function appendOption(value, label, meta = {}) {
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label, ...meta });
  }

  if (isAdmin && viewerNpub) {
    appendOption(viewerNpub, `My identity (${abbreviateNpub(viewerNpub)})`, { npub: viewerNpub });
  }

  appendOption("all", "All identities");

  for (const option of filterOptions) {
    if (!option || typeof option !== "object") continue;
    const value = typeof option.value === "string" ? option.value : "__anonymous__";
    const npub = typeof option.npub === "string" ? option.npub : null;
    const baseLabel =
      typeof option.label === "string" && option.label.trim().length > 0
        ? option.label.trim()
        : npub ?? "Anonymous";
    const sessionCount = typeof option.sessionCount === "number" ? option.sessionCount : 0;
    const activeCount = typeof option.activeCount === "number" ? option.activeCount : 0;
    const detail = activeCount > 0 ? `${sessionCount} sessions (${activeCount} active)` : `${sessionCount} sessions`;
    appendOption(value, `${baseLabel} • ${detail}`, { npub, sessionCount, activeCount });
  }

  return options;
}

export function initSessionRuntimeSync({
  state,
  sessionsStore,
  agentSelect,
  directoryInput,
  getCurrentRoute,
  setCurrentRoute,
  homeRoute,
  getSessionIdFromPath,
  normaliseNpubValue,
  abbreviateNpub,
  syncFeatureFlagsFromConfig,
  updateIdentityState,
  scheduleDirectorySuggestions,
  MessageStore,
  isAlpineChatEnabled,
  scrollPillIsNearBottom,
  scrollPillShow,
  updateLogsDOM,
  updateConversationDOM,
  fetchSessionQueue,
  applyRouteSessionFromPath,
  ensureActiveSession,
  applyBranding,
}) {
  const conversationSelectionState = {
    pointerDownInConversation: false,
    locked: false,
  };

  async function fetchConfig() {
    const configData = await fetchConfigApi();
    const adminNpubNormalized = normaliseNpubValue(configData?.adminNpub ?? null);
    const adminNpubs = Array.isArray(configData?.adminNpubs)
      ? configData.adminNpubs.map((npub) => normaliseNpubValue(npub)).filter(Boolean)
      : adminNpubNormalized
        ? [adminNpubNormalized]
        : [];
    const connectRelays = normaliseConnectRelays(configData?.connectRelays);
    const agents = Array.isArray(configData?.agents)
      ? configData.agents.filter((agent) => agent && typeof agent.id === "string" && typeof agent.label === "string")
      : [];
    state.config = { ...configData, adminNpub: adminNpubNormalized ?? null, adminNpubs, connectRelays, agents };
    applyBranding?.(state.config.branding);

    if (typeof globalThis !== "undefined" && globalThis.wingmanIdentity) {
      globalThis.wingmanIdentity.connectRelays = connectRelays;
    }
    if (Array.isArray(configData?.featureFlags)) {
      syncFeatureFlagsFromConfig(configData.featureFlags);
    }

    agentSelect.innerHTML = "";
    agents.forEach((agent) => {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.label;
      agentSelect.append(option);
    });

    const defaultAgentId = state.config.defaultAgent ?? "codex";
    if (agents.some((agent) => agent.id === defaultAgentId)) {
      agentSelect.value = defaultAgentId;
    }

    if (directoryInput) {
      const initial = state.lastWorkingDirectory ?? state.config.defaultDirectory ?? "";
      directoryInput.value = initial;
      directoryInput.placeholder = state.config.defaultDirectory ?? "";
      scheduleDirectorySuggestions(initial);
    }

    updateIdentityState({ npub: state.identity.npub }, { persist: false, emit: true });
  }

  async function fetchSessions(options = {}) {
    const { waitForActiveSessionDetails = true } = options;
    const sessionState = sessionsStore();
    await sessionState.sync();

    if (sessionState.items.length === 0 && !sessionState.initialized) {
      if (getCurrentRoute() !== "home") {
        setCurrentRoute("home");
        if (window.location.pathname !== homeRoute) {
          window.history.replaceState({ route: "home" }, "", homeRoute);
        }
      }
      return;
    }

    const allSessions = sessionState.items;
    const sessionIds = new Set(allSessions.map((session) => session.id));
    const lastId = sessionState.lastActiveSessionId;
    if (lastId && !sessionIds.has(lastId)) {
      sessionState.lastActiveSessionId = null;
    }

    cleanupDeletedSessionState(sessionIds);

    const routeSessionId = getSessionIdFromPath(window.location.pathname);
    const allowHistoryUpdate = getCurrentRoute() === "live" && !routeSessionId;
    applyRouteSessionFromPath({ allowHistoryUpdate });
    ensureActiveSession();

    const activeId = sessionState.activeSessionId;

    if (getCurrentRoute() === "live" && activeId) {
      const activeSessionDetails = Promise.all([
        fetchLogs(activeId),
        fetchConversation(activeId),
        fetchSessionQueue(activeId),
      ]);
      if (waitForActiveSessionDetails) {
        await activeSessionDetails;
      } else {
        void activeSessionDetails.catch((error) => {
          console.warn("[sessions] failed to hydrate active session details:", error);
        });
      }
    }
  }

  function getSessionFilterOptions() {
    return buildSessionFilterOptions({
      isAdmin: Boolean(state.identity.isAdmin),
      viewerNpub: normaliseNpubValue(state.identity.npub),
      filterOptions: sessionsStore().filters.options,
      abbreviateNpub,
    });
  }

  async function fetchLogs(sessionId) {
    const data = await fetchSessionLogsApi(sessionId);
    if (!data) return;
    state.logs.set(sessionId, data.logs);

    if (getCurrentRoute() === "live" && sessionId === sessionsStore().activeSessionId) {
      updateLogsDOM(sessionId);
    }
  }

  function isConversationSelectionInsideLiveChat() {
    const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return false;
    }
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const anchorEl = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement ?? null;
    const focusEl = focusNode instanceof Element ? focusNode : focusNode?.parentElement ?? null;
    const anchorInConversation = Boolean(anchorEl?.closest?.(".wm-live-conversation .wm-conversation"));
    const focusInConversation = Boolean(focusEl?.closest?.(".wm-live-conversation .wm-conversation"));
    return anchorInConversation || focusInConversation;
  }

  function isConversationRenderLocked(sessionId) {
    return (
      conversationSelectionState.locked &&
      getCurrentRoute() === "live" &&
      sessionId === sessionsStore().activeSessionId
    );
  }

  async function renderConversationForSession(sessionId, options = {}) {
    const { isStreamingUpdate = false } = options;
    if (isConversationRenderLocked(sessionId)) {
      return;
    }
    if (isAlpineChatEnabled()) {
      if (getCurrentRoute() === "live" && sessionId === sessionsStore().activeSessionId) {
        if (!scrollPillIsNearBottom() && !isStreamingUpdate) {
          scrollPillShow();
        }
      }
      return;
    }
    if (getCurrentRoute() === "live" && sessionId === sessionsStore().activeSessionId) {
      const wasNearBottom = scrollPillIsNearBottom();
      await updateConversationDOM(sessionId);
      if (!wasNearBottom && !isStreamingUpdate) {
        scrollPillShow();
      }
    }
  }

  function flushConversationRenderLock() {
    const activeSessionId = sessionsStore().activeSessionId;
    if (!activeSessionId) {
      return;
    }
    void renderConversationForSession(activeSessionId);
  }

  function setupConversationSelectionLock() {
    document.addEventListener("mousedown", (event) => {
      const target = event.target;
      conversationSelectionState.pointerDownInConversation = Boolean(
        target instanceof Element && target.closest(".wm-live-conversation .wm-conversation"),
      );
    });
    document.addEventListener("mouseup", () => {
      conversationSelectionState.pointerDownInConversation = false;
      const shouldLock = isConversationSelectionInsideLiveChat();
      const wasLocked = conversationSelectionState.locked;
      conversationSelectionState.locked = shouldLock;
      if (wasLocked && !shouldLock) {
        flushConversationRenderLock();
      }
    });
    document.addEventListener("selectionchange", () => {
      const shouldLock =
        conversationSelectionState.pointerDownInConversation && isConversationSelectionInsideLiveChat();
      const wasLocked = conversationSelectionState.locked;
      conversationSelectionState.locked = shouldLock;
      if (wasLocked && !shouldLock) {
        flushConversationRenderLock();
      }
    });
  }

  async function fetchConversation(sessionId) {
    try {
      const data = await fetchSessionMessagesApi(sessionId);
      if (!data) return;
      const items = Array.isArray(data?.messages) ? data.messages : [];
      const { changed } = await MessageStore.syncFromServerIfChanged(sessionId, items);
      if (!changed) {
        return;
      }
      await renderConversationForSession(sessionId);
    } catch (error) {
      console.error("Failed to load conversation", error);
    }
  }

  return {
    fetchConfig,
    fetchSessions,
    buildSessionFilterOptions: getSessionFilterOptions,
    fetchLogs,
    renderConversationForSession,
    setupConversationSelectionLock,
    fetchConversation,
  };

  function cleanupDeletedSessionState(sessionIds) {
    for (const key of Array.from(state.logs.keys())) {
      if (!sessionIds.has(key)) state.logs.delete(key);
    }
    for (const key of Array.from(state.messageDrafts.keys())) {
      if (!sessionIds.has(key)) state.messageDrafts.delete(key);
    }
    for (const key of Array.from(state.conversationContainers.keys())) {
      if (!sessionIds.has(key)) state.conversationContainers.delete(key);
    }
    for (const key of Array.from(state.logContainers.keys())) {
      if (!sessionIds.has(key)) state.logContainers.delete(key);
    }
    for (const key of Array.from(state.lastMessageCount.keys())) {
      if (!sessionIds.has(key)) state.lastMessageCount.delete(key);
    }
    for (const key of Array.from(state.liveMessageWindows.keys())) {
      if (!sessionIds.has(key)) state.liveMessageWindows.delete(key);
    }
    for (const key of Array.from(state.lastLogLength.keys())) {
      if (!sessionIds.has(key)) state.lastLogLength.delete(key);
    }
    for (const key of Array.from(state.promptQueues.keys())) {
      if (!sessionIds.has(key)) state.promptQueues.delete(key);
    }
  }
}
