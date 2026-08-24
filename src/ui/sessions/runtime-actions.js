import { openSessionDetailsDialog as defaultOpenSessionDetailsDialog } from "./session-details-dialog.js";

function getComposerTextarea() {
  if (typeof document === "undefined") {
    return null;
  }
  return document.querySelector(".wm-composer textarea");
}

function clearComposerTextarea(textarea, focusComposerTextarea, mode) {
  if (!textarea) {
    return;
  }
  textarea.value = "";
  textarea.style.height = "auto";
  focusComposerTextarea(textarea, mode);
}

async function queueMessageFallback({
  sessionId,
  content,
  state,
  addToPromptQueue,
  updateAgentStatusIndicators,
  focusComposerTextarea,
}) {
  const queued = await addToPromptQueue(sessionId, content);
  if (!queued) {
    return false;
  }

  state.messageDrafts.set(sessionId, "");
  clearComposerTextarea(getComposerTextarea(), focusComposerTextarea, "queue");
  updateAgentStatusIndicators();
  return true;
}

export function createSessionRuntimeActions(deps) {
  const {
    state,
    sessionsStore,
    getSessionById,
    getSessionDisplayName,
    fetchSessions,
    fetchSessionApi,
    fetchConversation,
    fetchLogs,
    render,
    refreshLiveTabsBar,
    syncMenuTabs,
    openSessionDetailsDialog = defaultOpenSessionDetailsDialog,
    setCurrentRoute,
    setActiveSession,
    stopSessionAction,
    deleteSessionAction,
    renameSessionAction,
    updateSessionMetadataAction,
    resumeNativeSessionAction,
    showToast,
    postSessionMessageApi,
    updateIdentityState,
    addToPromptQueue,
    updateAgentStatusIndicators,
    renderConversationForSession,
    scrollPillHide,
    scrollConversationAreaToBottom,
    sessionMessageSendInFlight,
    focusComposerTextarea,
    isAlpineChatEnabled,
    MessageStore,
    PromptQueueStore = { upsert: async () => {} },
    prepareVoiceNoteDraftForSend,
  } = deps;

  async function stopSession(sessionId) {
    try {
      const result = await stopSessionAction(sessionId);
      if (!result.success) {
        showToast(`Failed to stop session: ${result.error}`, { type: "error" });
        return result;
      }
      await fetchSessions();
      render();
      return result;
    } catch (error) {
      console.error("Failed to stop session", error);
      showToast("Failed to stop session. Check console for details.", { type: "error" });
      return {
        success: false,
        error: error instanceof Error && error.message ? error.message : "Failed to stop session",
      };
    }
  }

  async function deleteSession(sessionId) {
    try {
      const result = await deleteSessionAction(sessionId);
      if (!result.success) {
        showToast(`Failed to delete session: ${result.error}`, { type: "error" });
        return;
      }
      await fetchSessions();
      render();
    } catch (error) {
      console.error("Failed to delete session", error);
      showToast("Failed to delete session. Check console for details.", { type: "error" });
    }
  }

  async function updateSessionName(sessionId, name, position) {
    return renameSessionAction(sessionId, name, position);
  }

  function refreshSessionTabs() {
    if (typeof syncMenuTabs === "function") {
      syncMenuTabs();
    }
    if (typeof refreshLiveTabsBar === "function") {
      refreshLiveTabsBar();
    }
  }

  async function promptRenameSession(session) {
    const details = await openSessionDetailsDialog({
      session,
      sessions: sessionsStore().items,
      getSessionDisplayName,
    });
    if (details === null) return;
    const trimmed = details.name;
    const position = details.position;
    const speechGenerateAudio = Boolean(details.speechGenerateAudio);
    const speechAlwaysRead = Boolean(details.speechAlwaysRead);
    const existing = typeof session.name === "string" ? session.name.trim() : "";
    const existingPosition = typeof session.tabOrder === "number" ? session.tabOrder : null;
    const existingSpeechGenerateAudio = Boolean(session.metadata?.speechGenerateAudio);
    const existingSpeechAlwaysRead = Boolean(session.metadata?.speechAlwaysRead);
    if (
      existing === trimmed &&
      existingPosition === position &&
      existingSpeechGenerateAudio === speechGenerateAudio &&
      existingSpeechAlwaysRead === speechAlwaysRead
    ) {
      return;
    }
    try {
      const updates = [];
      if (existing !== trimmed || existingPosition !== position) {
        updates.push(updateSessionName(session.id, trimmed, position));
      }
      if (
        (existingSpeechGenerateAudio !== speechGenerateAudio || existingSpeechAlwaysRead !== speechAlwaysRead) &&
        typeof updateSessionMetadataAction === "function"
      ) {
        updates.push(updateSessionMetadataAction(session.id, {
          metadata: {
            ...(session.metadata ?? {}),
            speechGenerateAudio,
            speechAlwaysRead,
          },
        }));
      }
      await Promise.all(updates);
      refreshSessionTabs();
      void fetchSessions()
        .then(() => {
          refreshSessionTabs();
          render();
        })
        .catch((error) => {
          console.warn("Failed to refresh sessions after updating session details", error);
        });
      render();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update session details";
      showToast(message, { type: "error" });
    }
  }

  async function resumeSession(sessionId) {
    let session = getSessionById(sessionId);
    if (!session) {
      await fetchSessions();
      session = getSessionById(sessionId);
    }
    if (!session && typeof fetchSessionApi === "function") {
      const fetchedSession = await fetchSessionApi(sessionId).catch(() => null);
      if (fetchedSession) {
        await fetchSessions();
        session = getSessionById(sessionId) ?? fetchedSession;
      }
    }
    if (!session) {
      showToast("Session not available. It may have been deleted.", { type: "warning" });
      return;
    }
    setCurrentRoute("live");
    setActiveSession(sessionId, {
      updateHistory: true,
      forceLog: true,
      allowPending: !Boolean(getSessionById(sessionId)),
    });
    render();
    void Promise.allSettled([fetchConversation(sessionId), fetchLogs(sessionId)]);
  }

  async function resumeNativeSession(sessionId) {
    try {
      const result = await resumeNativeSessionAction(sessionId);
      const newSession = result?.session;
      if (!newSession?.id) {
        throw new Error("Native resume did not return a new session.");
      }
      await fetchSessions();
      setCurrentRoute("live");
      setActiveSession(newSession.id, {
        updateHistory: true,
        forceLog: true,
        allowPending: true,
      });
      render();
      showToast("Resumed native agent session", { type: "success" });
      void Promise.allSettled([fetchConversation(newSession.id), fetchLogs(newSession.id)]);
      return newSession;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to resume native session";
      showToast(message, { type: "error" });
      return null;
    }
  }

  async function postSessionMessage(sessionId, content, type = "user") {
    return postSessionMessageApi(sessionId, content, type);
  }

  async function sendMessage(sessionId, content) {
    const session = sessionsStore().items.find((item) => item.id === sessionId);
    if (!session) return;
    const trimmed = typeof content === "string" ? content.trim() : "";
    if (!trimmed) {
      showToast("Enter a message before sending.", { type: "warning" });
      return;
    }

    if (sessionMessageSendInFlight.has(sessionId)) {
      const queued = await queueMessageFallback({
        sessionId,
        content: trimmed,
        state,
        addToPromptQueue,
        updateAgentStatusIndicators,
        focusComposerTextarea,
      });
      if (queued) {
        return { sent: false, queued: true, busy: true };
      }
      showToast("Agent working", { variant: "info", duration: 2200 });
      return { sent: false, queued: false, busy: true };
    }

    if (/^[a-zA-Z0-9]$/.test(trimmed)) {
      try {
        await postSessionMessage(sessionId, trimmed, "raw");
        showToast(`Sent ${trimmed}`);
        state.messageDrafts.set(sessionId, "");
        clearComposerTextarea(getComposerTextarea(), focusComposerTextarea, "send");
        if (isAlpineChatEnabled()) {
          const chatStore = window.Alpine?.store("chat");
          if (chatStore && chatStore.sessionId === sessionId) {
            chatStore.appendMessage({
              id: `raw-${Date.now()}`,
              sessionId,
              role: "user",
              content: trimmed,
              createdAt: new Date().toISOString(),
            });
          }
        }
        await Promise.all([fetchConversation(sessionId), fetchLogs(sessionId)]);
        return { sent: true, queued: false, type: "raw" };
      } catch (error) {
        console.error("Failed to send raw input", error);
        showToast(`Failed to send ${trimmed}`, { variant: "error" });
        return { sent: false, queued: false, error };
      }
    }

    let preparedContent = trimmed;
    try {
      preparedContent = await prepareVoiceNoteDraftForSend(sessionId, trimmed);
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Failed to prepare voice note transcript.";
      showToast(`Failed to send message: ${message}`, { variant: "error" });
      return { sent: false, queued: false, error };
    }

    const finalContent = typeof preparedContent === "string" ? preparedContent.trim() : "";
    if (!finalContent) {
      showToast("Enter a message before sending.", { type: "warning" });
      return { sent: false, queued: false };
    }

    let pendingMessageId = null;
    try {
      sessionMessageSendInFlight.add(sessionId);
      pendingMessageId = await MessageStore.addPendingUserMessage(sessionId, finalContent);
      state.messageDrafts.set(sessionId, "");
      clearComposerTextarea(getComposerTextarea(), focusComposerTextarea, "send");
      const payload = await postSessionMessage(sessionId, finalContent, "user");
      if (payload?.queued && payload?.prompt) {
        if (pendingMessageId !== null) {
          await MessageStore.removePendingMessage(sessionId, pendingMessageId);
        }
        await PromptQueueStore.upsert(sessionId, payload.prompt);
        state.messageDrafts.set(sessionId, "");
        clearComposerTextarea(getComposerTextarea(), focusComposerTextarea, "queue");
        updateAgentStatusIndicators();
        return { sent: false, queued: true, busy: true };
      }
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      await MessageStore.syncFromServer(sessionId, messages);
      state.messageDrafts.set(sessionId, "");

      const knightRider = document.querySelector(`.wm-knight-rider[data-session-id="${sessionId}"]`);
      if (knightRider) knightRider.classList.add("active");

      await renderConversationForSession(sessionId);
      scrollPillHide();
      requestAnimationFrame(() => {
        scrollConversationAreaToBottom(sessionId, { includeWindow: true });
      });
      await fetchLogs(sessionId);

      return { sent: true, queued: false };
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : "Failed to send message to agent.";
      const status = Number(error?.status ?? 0);
      const normalized = message.toLowerCase();
      const isWorkingState =
        status === 409 ||
        status === 429 ||
        normalized.includes("already in progress") ||
        normalized.includes("already posted") ||
        normalized.includes("already processing") ||
        normalized.includes("agent working") ||
        normalized.includes("not ready for prompt dispatch");
      if (isWorkingState) {
        if (pendingMessageId !== null) {
          await MessageStore.removePendingMessage(sessionId, pendingMessageId);
        }
        const queued = await queueMessageFallback({
          sessionId,
          content: finalContent,
          state,
          addToPromptQueue,
          updateAgentStatusIndicators,
          focusComposerTextarea,
        });
        if (queued) {
          return { sent: false, queued: true, busy: true };
        }
        showToast("Agent working", { variant: "info", duration: 2600 });
        return { sent: false, queued: false, busy: true };
      }
      console.error("Failed to send agent message", error);
      if (pendingMessageId !== null) {
        await MessageStore.removePendingMessage(sessionId, pendingMessageId);
      }
      state.messageDrafts.set(sessionId, finalContent);
      const textarea = getComposerTextarea();
      if (textarea) {
        textarea.value = finalContent;
      }
      showToast(`Failed to send message: ${message}`, { variant: "error" });
      return { sent: false, queued: false, error };
    } finally {
      sessionMessageSendInFlight.delete(sessionId);
    }
  }

  async function sendControlCommand(sessionId, action) {
    const session = sessionsStore().items.find((item) => item.id === sessionId);
    if (!session || !action || typeof action.sequence !== "string") {
      return;
    }
    try {
      await postSessionMessage(sessionId, action.sequence, "raw");
      showToast(`Sent ${action.toastLabel}`);
      await fetchLogs(sessionId);
    } catch (error) {
      console.error(`Failed to send control command (${action.toastLabel})`, error);
      showToast(`Failed to send ${action.toastLabel}`, { variant: "error" });
    }
  }

  return {
    stopSession,
    deleteSession,
    updateSessionName,
    promptRenameSession,
    resumeSession,
    resumeNativeSession,
    postSessionMessage,
    sendMessage,
    sendControlCommand,
  };
}
