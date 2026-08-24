import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createSessionRuntimeActions } from "./runtime-actions.js";

describe("session runtime actions", () => {
  let getSessionById;
  let fetchSessions;
  let fetchSessionApi;
  let fetchConversation;
  let fetchLogs;
  let setCurrentRoute;
  let setActiveSession;
  let render;
  let showToast;
  let state;
  let sessions;
  let renameSessionAction;
  let updateSessionMetadataAction;
  let refreshLiveTabsBar;
  let syncMenuTabs;
  let postSessionMessageApi;
  let addToPromptQueue;
  let updateAgentStatusIndicators;
  let isSessionBusy;
  let sessionMessageSendInFlight;
  let promptQueueStore;
  let messageStore;

  const buildActions = (overrides = {}) =>
    createSessionRuntimeActions({
      state,
      sessionsStore: () => ({ items: sessions }),
      getSessionById,
      getSessionDisplayName: (session) => session?.name ?? session?.id ?? "session",
      fetchSessions,
      fetchSessionApi,
      fetchConversation,
      fetchLogs,
      render,
      setCurrentRoute,
      setActiveSession,
      stopSessionAction: mock(async () => ({ success: true })),
      deleteSessionAction: mock(async () => ({ success: true })),
      renameSessionAction,
      updateSessionMetadataAction,
      resumeNativeSessionAction: mock(async () => ({ session: { id: "native-session-1" } })),
      openTextPromptDialog: mock(async () => null),
      refreshLiveTabsBar,
      syncMenuTabs,
      showToast,
      postSessionMessageApi,
      updateIdentityState: mock(() => {}),
      isSessionBusy,
      addToPromptQueue,
      updateAgentStatusIndicators,
      renderConversationForSession: mock(async () => {}),
      scrollPillHide: mock(() => {}),
      scrollConversationAreaToBottom: mock(() => {}),
      sessionMessageSendInFlight,
      focusComposerTextarea: mock(() => {}),
      isAlpineChatEnabled: () => false,
      MessageStore: messageStore,
      PromptQueueStore: promptQueueStore,
      prepareVoiceNoteDraftForSend: mock(async (_sessionId, value) => value),
      ...overrides,
    });

  beforeEach(() => {
    getSessionById = mock(() => null);
    fetchSessions = mock(async () => {});
    fetchSessionApi = mock(async () => null);
    fetchConversation = mock(async () => {});
    fetchLogs = mock(async () => {});
    setCurrentRoute = mock(() => {});
    setActiveSession = mock(() => true);
    render = mock(() => {});
    showToast = mock(() => {});
    state = { messageDrafts: new Map() };
    sessions = [];
    renameSessionAction = mock(async () => ({}));
    updateSessionMetadataAction = mock(async () => ({ metadata: {} }));
    refreshLiveTabsBar = mock(() => {});
    syncMenuTabs = mock(() => {});
    postSessionMessageApi = mock(async () => ({}));
    addToPromptQueue = mock(async () => false);
    updateAgentStatusIndicators = mock(() => {});
    isSessionBusy = mock(() => false);
    sessionMessageSendInFlight = new Set();
    promptQueueStore = { upsert: mock(async () => {}) };
    messageStore = {
      addPendingUserMessage: mock(async () => 41),
      removePendingMessage: mock(async () => {}),
      syncFromServer: mock(async () => {}),
      syncFromServerIfChanged: mock(async () => ({ changed: false })),
    };
  });

  test("stopSession returns the stop action result after syncing the session list", async () => {
    const actions = buildActions();

    const result = await actions.stopSession("session-1");

    expect(result).toEqual({ success: true });
    expect(fetchSessions).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
  });

  test("resumeSession falls back to API lookup when local cache is stale", async () => {
    fetchSessionApi.mockResolvedValue({
      id: "session-1",
      name: "Recovered session",
    });

    const actions = buildActions();
    await actions.resumeSession("session-1");

    expect(fetchSessions).toHaveBeenCalledTimes(2);
    expect(fetchSessionApi).toHaveBeenCalledWith("session-1");
    expect(setCurrentRoute).toHaveBeenCalledWith("live");
    expect(setActiveSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ updateHistory: true, forceLog: true, allowPending: true }),
    );
    expect(fetchConversation).toHaveBeenCalledWith("session-1");
    expect(fetchLogs).toHaveBeenCalledWith("session-1");
    expect(showToast).not.toHaveBeenCalled();
  });

  test("promptRenameSession refreshes tabs immediately after session details save", async () => {
    sessions = [{ id: "session-1", name: "Original", tabOrder: 1 }];
    let releaseFetch;
    fetchSessions = mock(
      () =>
        new Promise((resolve) => {
          releaseFetch = resolve;
        }),
    );
    const openSessionDetailsDialog = mock(async () => ({ name: "Renamed", position: 2 }));
    const actions = createSessionRuntimeActions({
      state,
      sessionsStore: () => ({ items: sessions }),
      getSessionById,
      getSessionDisplayName: (session) => session?.name ?? session?.id ?? "session",
      fetchSessions,
      fetchSessionApi,
      fetchConversation,
      fetchLogs,
      render,
      refreshLiveTabsBar,
      syncMenuTabs,
      setCurrentRoute,
      setActiveSession,
      stopSessionAction: mock(async () => ({ success: true })),
      deleteSessionAction: mock(async () => ({ success: true })),
      renameSessionAction,
      resumeNativeSessionAction: mock(async () => ({ session: { id: "native-session-1" } })),
      openSessionDetailsDialog,
      showToast,
      postSessionMessageApi,
      updateIdentityState: mock(() => {}),
      isSessionBusy,
      addToPromptQueue,
      updateAgentStatusIndicators,
      renderConversationForSession: mock(async () => {}),
      scrollPillHide: mock(() => {}),
      scrollConversationAreaToBottom: mock(() => {}),
      sessionMessageSendInFlight,
      focusComposerTextarea: mock(() => {}),
      isAlpineChatEnabled: () => false,
      MessageStore: { syncFromServer: mock(async () => {}), syncFromServerIfChanged: mock(async () => ({ changed: false })) },
      prepareVoiceNoteDraftForSend: mock(async (_sessionId, value) => value),
    });

    await actions.promptRenameSession(sessions[0]);

    expect(openSessionDetailsDialog).toHaveBeenCalled();
    expect(renameSessionAction).toHaveBeenCalledWith("session-1", "Renamed", 2);
    expect(updateSessionMetadataAction).not.toHaveBeenCalled();
    expect(syncMenuTabs).toHaveBeenCalledTimes(1);
    expect(refreshLiveTabsBar).toHaveBeenCalledTimes(1);
    expect(fetchSessions).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);

    releaseFetch?.();
    await Promise.resolve();
    expect(syncMenuTabs).toHaveBeenCalledTimes(2);
    expect(refreshLiveTabsBar).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledTimes(2);
  });

  test("promptRenameSession saves the per-session speech settings", async () => {
    sessions = [{
      id: "session-1",
      name: "Original",
      tabOrder: 1,
      metadata: { speechGenerateAudio: false, speechAlwaysRead: false },
    }];
    const openSessionDetailsDialog = mock(async () => ({
      name: "Original",
      position: 1,
      speechGenerateAudio: true,
      speechAlwaysRead: true,
    }));
    const actions = createSessionRuntimeActions({
      state,
      sessionsStore: () => ({ items: sessions }),
      getSessionById,
      getSessionDisplayName: (session) => session?.name ?? session?.id ?? "session",
      fetchSessions,
      fetchSessionApi,
      fetchConversation,
      fetchLogs,
      render,
      refreshLiveTabsBar,
      syncMenuTabs,
      setCurrentRoute,
      setActiveSession,
      stopSessionAction: mock(async () => ({ success: true })),
      deleteSessionAction: mock(async () => ({ success: true })),
      renameSessionAction,
      updateSessionMetadataAction,
      resumeNativeSessionAction: mock(async () => ({ session: { id: "native-session-1" } })),
      openSessionDetailsDialog,
      showToast,
      postSessionMessageApi,
      updateIdentityState: mock(() => {}),
      isSessionBusy,
      addToPromptQueue,
      updateAgentStatusIndicators,
      renderConversationForSession: mock(async () => {}),
      scrollPillHide: mock(() => {}),
      scrollConversationAreaToBottom: mock(() => {}),
      sessionMessageSendInFlight,
      focusComposerTextarea: mock(() => {}),
      isAlpineChatEnabled: () => false,
      MessageStore: { syncFromServer: mock(async () => {}), syncFromServerIfChanged: mock(async () => ({ changed: false })) },
      prepareVoiceNoteDraftForSend: mock(async (_sessionId, value) => value),
    });

    await actions.promptRenameSession(sessions[0]);

    expect(renameSessionAction).not.toHaveBeenCalled();
    expect(updateSessionMetadataAction).toHaveBeenCalledWith("session-1", {
      metadata: {
        speechGenerateAudio: true,
        speechAlwaysRead: true,
      },
    });
    expect(fetchSessions).toHaveBeenCalledTimes(1);
  });

  test("resumeSession renders live view without waiting for conversation and logs", async () => {
    getSessionById = mock(() => ({ id: "session-1", name: "Ready session" }));
    let releaseConversation;
    let releaseLogs;
    fetchConversation = mock(
      () =>
        new Promise((resolve) => {
          releaseConversation = resolve;
        }),
    );
    fetchLogs = mock(
      () =>
        new Promise((resolve) => {
          releaseLogs = resolve;
        }),
    );

    const actions = buildActions();
    await actions.resumeSession("session-1");

    expect(setCurrentRoute).toHaveBeenCalledWith("live");
    expect(setActiveSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ updateHistory: true, forceLog: true, allowPending: false }),
    );
    expect(render).toHaveBeenCalled();

    releaseConversation?.();
    releaseLogs?.();
  });

  test("resumeNativeSession opens the newly created Wingman session", async () => {
    const resumeNativeSessionAction = mock(async () => ({ session: { id: "new-session" } }));
    const actions = createSessionRuntimeActions({
      state,
      sessionsStore: () => ({ items: sessions }),
      getSessionById,
      getSessionDisplayName: (session) => session?.name ?? session?.id ?? "session",
      fetchSessions,
      fetchSessionApi,
      fetchConversation,
      fetchLogs,
      render,
      setCurrentRoute,
      setActiveSession,
      stopSessionAction: mock(async () => ({ success: true })),
      deleteSessionAction: mock(async () => ({ success: true })),
      renameSessionAction: mock(async () => ({})),
      resumeNativeSessionAction,
      openTextPromptDialog: mock(async () => null),
      showToast,
      postSessionMessageApi,
      updateIdentityState: mock(() => {}),
      isSessionBusy,
      addToPromptQueue,
      updateAgentStatusIndicators,
      renderConversationForSession: mock(async () => {}),
      scrollPillHide: mock(() => {}),
      scrollConversationAreaToBottom: mock(() => {}),
      sessionMessageSendInFlight,
      focusComposerTextarea: mock(() => {}),
      isAlpineChatEnabled: () => false,
      MessageStore: { syncFromServer: mock(async () => {}), syncFromServerIfChanged: mock(async () => ({ changed: false })) },
      prepareVoiceNoteDraftForSend: mock(async (_sessionId, value) => value),
    });

    await actions.resumeNativeSession("old-session");

    expect(resumeNativeSessionAction).toHaveBeenCalledWith("old-session");
    expect(fetchSessions).toHaveBeenCalled();
    expect(setCurrentRoute).toHaveBeenCalledWith("live");
    expect(setActiveSession).toHaveBeenCalledWith(
      "new-session",
      expect.objectContaining({ updateHistory: true, forceLog: true, allowPending: true }),
    );
    expect(fetchConversation).toHaveBeenCalledWith("new-session");
    expect(fetchLogs).toHaveBeenCalledWith("new-session");
  });

  test("sendMessage queues the prompt after a busy direct-send rejection", async () => {
    sessions = [{ id: "session-1", status: "running", agentRuntimeStatus: "stable" }];
    state.messageDrafts.set("session-1", "Follow up");

    const busyError = new Error("Agent working");
    busyError.status = 409;
    postSessionMessageApi = mock(async () => {
      throw busyError;
    });
    addToPromptQueue = mock(async () => true);

    const actions = buildActions();
    const result = await actions.sendMessage("session-1", "Follow up");

    expect(postSessionMessageApi).toHaveBeenCalledWith("session-1", "Follow up", "user");
    expect(addToPromptQueue).toHaveBeenCalledWith("session-1", "Follow up");
    expect(updateAgentStatusIndicators).toHaveBeenCalled();
    expect(state.messageDrafts.get("session-1")).toBe("");
    expect(result).toEqual({ sent: false, queued: true, busy: true });
    expect(showToast).not.toHaveBeenCalledWith("Agent working", expect.anything());
  });

  test("sendMessage clears the draft and materializes one pending user row before ACP completes", async () => {
    sessions = [{ id: "session-1", status: "running", agentRuntimeStatus: "stable" }];
    state.messageDrafts.set("session-1", "Hello Goose");
    let finishSend;
    postSessionMessageApi = mock(() => new Promise((resolve) => { finishSend = resolve; }));
    globalThis.document = { querySelector: () => null };
    globalThis.requestAnimationFrame = (callback) => callback();

    const actions = buildActions();
    const send = actions.sendMessage("session-1", "Hello Goose");
    await Bun.sleep(0);

    expect(messageStore.addPendingUserMessage).toHaveBeenCalledWith("session-1", "Hello Goose");
    expect(state.messageDrafts.get("session-1")).toBe("");
    expect(messageStore.removePendingMessage).not.toHaveBeenCalled();

    finishSend?.({ messages: [{ role: "user", content: "Hello Goose" }] });
    await expect(send).resolves.toEqual({ sent: true, queued: false });
    delete globalThis.document;
    delete globalThis.requestAnimationFrame;
  });

  test("sendMessage removes the pending row and restores the draft on a genuine failure", async () => {
    sessions = [{ id: "session-1", status: "running", agentRuntimeStatus: "stable" }];
    postSessionMessageApi = mock(async () => { throw new Error("transport failed"); });
    const originalConsoleError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError;

    try {
      const actions = buildActions();
      const result = await actions.sendMessage("session-1", "Retry me");

      expect(messageStore.removePendingMessage).toHaveBeenCalledWith("session-1", 41);
      expect(state.messageDrafts.get("session-1")).toBe("Retry me");
      expect(result.sent).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(consoleError).toHaveBeenCalledWith("Failed to send agent message", result.error);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("sendMessage materializes an atomically retained server prompt as queued", async () => {
    sessions = [{ id: "session-1", status: "running", agentRuntimeStatus: "stable" }];
    state.messageDrafts.set("session-1", "Follow up");
    const prompt = {
      id: "prompt-1",
      sessionId: "session-1",
      content: "Follow up",
      timestamp: "2026-08-04T02:00:00.000Z",
      order: 1,
    };
    postSessionMessageApi = mock(async () => ({ queued: true, prompt }));

    const actions = buildActions();
    const result = await actions.sendMessage("session-1", "Follow up");

    expect(promptQueueStore.upsert).toHaveBeenCalledWith("session-1", prompt);
    expect(addToPromptQueue).not.toHaveBeenCalled();
    expect(state.messageDrafts.get("session-1")).toBe("");
    expect(result).toEqual({ sent: false, queued: true, busy: true });
  });

  test("sendMessage lets the server resolve readiness when the cached session status is busy", async () => {
    sessions = [{ id: "session-1", status: "running", agentRuntimeStatus: "running" }];
    state.messageDrafts.set("session-1", "Queue this");
    isSessionBusy = mock(() => true);
    const prompt = {
      id: "prompt-1",
      sessionId: "session-1",
      content: "Queue this",
      timestamp: "2026-08-06T02:00:00.000Z",
      order: 1,
    };
    postSessionMessageApi = mock(async () => ({ queued: true, prompt }));

    const actions = buildActions();
    const result = await actions.sendMessage("session-1", "Queue this");

    expect(postSessionMessageApi).toHaveBeenCalledWith("session-1", "Queue this", "user");
    expect(promptQueueStore.upsert).toHaveBeenCalledWith("session-1", prompt);
    expect(addToPromptQueue).not.toHaveBeenCalled();
    expect(updateAgentStatusIndicators).toHaveBeenCalled();
    expect(state.messageDrafts.get("session-1")).toBe("");
    expect(result).toEqual({ sent: false, queued: true, busy: true });
    expect(showToast).not.toHaveBeenCalledWith("Agent working", expect.anything());
  });

  test("sendMessage queues when another send is already in flight", async () => {
    sessions = [{ id: "session-1", status: "running", agentRuntimeStatus: "stable" }];
    state.messageDrafts.set("session-1", "Queue while pending");
    sessionMessageSendInFlight.add("session-1");
    addToPromptQueue = mock(async () => true);

    const actions = buildActions();
    const result = await actions.sendMessage("session-1", "Queue while pending");

    expect(postSessionMessageApi).not.toHaveBeenCalled();
    expect(addToPromptQueue).toHaveBeenCalledWith("session-1", "Queue while pending");
    expect(updateAgentStatusIndicators).toHaveBeenCalled();
    expect(state.messageDrafts.get("session-1")).toBe("");
    expect(result).toEqual({ sent: false, queued: true, busy: true });
    expect(showToast).not.toHaveBeenCalledWith("Agent working", expect.anything());
  });
});
