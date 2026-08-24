/**
 * Session helpers and prompt queue modal.
 *
 * Provides session lookup utilities and the prompt queue CRUD + modal UI.
 */

import { getSessionDisplayName } from "../core/icons.js";
import { openConfirmDialog, openTextPromptDialog } from "../common/dialog-prompts.js";
import { show as scrollPillShow } from "../live/scroll-pill.js";
import { isAlpineChatEnabled, MessageStore, PromptQueueStore } from "../live/index.js";

const ACTIVE_SESSION_STATUSES = new Set(["starting", "running"]);

/**
 * @param {object} deps
 * @param {object}   deps.state                     - global UI state (.promptQueues, .sessions)
 * @param {function} deps.sessionsStore              - lazy accessor for Alpine sessions store
 * @param {function} deps.showToast                  - toast notification helper
 * @param {function} deps.updateAgentStatusIndicators - refreshes agent status badges
 * @param {function} deps.updateConversationDOM       - re-renders conversation for a session
 * @param {function} deps.scrollConversationAreaToBottom - scrolls conversation to end
 */
export function initQueueModule(deps) {
  const {
    state,
    sessionsStore,
    showToast,
    updateAgentStatusIndicators,
    updateConversationDOM,
    scrollConversationAreaToBottom,
  } = deps;

  // ── Session helpers ───────────────────────────────────────────────

  const getSessionById = (sessionId) =>
    sessionsStore().items.find((session) => session.id === sessionId);

  const isSessionActive = (session) => ACTIVE_SESSION_STATUSES.has(session?.status);

  const getActiveSessions = () =>
    sessionsStore().items.filter((session) => isSessionActive(session));

  const isSessionBusy = (session) => {
    if (!session) return false;
    return session.status === "starting" || session.agentRuntimeStatus === "running";
  };

  const isStatusRecordBusy = (statusRecord) => {
    if (!statusRecord) return false;
    return statusRecord.status === "starting" || statusRecord.agentRuntimeStatus === "running";
  };

  // ── Queue data management ─────────────────────────────────────────

  const getSessionQueue = (sessionId) => {
    if (!state.promptQueues.has(sessionId)) {
      state.promptQueues.set(sessionId, { prompts: [], maxSize: 21 });
    }
    return state.promptQueues.get(sessionId);
  };

  const getQueueCount = (sessionId) => {
    const queue = getSessionQueue(sessionId);
    return queue.prompts.length;
  };

  const isQueueFull = (sessionId) => {
    const count = getQueueCount(sessionId);
    return count >= 21;
  };

  let manualQueueSendInFlight = false;

  const addToPromptQueue = async (sessionId, content) => {
    if (isQueueFull(sessionId)) {
      showToast("Queue limit reached (21/21)", { type: "warning" });
      return false;
    }

    try {
      const response = await fetch(`/api/sessions/${sessionId}/queue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to add prompt to queue");
      }

      const result = await response.json();
      const queue = getSessionQueue(sessionId);
      queue.prompts.push(result.prompt);
      await PromptQueueStore.upsert(sessionId, result.prompt);

      updateAgentStatusIndicators();
      showToast("Prompt queued", { type: "success" });
      return true;
    } catch (error) {
      console.error("Failed to add prompt to queue:", error);
      showToast(`Failed to queue prompt: ${error.message}`, { type: "error" });
      return false;
    }
  };

  const removeFromPromptQueue = async (sessionId, promptId) => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/queue/${promptId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to remove prompt from queue");
      }

      const queue = getSessionQueue(sessionId);
      queue.prompts = queue.prompts.filter((prompt) => prompt.id !== promptId);
      await PromptQueueStore.remove(sessionId, promptId);

      updateAgentStatusIndicators();
      return true;
    } catch (error) {
      console.error("Failed to remove prompt from queue:", error);
      showToast(`Failed to remove prompt: ${error.message}`, { type: "error" });
      return false;
    }
  };

  const updatePromptInQueue = async (sessionId, promptId, newContent) => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/queue/${promptId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: newContent }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update prompt");
      }

      const queue = getSessionQueue(sessionId);
      const promptIndex = queue.prompts.findIndex((prompt) => prompt.id === promptId);
      if (promptIndex !== -1) {
        queue.prompts[promptIndex].content = newContent;
      }
      await PromptQueueStore.updateContent(sessionId, promptId, newContent);
      return true;
    } catch (error) {
      console.error("Failed to update prompt:", error);
      showToast(`Failed to update prompt: ${error.message}`, { type: "error" });
      return false;
    }
  };

  const fetchSessionQueue = async (sessionId) => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/queue`);
      if (!response.ok) {
        throw new Error("Failed to fetch queue");
      }
      const data = await response.json();
      const queue = getSessionQueue(sessionId);
      queue.prompts = data.queue?.prompts ?? [];
      await PromptQueueStore.replaceSession(sessionId, queue.prompts);
      updateAgentStatusIndicators();
      return queue.prompts;
    } catch (error) {
      console.error("Failed to fetch session queue:", error);
      return [];
    }
  };

  const sendNextQueuedPrompt = async (sessionId) => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/queue/next`, {
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));

        if (data.failedPrompt) {
          const textarea = document.querySelector(".wm-composer textarea");
          if (textarea) {
            textarea.value = data.failedPrompt.content;
            textarea.style.height = "auto";
            textarea.style.height = textarea.scrollHeight + "px";
            textarea.focus({ preventScroll: true });
          }
          showToast("Failed to send queued prompt - inserted into text area for manual retry", {
            type: "error",
            duration: 5000,
          });

        }
        return false;
      }

      const result = await response.json();

      if (result.messages) {
        await MessageStore.syncFromServer(sessionId, result.messages);
        if (!isAlpineChatEnabled()) {
          await updateConversationDOM(sessionId);
        }
        // Show pill instead of force-scrolling — user may be reading history
        scrollPillShow();
      }

      const queue = getSessionQueue(sessionId);
      if (result.sentPrompt) {
        queue.prompts = queue.prompts.filter((prompt) => prompt.id !== result.sentPrompt.id);
        await PromptQueueStore.remove(sessionId, result.sentPrompt.id);
      }

      updateAgentStatusIndicators();
      showToast("Prompt sent to agent", { type: "success" });
      return true;
    } catch (error) {
      console.error("Failed to send queued prompt:", error);
      showToast("Failed to send queued prompt", { type: "error" });
      return false;
    }
  };

  // ── Queue modal UI ────────────────────────────────────────────────

  let queueModal = null;
  let currentQueueSessionId = null;

  const ensureQueueModalStyles = () => {
    if (document.querySelector("#queue-modal-styles")) return;

    const style = document.createElement("style");
    style.id = "queue-modal-styles";
    style.textContent = `
    .wm-prompt-queue-modal {
      max-width: 600px;
      width: 90vw;
      min-height: 300px;
      max-height: 80vh;
      border: 1px solid #ccc;
      border-radius: 8px;
      padding: 0;
      background: white;
      box-sizing: border-box;
    }

    .wm-prompt-queue-modal::backdrop {
      background: rgba(0, 0, 0, 0.5);
    }

    .wm-prompt-queue-modal .modal-content {
      display: flex;
      flex-direction: column;
      min-height: 300px;
      height: auto;
    }

    .wm-prompt-queue-modal .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      border-bottom: 1px solid #eee;
    }

    .wm-prompt-queue-modal .modal-header h2 {
      margin: 0;
      font-size: 1.25rem;
    }

    .wm-prompt-queue-modal .close-btn {
      background: none;
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      padding: 0.5rem;
      line-height: 1;
      min-width: 44px;
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .wm-prompt-queue-modal .modal-body {
      flex: 1;
      padding: 1rem;
      overflow-y: auto;
      min-height: 150px;
    }

    .wm-prompt-queue-modal .empty-state {
      text-align: center;
      color: #666;
      font-style: italic;
      padding: 2rem;
    }

    .wm-prompt-queue-modal .queue-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .wm-prompt-queue-modal .queue-item {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.75rem;
      border: 1px solid #ddd;
      border-radius: 4px;
      background: #f9f9f9;
    }

    .wm-prompt-queue-modal .prompt-preview {
      flex: 1;
      font-family: monospace;
      font-size: 0.9rem;
      line-height: 1.4;
      word-break: break-word;
    }

    .wm-prompt-queue-modal .prompt-actions {
      display: flex;
      gap: 0.5rem;
      flex-shrink: 0;
    }

    .wm-prompt-queue-modal .prompt-actions button {
      padding: 0.5rem 0.75rem;
      border: 1px solid #ccc;
      border-radius: 3px;
      background: white;
      cursor: pointer;
      font-size: 0.9rem;
      min-height: 44px;
    }

    .wm-prompt-queue-modal .edit-btn:hover {
      background: #e3f2fd;
      border-color: #2196f3;
    }

    .wm-prompt-queue-modal .delete-btn:hover {
      background: #ffebee;
      border-color: #f44336;
    }

    .wm-prompt-queue-modal .modal-footer {
      padding: 1rem;
      border-top: 1px solid #eee;
      text-align: center;
      color: #666;
      font-size: 0.9rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      align-items: center;
    }

    .wm-prompt-queue-modal .modal-footer button {
      min-height: 44px;
      padding: 0.5rem 1rem;
    }

    /* Desktop: side-by-side layout for queue items */
    @media (min-width: 480px) {
      .wm-prompt-queue-modal .queue-item {
        flex-direction: row;
        justify-content: space-between;
        align-items: flex-start;
      }

      .wm-prompt-queue-modal .prompt-preview {
        margin-right: 1rem;
      }
    }
  `;

    document.head.appendChild(style);
  };

  const updateQueueModalContent = (sessionId, prompts) => {
    if (!queueModal || !currentQueueSessionId) return;

    const session = getSessionById(sessionId);
    const sessionName = getSessionDisplayName(session);

    const title = queueModal.querySelector("#queue-modal-title");
    if (title) {
      title.textContent = `Prompt Queue - ${sessionName}`;
    }

    const body = queueModal.querySelector(".modal-body");
    if (!body) return;

    body.innerHTML = "";

    if (prompts.length === 0) {
      const emptyState = document.createElement("div");
      emptyState.className = "empty-state";
      emptyState.textContent = "No prompts queued";
      body.appendChild(emptyState);
    } else {
      const queueList = document.createElement("div");
      queueList.className = "queue-list";

      prompts.forEach((prompt, index) => {
        const item = document.createElement("div");
        item.className = "queue-item";
        item.dataset.promptId = prompt.id;

        const preview = document.createElement("div");
        preview.className = "prompt-preview";
        const previewText =
          prompt.content.length > 100 ? prompt.content.substring(0, 100) + "..." : prompt.content;
        preview.textContent = `${index + 1}. ${previewText}`;

        const actions = document.createElement("div");
        actions.className = "prompt-actions";

        const editBtn = document.createElement("button");
        editBtn.className = "edit-btn";
        editBtn.type = "button";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => editQueuePrompt(sessionId, prompt.id, prompt.content));

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "delete-btn";
        deleteBtn.type = "button";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", () => deleteQueuePrompt(sessionId, prompt.id));

        actions.append(editBtn, deleteBtn);
        item.append(preview, actions);
        queueList.appendChild(item);
      });

      body.appendChild(queueList);
    }

    const footer = queueModal.querySelector(".modal-footer");
    if (footer) {
      footer.innerHTML = "";

      const countLabel = document.createElement("span");
      countLabel.textContent = `${prompts.length}/21 prompts`;
      footer.appendChild(countLabel);

      if (prompts.length > 0) {
        const sendButton = document.createElement("button");
        sendButton.type = "button";
        sendButton.className = "wm-button secondary";
        sendButton.textContent = manualQueueSendInFlight ? "Sending..." : "Send next now";
        sendButton.disabled = manualQueueSendInFlight;
        sendButton.addEventListener("click", () => handleManualQueueSend(sessionId));
        footer.appendChild(sendButton);
      }
    }
  };

  const createPromptQueueModal = () => {
    ensureQueueModalStyles();

    const modal = document.createElement("dialog");
    modal.className = "wm-prompt-queue-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "queue-modal-title");

    modal.addEventListener("click", (event) => {
      if (event.target === modal) closePromptQueueModal();
    });

    modal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePromptQueueModal();
    });

    const content = document.createElement("div");
    content.className = "modal-content";

    const header = document.createElement("header");
    header.className = "modal-header";

    const title = document.createElement("h2");
    title.id = "queue-modal-title";
    title.textContent = "Prompt Queue";

    const closeBtn = document.createElement("button");
    closeBtn.className = "close-btn";
    closeBtn.type = "button";
    closeBtn.textContent = "\u00d7";
    closeBtn.setAttribute("aria-label", "Close queue modal");
    closeBtn.addEventListener("click", closePromptQueueModal);

    header.append(title, closeBtn);

    const body = document.createElement("div");
    body.className = "modal-body";

    const footer = document.createElement("footer");
    footer.className = "modal-footer";

    content.append(header, body, footer);
    modal.appendChild(content);

    return modal;
  };

  const openPromptQueueModal = async (sessionId) => {
    const session = getSessionById(sessionId);
    if (!session) return;

    currentQueueSessionId = sessionId;

    await fetchSessionQueue(sessionId);
    const queue = getSessionQueue(sessionId);

    if (!queueModal || !document.contains(queueModal)) {
      queueModal = createPromptQueueModal();
      document.body.appendChild(queueModal);
    }

    updateQueueModalContent(sessionId, queue.prompts);

    if (typeof queueModal.showModal === "function") {
      queueModal.showModal();
    } else {
      queueModal.style.display = "block";
    }
  };

  function closePromptQueueModal() {
    if (queueModal) {
      if (typeof queueModal.close === "function") {
        queueModal.close();
      } else {
        queueModal.style.display = "none";
      }
    }
    currentQueueSessionId = null;
  }

  const handleManualQueueSend = async (sessionId) => {
    if (manualQueueSendInFlight) return;
    const queue = getSessionQueue(sessionId);
    if (!queue.prompts.length) {
      showToast("No queued prompts to send", { type: "info" });
      return;
    }

    manualQueueSendInFlight = true;
    updateQueueModalContent(sessionId, queue.prompts);
    try {
      const success = await sendNextQueuedPrompt(sessionId);
      if (success) {
        updateAgentStatusIndicators();
        updateQueueModalContent(sessionId, queue.prompts);
      }
    } finally {
      manualQueueSendInFlight = false;
      updateQueueModalContent(sessionId, queue.prompts);
    }
  };

  const editQueuePrompt = async (sessionId, promptId, currentContent) => {
    const newContent = await openTextPromptDialog({
      title: "Edit Queued Prompt",
      description: "Update the queued prompt before it is dispatched to the agent.",
      label: "Prompt",
      value: currentContent,
      confirmLabel: "Save",
      testId: "edit-queued-prompt-dialog",
      validate: (value) => (value ? "" : "Prompt content cannot be empty."),
    });
    if (newContent === null) {
      return;
    }
    const success = await updatePromptInQueue(sessionId, promptId, newContent);
    if (success) {
      const queue = getSessionQueue(sessionId);
      updateQueueModalContent(sessionId, queue.prompts);
      updateAgentStatusIndicators();
    }
  };

  const deleteQueuePrompt = async (sessionId, promptId) => {
    const confirmed = await openConfirmDialog({
      title: "Delete Queued Prompt",
      description: "Remove this prompt from the session queue. This cannot be undone.",
      confirmLabel: "Delete",
      testId: "delete-queued-prompt-dialog",
    });
    if (!confirmed) {
      return;
    }
    const success = await removeFromPromptQueue(sessionId, promptId);
    if (success) {
      const queue = getSessionQueue(sessionId);
      updateQueueModalContent(sessionId, queue.prompts);
      updateAgentStatusIndicators();
    }
  };

  return {
    getSessionById,
    isSessionActive,
    getActiveSessions,
    isSessionBusy,
    isStatusRecordBusy,
    getSessionQueue,
    getQueueCount,
    isQueueFull,
    addToPromptQueue,
    removeFromPromptQueue,
    updatePromptInQueue,
    fetchSessionQueue,
    sendNextQueuedPrompt,
    openPromptQueueModal,
    closePromptQueueModal,
  };
}
