/**
 * Alpine.js reactive chat component for live session view.
 * Messages are read reactively from Dexie, with SSE as the steady-state write path.
 */

import Alpine from "/vendor/alpinejs/module.esm.js";
import Dexie from "/vendor/dexie/dexie.mjs";
import { sseManager } from "./sse-manager.js";
import { MessageStore, PermissionStore, PromptQueueStore, SessionStore } from "./db.js";
import { mergeConversationWithQueuedPrompts } from "./conversation-queue.js";
import { buildPermissionActions } from "./permission-actions.js";
import { show as scrollPillShow, isNearBottom as scrollPillIsNearBottom } from "./scroll-pill.js";
import {
  getChatMessageHtmlCacheOptions,
  renderChatMessageHtml,
  renderWorkingNotesHtml,
} from "../rendering/chat-message-content.js";
import { state } from "../state/index.js";
import { getWorkingNotesPanelKey, isWorkingNotesPanelOpen } from "./working-notes-toggle.js";
import { shouldDefaultWorkingNotesOpen } from "./working-notes-display.js";
import { AGENT_OUTPUT_FORMATTING_FLAG_KEY } from "../rendering/agent-output-format.js";
import { normalizeRuntimeStatus } from "./session-status-cache.js";
import { buildEmptySessionInformation } from "./session-information.js";
import {
  formatMessageTimestampLabel,
  getMessageTimestampAriaLabel,
  getMessageTimestampDateTime,
  isWorkingMessageTimestamp,
} from "./message-timestamp.js";
import {
  fetchSessionMessagesApi,
  fetchSessionPermissionsApi,
  fetchSessionQueueApi,
  respondToSessionPermissionApi,
} from "../services/sessions.js";
import { showToast } from "../utils/toast.js";
import {
  deleteQueuedPrompt,
  saveQueuedPromptEdit,
} from "./queued-prompt-actions.js";
import {
  LIVE_MESSAGE_WINDOW_DEFAULT,
  LIVE_MESSAGE_PAGE_SIZE,
  createWindowRecord,
  syncConversationWindow,
  expandConversationWindow,
  capturePrependedScrollState,
  schedulePrependedScrollRestore,
} from "./conversation-window.js";
import {
  autoReadLatestAssistantMessage,
  ensureLatestAssistantSpeech,
  getLatestAssistantSpeechKey,
  getMessageSpeechKey,
  isSessionAlwaysReadEnabled,
  isSessionSpeechGenerationEnabled,
  readMessageAloud,
  stopSpeechPlayback,
} from "./message-speech.js";

let featureEnabledResolver = () => false;

export function configureLiveChatFeatures({ isFeatureEnabled } = {}) {
  featureEnabledResolver = typeof isFeatureEnabled === "function" ? isFeatureEnabled : () => false;
}

function isAgentOutputFormattingEnabled() {
  return Boolean(featureEnabledResolver(AGENT_OUTPUT_FORMATTING_FLAG_KEY));
}

function shouldFormatAgentMessage(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  return role === "assistant" || role === "agent";
}

function isWorkingNotesMessage(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  return role === "agent-working" || role === "agent-thinking" || role === "agent-tools" || role === "agent-context";
}

function getWorkingNotesLabel(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  if (role === "agent-tools") return "Tools";
  if (role === "agent-context") return "Context";
  return "Thinking";
}

function isReadableAgentMessage(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  const content = String(message?.content ?? message?.message ?? "").trim();
  return (role === "assistant" || role === "agent") && Boolean(content);
}

function isErrorMessage(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  return role === "agent-error";
}

