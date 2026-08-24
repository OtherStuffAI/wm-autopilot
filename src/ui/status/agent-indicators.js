/**
 * Agent status indicators, knight rider animation, conversation/log DOM updates.
 *
 * Depends on: state, queue helpers, clipboard/text utilities (via DI).
 */

import {
  createConversationElement,
  expandConversationWindow,
  capturePrependedScrollState,
  schedulePrependedScrollRestore,
} from "../live/conversation-window.js";
import { MessageStore } from "../live/index.js";
import { getAgentStatusIndicatorPresentation } from "./agent-status-presentation.js";

export function initAgentIndicators(deps) {
  const {
    state,
    sessionsStore,
    getCurrentRoute,
    getQueueCount,
    isSessionBusy,
    openPromptQueueModal,
  } = deps;

  let debounceTimer = null;

  // ── Status resolution ───────────────────────────────────────────

  const resolveAgentRuntimeStatus = (sessionId) => {
    const session = sessionsStore().items.find((entry) => entry && entry.id === sessionId);
    if (!session) {
      return null;
    }
    // Session is no longer running — ignore stale agentRuntimeStatus
    if (session.status === "stopped" || session.status === "error") {
      return null;
    }
    if (session.agentRuntimeStatus === "running" || session.agentRuntimeStatus === "stable") {
      return session.agentRuntimeStatus;
    }
    if (session.status === "running") {
      return "running";
    }
    return null;
  };

  // ── Indicator DOM ───────────────────────────────────────────────

  const applyAgentStatusIndicatorState = (indicator, sessionId) => {
    const status = resolveAgentRuntimeStatus(sessionId);
    const variant = indicator.dataset.variant ?? "bar";
    const preservedClasses = indicator.className
      .split(" ")
      .filter(
        (cls) =>
          cls &&
          (cls === "wm-agent-status-indicator" ||
            cls === "status-small" ||
            cls.startsWith("wm-agent-status-") ||
            !cls.startsWith("status-")),
      );
    const baseClasses = new Set(preservedClasses.length > 0 ? preservedClasses : ["wm-agent-status-indicator"]);
    baseClasses.add("wm-agent-status-indicator");
    for (const value of Array.from(baseClasses)) {
      if (value.startsWith("status-") && value !== "status-small") {
        baseClasses.delete(value);
      }
    }

    if (status === "running") {
      baseClasses.add("status-running");
    } else if (status === "stable") {
      baseClasses.add("status-stable");
    } else {
      baseClasses.add("status-unknown");
    }

    indicator.className = Array.from(baseClasses).join(" ");
    const queueCount = getQueueCount(sessionId);
    const presentation = getAgentStatusIndicatorPresentation(status, queueCount);
    indicator.setAttribute("aria-label", presentation.ariaLabel);

    indicator.textContent =
      variant === "pill"
        ? presentation.pillLabel
        : "";
  };

  const createAgentStatusIndicator = (sessionId, options = {}) => {
    const variant = typeof options.variant === "string" ? options.variant : "bar";
    const indicator = document.createElement(variant === "pill" ? "button" : "div");
    indicator.className = "wm-agent-status-indicator";
    indicator.setAttribute("data-session-id", sessionId);
    indicator.setAttribute("role", "status");
    indicator.setAttribute("aria-live", "polite");
    indicator.dataset.variant = variant;

    if (variant === "pill") {
      indicator.classList.add("wm-agent-status-pill");
      indicator.type = "button";
    }

    indicator.style.cursor = "pointer";
    indicator.addEventListener("click", () => {
      openPromptQueueModal(sessionId);
    });

    applyAgentStatusIndicatorState(indicator, sessionId);
    return indicator;
  };

  // ── Batch update ────────────────────────────────────────────────

  const updateKnightRiderState = (targetSessionId) => {
    document.querySelectorAll(".wm-knight-rider").forEach((element) => {
      const sessionId = element.dataset.sessionId;
      if (targetSessionId && sessionId !== targetSessionId) return;
      const session = sessionsStore().items.find((s) => s.id === sessionId);
      const isBusy = isSessionBusy(session);
      const hasQueuedPrompts = getQueueCount(sessionId) > 0;
      element.classList.toggle("active", isBusy || hasQueuedPrompts);
    });
  };

  const updateAgentStatusIndicators = () => {
    if (getCurrentRoute() === "home") {
      return;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      document.querySelectorAll(".wm-agent-status-indicator").forEach((indicator) => {
        const sessionId = indicator.getAttribute("data-session-id");
        if (sessionId) {
          applyAgentStatusIndicatorState(indicator, sessionId);
        }
      });
      updateKnightRiderState();
      debounceTimer = null;
    }, 100);
  };

  // ── Conversation DOM ────────────────────────────────────────────

  const updateConversationDOM = async (sessionId) => {
    const conversation = await MessageStore.getSessionMessages(sessionId);
    const session = sessionsStore().items.find((item) => item.id === sessionId) ?? null;
    let container = state.conversationContainers.get(sessionId);

    if (!container || !document.contains(container)) {
      const conversationWrapper = document.querySelector('.wm-live-conversation .wm-conversation');
      if (!conversationWrapper) {
        return;
      }
      container = conversationWrapper;
      state.conversationContainers.set(sessionId, container);
    }

    const next = createConversationElement({
      sessionId,
      session,
      conversation,
      windowStore: state.liveMessageWindows,
      onRevealOlder: (scrollElement) => {
        const snapshot = capturePrependedScrollState(scrollElement);
        expandConversationWindow(state.liveMessageWindows, sessionId, conversation.length);
        void updateConversationDOM(sessionId);
        schedulePrependedScrollRestore(snapshot);
      },
    });

    if (container.parentNode) {
      container.replaceWith(next);
    }

    state.conversationContainers.set(sessionId, next);
    state.lastMessageCount.set(sessionId, conversation.length);
  };

  // ── Logs DOM ────────────────────────────────────────────────────

  const updateLogsDOM = (sessionId) => {
    let container = state.logContainers.get(sessionId);

    if (!container || !document.contains(container)) {
      const logViewer = document.querySelector('.wm-log-panel .log-viewer');
      if (logViewer) {
        container = logViewer;
        state.logContainers.set(sessionId, container);
        const currentLines = container.textContent.split('\n').filter(l => l.length > 0);
        state.lastLogLength.set(sessionId, currentLines.length);
      } else {
        return;
      }
    }

    const logs = state.logs.get(sessionId) ?? [];
    const lastLength = state.lastLogLength.get(sessionId) ?? 0;

    if (logs.length !== lastLength || logs.join("\n") !== container.textContent) {
      container.textContent = logs.join("\n");
      state.lastLogLength.set(sessionId, logs.length);
    }
  };

  return {
    resolveAgentRuntimeStatus,
    createAgentStatusIndicator,
    updateAgentStatusIndicators,
    updateKnightRiderState,
    updateConversationDOM,
    updateLogsDOM,
  };
}