function getQueuedPromptEditorId(promptId) {
  return `queued-prompt-editor-${String(promptId ?? "").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/**
 * Check if Alpine chat is enabled via feature flag.
 * @returns {boolean}
 */
export function isAlpineChatEnabled() {
  try {
    // Enabled by default — set to "false" to disable
    const flag = localStorage.getItem("wingman-alpine-chat");
    return flag !== "false";
  } catch {
    return true;
  }
}

/**
 * Enable Alpine chat feature.
 */
export function enableAlpineChat() {
  try {
    localStorage.setItem("wingman-alpine-chat", "true");
  } catch {
    // Storage not available
  }
}

/**
 * Disable Alpine chat feature.
 */
export function disableAlpineChat() {
  try {
    localStorage.removeItem("wingman-alpine-chat");
  } catch {
    // Storage not available
  }
}

/**
 * Register the Alpine.js chat component.
 * Call this once during app initialization.
 */
export function registerChatComponent() {
  // Register the chat store
  Alpine.store("chat", {
    sessionId: null,
    messages: [],
    permissions: [],
    queuedPrompts: [],
    queuedPromptEdit: {
      promptId: null,
      draft: "",
      saving: false,
      error: "",
    },
    messageWindow: createWindowRecord(0, LIVE_MESSAGE_WINDOW_DEFAULT),
    status: "disconnected",
    connectionState: "disconnected",
    streamMode: "unknown",
    isLoading: false,
    error: null,
    _sseUnsubscribers: [],
    _messageSubscription: null,
    _statusSubscription: null,
    _permissionSubscription: null,
    _promptQueueSubscription: null,
    _speechBaselineReady: false,
    _lastSpeechCandidateKey: "",
    speechPlaybackKey: "",

    init() {
      window.addEventListener("speech-playback-change", (event) => {
        this.speechPlaybackKey = event.detail?.key ?? "";
      });
    },

    /**
     * Load (or switch to) a session's chat.
     * @param {string} sessionId
     */
    async loadSession(sessionId) {
      if (!sessionId) return;
      // Already loaded for this session — don't wipe messages
      if (this.sessionId === sessionId) return;
      this.cleanup();
      this.sessionId = sessionId;
      this.messageWindow = createWindowRecord(0, LIVE_MESSAGE_WINDOW_DEFAULT);
      this.isLoading = true;
      this.error = null;

      try {
        this._subscribeToMessages(sessionId);
        this._subscribeToSessionStatus(sessionId);
        this._subscribeToPermissions(sessionId);
        this._subscribeToPromptQueue(sessionId);
        void this._syncMessagesFromServer(sessionId);
        void this._syncPermissionsFromServer(sessionId);
        void this._syncPromptQueueFromServer(sessionId);

        // Subscribe to SSE status/connection events
        this._setupSSEListeners(sessionId);

        // Connect SSE
        sseManager.connect(sessionId);
        this.connectionState = sseManager.getConnectionState(sessionId);
        this.streamMode = typeof sseManager.getStreamMode === "function"
          ? sseManager.getStreamMode(sessionId)
          : "unknown";

        this.isLoading = false;
        console.log("[chat] Loaded session", sessionId);
      } catch (error) {
        console.error("[chat] Failed to initialize:", error);
        this.error = error.message;
        this.isLoading = false;
      }
    },

    /**
     * Set up SSE event listeners.
     * @param {string} sessionId
     */
    _setupSSEListeners(sessionId) {
      // Status changes
      this._sseUnsubscribers.push(
        sseManager.onStatusChange((sid, status) => {
          if (sid === sessionId) {
            const wasBusy = this.isBusy;
            this.status = status;
            if (wasBusy && !this.isBusy) {
              this._scheduleSpeechWork();
            }
          }
        })
      );

      // Connection state changes
      this._sseUnsubscribers.push(
        sseManager.onConnectionChange((sid, state) => {
          if (sid === sessionId) {
            this.connectionState = state;
          }
        })
      );

      this._sseUnsubscribers.push(
        sseManager.onStreamModeChange((sid, mode) => {
          if (sid === sessionId) {
            this.streamMode = mode;
          }
        })
      );
    },

    _subscribeToMessages(sessionId) {
      this._messageSubscription?.unsubscribe?.();
      this._messageSubscription = Dexie.liveQuery(() => MessageStore.getSessionMessages(sessionId))
        .subscribe({
          next: (messages) => {
            if (this.sessionId !== sessionId) {
              return;
            }
            this.replaceMessages(messages);
            this.isLoading = false;
          },
          error: (error) => {
            if (this.sessionId !== sessionId) {
              return;
            }
            console.error("[chat] Failed to read messages:", error);
            this.error = error instanceof Error ? error.message : String(error);
            this.isLoading = false;
          },
        });
    },

    _subscribeToSessionStatus(sessionId) {
      this._statusSubscription?.unsubscribe?.();
      this._statusSubscription = Dexie.liveQuery(SessionStore.liveQuery(sessionId))
        .subscribe({
          next: (session) => {
            if (this.sessionId !== sessionId) {
              return;
            }
            const wasBusy = this.isBusy;
            this.status = normalizeRuntimeStatus(session?.agentRuntimeStatus) ?? "stable";
            if (wasBusy && !this.isBusy) {
              this._scheduleSpeechWork();
            }
          },
          error: (error) => {
            if (this.sessionId !== sessionId) {
              return;
            }
            console.warn("[chat] Failed to read session status:", error);
          },
        });
    },

    _subscribeToPermissions(sessionId) {
      this._permissionSubscription?.unsubscribe?.();
      this._permissionSubscription = Dexie.liveQuery(() => PermissionStore.getSessionPermissions(sessionId))
        .subscribe({
          next: (permissions) => {
            if (this.sessionId === sessionId) this.permissions = permissions;
          },
          error: (error) => console.warn("[chat] Failed to read permissions:", error),
        });
    },

    _subscribeToPromptQueue(sessionId) {
      this._promptQueueSubscription?.unsubscribe?.();
      this._promptQueueSubscription = Dexie.liveQuery(() => PromptQueueStore.getSessionPrompts(sessionId))
        .subscribe({
          next: (prompts) => {
            if (this.sessionId !== sessionId) return;
            this.queuedPrompts = prompts;
            this._syncMessageWindow();
            this._scheduleScroll();
          },
          error: (error) => console.warn("[chat] Failed to read queued prompts:", error),
        });
    },

    async _syncMessagesFromServer(sessionId) {
      const payload = await fetchSessionMessagesApi(sessionId, { refresh: true }).catch(() => null);
      if (this.sessionId !== sessionId || !Array.isArray(payload?.messages)) {
        return;
      }
      await MessageStore.syncFromServerIfChanged(sessionId, payload.messages);
    },

    async _syncPermissionsFromServer(sessionId) {
      const payload = await fetchSessionPermissionsApi(sessionId).catch(() => null);
      if (this.sessionId !== sessionId || !Array.isArray(payload?.permissions)) return;
      await PermissionStore.replaceSession(sessionId, payload.permissions);
    },

    async _syncPromptQueueFromServer(sessionId) {
      const payload = await fetchSessionQueueApi(sessionId).catch(() => null);
      if (this.sessionId !== sessionId || !Array.isArray(payload?.queue?.prompts)) return;
      await PromptQueueStore.replaceSession(sessionId, payload.queue.prompts);
    },

    async respondToPermission(permission, response) {
      if (!this.sessionId || !permission?.permissionId || permission.responding) return;
      const sessionId = this.sessionId;
      await PermissionStore.setResponding(sessionId, permission.permissionId, true);
      try {
        await respondToSessionPermissionApi(sessionId, permission.permissionId, response);
        await PermissionStore.remove(sessionId, permission.permissionId);
        this.error = null;
      } catch (error) {
        await PermissionStore.setResponding(sessionId, permission.permissionId, false);
        this.error = error instanceof Error ? error.message : String(error);
      }
    },

    editQueuedPrompt(message) {
      if (!message?.promptId) return;
      this.queuedPromptEdit = {
        promptId: message.promptId,
        draft: String(message.content ?? ""),
        saving: false,
        error: "",
      };
      queueMicrotask(() => {
        const editor = document.getElementById(getQueuedPromptEditorId(message.promptId));
        editor?.focus?.();
        editor?.select?.();
      });
    },

    isEditingQueuedPrompt(message) {
      return Boolean(message?.queued && message?.promptId && this.queuedPromptEdit.promptId === message.promptId);
    },

    getQueuedPromptEditorId(message) {
      return getQueuedPromptEditorId(message?.promptId);
    },

    updateQueuedPromptDraft(value) {
      this.queuedPromptEdit = {
        ...this.queuedPromptEdit,
        draft: String(value ?? ""),
        error: "",
      };
    },

    cancelQueuedPromptEdit() {
      this.queuedPromptEdit = {
        promptId: null,
        draft: "",
        saving: false,
        error: "",
      };
    },

    async saveQueuedPromptEdit(message) {
      if (!message?.sessionId || !message?.promptId || !this.isEditingQueuedPrompt(message)) return;
      const draft = this.queuedPromptEdit.draft;
      if (!draft.trim()) {
        this.queuedPromptEdit = {
          ...this.queuedPromptEdit,
          error: "Queued prompt cannot be empty.",
        };
        showToast("Queued prompt cannot be empty", { type: "warning" });
        return;
      }
      this.queuedPromptEdit = {
        ...this.queuedPromptEdit,
        saving: true,
        error: "",
      };
      try {
        await saveQueuedPromptEdit(message.sessionId, message.promptId, draft);
        this.cancelQueuedPromptEdit();
        showToast("Queued prompt updated", { type: "success" });
      } catch (error) {
        console.error("[chat] Failed to update queued prompt:", error);
        const messageText = error instanceof Error ? error.message : "Failed to update queued prompt";
        this.queuedPromptEdit = {
          ...this.queuedPromptEdit,
          saving: false,
          error: messageText,
        };
        showToast(messageText, { type: "error" });
      }
    },

    async deleteQueuedPrompt(message) {
      if (!message?.sessionId || !message?.promptId || message.deleting) return;
      message.deleting = true;
      try {
        await deleteQueuedPrompt(message.sessionId, message.promptId);
        showToast("Queued prompt deleted", { type: "success" });
      } catch (error) {
        console.error("[chat] Failed to delete queued prompt:", error);
        showToast(error instanceof Error ? error.message : "Failed to delete queued prompt", { type: "error" });
      } finally {
        message.deleting = false;
      }
    },

    /**
     * Show the scroll pill if user is scrolled up, otherwise do nothing
     * (the user is already at the bottom and will see new content naturally).
     */
    _scheduleScroll() {
      if (!scrollPillIsNearBottom()) {
        scrollPillShow();
      }
    },

    _syncMessageWindow() {
      this.messageWindow = syncConversationWindow(
        new Map([["active", this.messageWindow]]),
        "active",
        this.timelineMessages.length,
      );
    },

    replaceMessages(messages) {
      this.messages = Array.isArray(messages) ? messages : [];
      this._syncMessageWindow();
      this._scheduleSpeechWork();
    },

    appendMessage(message) {
      this.messages = [...this.messages, message];
      this._syncMessageWindow();
      this._scheduleSpeechWork();
    },

    revealOlderMessages(scrollElement) {
      const tempStore = new Map([["active", this.messageWindow]]);
      const snapshot = capturePrependedScrollState(scrollElement);
      this.messageWindow = expandConversationWindow(tempStore, "active", this.timelineMessages.length, LIVE_MESSAGE_PAGE_SIZE);
      schedulePrependedScrollRestore(snapshot);
    },

    /**
     * Clean up subscriptions and connections.
     */
    cleanup() {
      this._messageSubscription?.unsubscribe?.();
      this._messageSubscription = null;
      this._statusSubscription?.unsubscribe?.();
      this._statusSubscription = null;
      this._permissionSubscription?.unsubscribe?.();
      this._permissionSubscription = null;
      this._promptQueueSubscription?.unsubscribe?.();
      this._promptQueueSubscription = null;
      this._sseUnsubscribers.forEach((unsub) => unsub());
      this._sseUnsubscribers = [];
      if (this.sessionId) {
        sseManager.disconnect(this.sessionId);
      }
      this.sessionId = null;
      this.messages = [];
      this.permissions = [];
      this.queuedPrompts = [];
      this.cancelQueuedPromptEdit();
      this.messageWindow = createWindowRecord(0, LIVE_MESSAGE_WINDOW_DEFAULT);
      this.status = "disconnected";
      this.connectionState = "disconnected";
      this.streamMode = "unknown";
      this._speechBaselineReady = false;
      this._lastSpeechCandidateKey = "";
    },

    renderMessageContent(message) {
      const cacheOptions = getChatMessageHtmlCacheOptions(message, { sessionId: this.sessionId });
      if (isWorkingNotesMessage(message)) {
        const workingNotesKey = getWorkingNotesPanelKey(this.sessionId, message);
        const workingNotesLabel = getWorkingNotesLabel(message);
        return renderWorkingNotesHtml(message?.content ?? "", {
          cleanAgentText: Boolean(isAgentOutputFormattingEnabled()),
          workingNotesKey,
          workingNotesOpen: isWorkingNotesPanelOpen(
            workingNotesKey,
            shouldDefaultWorkingNotesOpen(message, this.messages[0] === message),
          ),
          workingNotesLabel,
          config: state.config,
          ...cacheOptions,
        });
      }
      return renderChatMessageHtml(message?.content ?? "", {
        cleanAgentText: Boolean(isAgentOutputFormattingEnabled() && shouldFormatAgentMessage(message)),
        config: state.config,
        ...cacheOptions,
      });
    },

    getMessageClass(message) {
      const role = String(message?.role ?? message?.type ?? "assistant").toLowerCase();
      if (role === "user") return message?.queued ? "user wm-message--queued" : "user";
      if (role === "assistant" || role === "agent" || role.startsWith("agent-")) return "assistant";
      return "system";
    },

    isErrorMessage(message) {
      return isErrorMessage(message);
    },

    get emptySessionInformation() {
      const session = Alpine.store("sessions")?.items?.find?.((item) => item.id === this.sessionId) ?? null;
      return buildEmptySessionInformation(session);
    },

    getSpeechSummary(message) {
      return typeof message?.speech?.summary === "string" ? message.speech.summary.trim() : "";
    },

    getMessageTimestamp(message) {
      return formatMessageTimestampLabel(message);
    },

    isWorkingMessageTimestamp(message) {
      return isWorkingMessageTimestamp(message);
    },

    getMessageTimestampDateTime(message) {
      return getMessageTimestampDateTime(message);
    },

    getMessageTimestampAriaLabel(message) {
      return getMessageTimestampAriaLabel(message);
    },

    canReadMessage(message) {
      return isReadableAgentMessage(message);
    },

    async playMessageSpeech(message, button) {
      if (!this.sessionId) return;
      if (this.isMessageSpeechPlaying(message)) {
        stopSpeechPlayback();
        return;
      }
      await readMessageAloud({
        sessionId: this.sessionId,
        message,
        button,
        showToast: (messageText, options = {}) => {
          const level = options.type === "error" ? "error" : "warn";
          console[level]("[chat] speech playback", messageText);
        },
      });
    },

    getMessageSpeechKey(message) {
      return this.sessionId ? getMessageSpeechKey(this.sessionId, message) : "";
    },

    isMessageSpeechPlaying(message) {
      const key = this.getMessageSpeechKey(message);
      return Boolean(key && key === this.speechPlaybackKey);
    },

    getMessageSpeechLabel(message) {
      if (this.isMessageSpeechPlaying(message)) {
        return "Stop spoken summary";
      }
      return message?.speech?.publicPath ? "Play spoken summary" : "Generate spoken summary";
    },

    _scheduleSpeechWork() {
      if (!this.sessionId || !Array.isArray(this.messages)) {
        return;
      }
      if (this.isBusy) {
        return;
      }
      const latestSpeechKey = getLatestAssistantSpeechKey(this.sessionId, this.messages);
      if (!this._speechBaselineReady) {
        this._speechBaselineReady = true;
        this._lastSpeechCandidateKey = latestSpeechKey;
        return;
      }
      if (this.messages.length === 0 || !latestSpeechKey || latestSpeechKey === this._lastSpeechCandidateKey) {
        return;
      }
      this._lastSpeechCandidateKey = latestSpeechKey;
      const session = window.Alpine?.store("sessions")?.items?.find?.((item) => item.id === this.sessionId) ?? null;
      if (!isSessionSpeechGenerationEnabled(session)) {
        return;
      }
      if (!isSessionAlwaysReadEnabled(session)) {
        void ensureLatestAssistantSpeech({
          sessionId: this.sessionId,
          session,
          conversation: this.messages,
          showToast: (messageText, options = {}) => {
            const level = options.type === "error" ? "error" : "warn";
            console[level]("[chat] speech generation", messageText);
          },
        });
        return;
      }
      void autoReadLatestAssistantMessage({
        sessionId: this.sessionId,
        session,
        conversation: this.messages,
        showToast: (messageText, options = {}) => {
          const level = options.type === "error" ? "error" : "warn";
          console[level]("[chat] auto speech", messageText);
        },
      });
    },

    /**
     * Check if agent is busy.
     * @returns {boolean}
     */
    get isBusy() {
      return this.status === "running";
    },

    get isWaitingForPermission() {
      return this.permissions.length > 0;
    },

    isIntermediateAssistantMessage(message) {
      if (!this.isBusy || !isReadableAgentMessage(message)) return false;
      const timeline = this.timelineMessages;
      const messageIndex = timeline.findIndex((entry) => entry.id === message.id);
      const latestUserIndex = timeline.findLastIndex((entry) => {
        const role = String(entry?.role ?? entry?.type ?? "").toLowerCase();
        return role === "user";
      });
      return messageIndex > latestUserIndex;
    },

    get timelineMessages() {
      return mergeConversationWithQueuedPrompts(this.messages, this.queuedPrompts);
    },

    getPermissionActions(permission) {
      return buildPermissionActions(permission);
    },

    get visibleMessages() {
      const timeline = this.timelineMessages;
      const visibleCount = Math.min(timeline.length, this.messageWindow?.visibleCount ?? LIVE_MESSAGE_WINDOW_DEFAULT);
      if (visibleCount <= 0 || visibleCount >= timeline.length) {
        return timeline;
      }
      return timeline.slice(-visibleCount);
    },

    get hiddenMessageCount() {
      const timelineLength = this.timelineMessages.length;
      const visibleCount = Math.min(timelineLength, this.messageWindow?.visibleCount ?? LIVE_MESSAGE_WINDOW_DEFAULT);
      return Math.max(0, timelineLength - visibleCount);
    },

    get revealOlderLabel() {
      const nextStep = Math.min(LIVE_MESSAGE_PAGE_SIZE, this.hiddenMessageCount);
      return `Show ${nextStep} older message${nextStep === 1 ? "" : "s"}`;
    },

    get windowSummary() {
      if (this.hiddenMessageCount <= 0) {
        return "";
      }
      const timelineLength = this.timelineMessages.length;
      const visibleCount = Math.min(timelineLength, this.messageWindow?.visibleCount ?? LIVE_MESSAGE_WINDOW_DEFAULT);
      return `Showing the latest ${visibleCount} of ${timelineLength} messages to keep long sessions responsive on mobile.`;
    },

    /**
     * Get connection status label.
     * @returns {string}
     */
    get connectionLabel() {
      switch (this.connectionState) {
        case "connected":
          if (this.streamMode === "heartbeat-only") {
            return "Heartbeat";
          }
          if (this.streamMode === "degraded") {
            return "Recovering";
          }
          return "Live";
        case "connecting":
          return "Connecting...";
        default:
          return "Disconnected";
      }
    },
  });

  // Register the chat message component
  Alpine.data("chatMessage", (message) => ({
    message,
    get formatted() {
      return Alpine.store("chat").formatMessage(this.message);
    },
  }));

  console.log("[chat] Alpine chat component registered");
}

/**
 * Initialize Alpine.js for the chat component.
 * Should be called once when the app starts.
 */
export function initAlpineChat() {
  if (!isAlpineChatEnabled()) {
    console.log("[chat] Alpine chat disabled by feature flag");
    return false;
  }

  // Register component before starting Alpine
  registerChatComponent();

  // Start Alpine if not already started
  if (!window.Alpine) {
    window.Alpine = Alpine;
    Alpine.start();
    console.log("[chat] Alpine.js started");
  }

  return true;
}

/**
 * Get the HTML template for the Alpine chat component.
 * This replaces the existing chat container when Alpine is enabled.
 * @param {string} sessionId - The session to initialize the chat for
 * @returns {string}
 */
export function getChatTemplate(sessionId) {
  const sid = sessionId || window.wingman?.activeSessionId || "";
  return `
<div x-data x-init="$store.chat.loadSession('${sid}')"
     class="chat-container alpine-chat"
     @session-change.window="$store.chat.loadSession($event.detail.sessionId)">

  <!-- Connection status indicator -->
  <div class="chat-status-bar" :class="{ 'connected': $store.chat.connectionState === 'connected', 'connecting': $store.chat.connectionState === 'connecting' }">
    <span class="status-dot" :class="$store.chat.connectionState"></span>
    <span x-text="$store.chat.connectionLabel"></span>
    <template x-if="$store.chat.isWaitingForPermission">
      <span class="busy-indicator waiting-permission" role="status" aria-live="assertive" data-testid="waiting-for-permission">Waiting for permission</span>
    </template>
    <template x-if="$store.chat.isBusy && !$store.chat.isWaitingForPermission">
      <span class="busy-indicator">Agent working...</span>
    </template>
  </div>

  <!-- Loading state -->
  <template x-if="$store.chat.isLoading">
    <div class="chat-loading">
      <span>Loading messages...</span>
    </div>
  </template>

  <!-- Error state -->
  <template x-if="$store.chat.error">
    <div class="chat-error" role="alert" aria-live="assertive">
      <span x-text="$store.chat.error"></span>
    </div>
  </template>

  <!-- Messages container -->
  <div x-ref="chatContainer" class="wm-conversation" :class="{ 'loading': $store.chat.isLoading }">
    <template x-if="$store.chat.hiddenMessageCount > 0">
      <div class="wm-conversation-window-notice">
        <button
          type="button"
          class="wm-conversation-window-button"
          data-testid="conversation-show-older"
          :aria-label="$store.chat.revealOlderLabel + ' in this session'"
          x-text="$store.chat.revealOlderLabel"
          @click="$store.chat.revealOlderMessages($el.closest('.wm-live-conversation'))">
        </button>
        <p class="wm-conversation-window-summary" x-text="$store.chat.windowSummary"></p>
      </div>
    </template>

    <template x-for="message in $store.chat.visibleMessages" :key="message.id">
      <article class="wm-message"
               :data-role="(message.role || message.type || 'assistant').toLowerCase()"
               :role="$store.chat.isErrorMessage(message) ? 'alert' : null"
               :aria-live="$store.chat.isErrorMessage(message) ? 'assertive' : null"
               :data-testid="$store.chat.isErrorMessage(message) ? 'agent-error-message' : null"
               :class="$store.chat.getMessageClass(message)">
        <template x-if="!$store.chat.isEditingQueuedPrompt(message)">
          <div class="wm-message-body" x-html="$store.chat.renderMessageContent(message)"></div>
        </template>
        <template x-if="$store.chat.isEditingQueuedPrompt(message)">
          <form class="wm-queued-prompt-editor"
                data-testid="queued-prompt-inline-editor"
                @submit.prevent="$store.chat.saveQueuedPromptEdit(message)"
                @click.stop>
            <textarea
              class="wm-queued-prompt-editor__input"
              data-testid="queued-prompt-edit-input"
              :id="$store.chat.getQueuedPromptEditorId(message)"
              aria-label="Edit queued prompt"
              rows="4"
              :value="$store.chat.queuedPromptEdit.draft"
              :disabled="$store.chat.queuedPromptEdit.saving"
              @input="$store.chat.updateQueuedPromptDraft($event.target.value)"
              @keydown.escape.prevent="$store.chat.cancelQueuedPromptEdit()"></textarea>
            <p class="wm-queued-prompt-editor__status"
               role="status"
               aria-live="polite"
               data-testid="queued-prompt-edit-status"
               x-show="$store.chat.queuedPromptEdit.error"
               x-text="$store.chat.queuedPromptEdit.error"></p>
            <div class="wm-queued-prompt-editor__actions">
              <button type="submit"
                      class="wm-button small"
                      data-testid="queued-prompt-edit-done"
                      aria-label="Done editing queued prompt"
                      :disabled="$store.chat.queuedPromptEdit.saving"
                      x-text="$store.chat.queuedPromptEdit.saving ? 'Saving...' : 'Done'"></button>
              <button type="button"
                      class="wm-button small secondary"
                      data-testid="queued-prompt-edit-cancel"
                      aria-label="Cancel editing queued prompt"
                      :disabled="$store.chat.queuedPromptEdit.saving"
                      @click="$store.chat.cancelQueuedPromptEdit()">Cancel</button>
            </div>
          </form>
        </template>
        <template x-if="$store.chat.isIntermediateAssistantMessage(message)">
          <span class="wm-message-intermediate-state" role="status" data-testid="intermediate-agent-output">Intermediate · agent loop still running</span>
        </template>
        <template x-if="message.queued">
          <span class="wm-message-queued-state" role="status" data-testid="queued-prompt-state">Queued</span>
        </template>
        <template x-if="$store.chat.getSpeechSummary(message)">
          <p class="wm-message-speech-summary"
             data-testid="message-speech-summary"
             x-text="$store.chat.getSpeechSummary(message)">
          </p>
        </template>
        <div class="wm-message-actions">
          <template x-if="$store.chat.getMessageTimestamp(message)">
            <time class="wm-message-timestamp"
                  :class="{ 'wm-message-timestamp--working': $store.chat.isWorkingMessageTimestamp(message) }"
                  data-testid="message-timestamp"
                  :datetime="$store.chat.getMessageTimestampDateTime(message)"
                  :aria-label="$store.chat.getMessageTimestampAriaLabel(message)"
                  x-text="$store.chat.getMessageTimestamp(message)"></time>
          </template>
          <template x-if="$store.chat.canReadMessage(message)">
            <button type="button"
                    class="wm-message-speech-play"
                    data-testid="message-speech-play"
                    :aria-label="$store.chat.getMessageSpeechLabel(message)"
                    :title="$store.chat.getMessageSpeechLabel(message)"
                    :data-playing="$store.chat.isMessageSpeechPlaying(message) ? 'true' : 'false'"
                    @click.stop="$store.chat.playMessageSpeech(message, $el)">
              <template x-if="!$store.chat.isMessageSpeechPlaying(message)">
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
              </template>
              <template x-if="$store.chat.isMessageSpeechPlaying(message)">
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>
              </template>
            </button>
          </template>
          <template x-if="message.queued && !$store.chat.isEditingQueuedPrompt(message)">
            <button type="button"
                    class="wm-message-edit"
                    data-testid="queued-prompt-edit"
                    aria-label="Edit queued prompt"
                    title="Edit queued prompt"
                    @click.stop="$store.chat.editQueuedPrompt(message)">
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M4 17.25V21h3.75L18.81 9.94l-3.75-3.75L4 17.25zm16.71-10.04a1 1 0 0 0 0-1.42l-2.5-2.5a1 1 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 2-1.66z"/></svg>
            </button>
          </template>
          <template x-if="message.queued && !$store.chat.isEditingQueuedPrompt(message)">
            <button type="button"
                    class="wm-message-delete"
                    data-testid="queued-prompt-delete"
                    aria-label="Delete queued prompt"
                    title="Delete queued prompt"
                    :disabled="message.deleting"
                    @click.stop="$store.chat.deleteQueuedPrompt(message)">
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM8 4l1-1h6l1 1h4v2H4V4h4z"/></svg>
            </button>
          </template>
          <button type="button" class="wm-message-copy" data-testid="message-copy" aria-label="Copy message"
                  @click.stop="
                    const text = message.content || '';
                    if (text && navigator.clipboard?.writeText) {
                      navigator.clipboard.writeText(text).then(() => {
                        $el.closest('.wm-message').dataset.copied = 'true';
                        setTimeout(() => { delete $el.closest('.wm-message').dataset.copied }, 1600);
                      });
                    }
                  ">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M15 3H7a2 2 0 0 0-2 2v10h2V5h8V3zm4 4h-8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zm0 12h-8V9h8v10z"/></svg>
          </button>
        </div>
      </article>
    </template>

    <!-- Empty state -->
    <template x-if="!$store.chat.isLoading && $store.chat.timelineMessages.length === 0 && $store.chat.emptySessionInformation">
      <article class="wm-message system wm-session-information" data-role="system" data-testid="session-information-message">
        <div class="wm-message-body">
          <strong x-text="$store.chat.emptySessionInformation.title"></strong>
          <dl class="wm-session-information-details">
            <dt>Agent</dt><dd x-text="$store.chat.emptySessionInformation.agent"></dd>
            <dt>Directory</dt><dd x-text="$store.chat.emptySessionInformation.workingDirectory"></dd>
            <dt x-text="$store.chat.emptySessionInformation.modelLabel || 'Selected model'"></dt><dd x-text="$store.chat.emptySessionInformation.model"></dd>
          </dl>
        </div>
      </article>
    </template>

    <template x-if="!$store.chat.isLoading && $store.chat.timelineMessages.length === 0 && !$store.chat.emptySessionInformation">
      <div class="chat-empty">
        <span>Session ready. Send a message to begin.</span>
      </div>
    </template>
  </div>

  <section
    class="wm-permission-requests"
    aria-label="Agent permission requests"
    aria-live="assertive"
    data-testid="agent-permission-requests"
    x-show="$store.chat.permissions.length > 0"
  >
    <template x-for="permission in $store.chat.permissions" :key="permission.id">
      <article class="wm-permission-request" data-testid="agent-permission-request">
        <div class="wm-permission-request__copy">
          <strong>Waiting for permission</strong>
          <span x-text="permission.pattern ? (Array.isArray(permission.pattern) ? permission.pattern.join(', ') : permission.pattern) : permission.title"></span>
        </div>
        <div class="wm-permission-request__actions">
          <template x-for="action in $store.chat.getPermissionActions(permission)" :key="action.response">
            <button
              type="button"
              :disabled="permission.responding"
              :aria-disabled="permission.responding ? 'true' : 'false'"
              :aria-label="action.label + ' for agent permission'"
              :data-testid="action.testId"
              x-text="action.label"
              @click="$store.chat.respondToPermission(permission, action.response)">
            </button>
          </template>
          <span
            class="wm-permission-request__missing-actions"
            role="alert"
            x-show="$store.chat.getPermissionActions(permission).length === 0">
            The agent exposed no compatible permission choices. Cancel the turn or inspect the runtime error.
          </span>
        </div>
      </article>
    </template>
  </section>
</div>
`;
}

// Export Alpine for direct use if needed
export { Alpine };
