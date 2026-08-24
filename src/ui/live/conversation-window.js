import { attachCopyButton } from "../utils/clipboard.js";
import {
  getChatMessageHtmlCacheOptions,
  renderChatMessageHtml,
  renderWorkingNotesHtml,
} from "../rendering/chat-message-content.js";
import { attachMessageSpeechButton } from "./message-speech.js";
import { getWorkingNotesPanelKey, isWorkingNotesPanelOpen } from "./working-notes-toggle.js";
import { shouldDefaultWorkingNotesOpen } from "./working-notes-display.js";
import { buildEmptySessionInformation, createSessionInformationBubble } from "./session-information.js";

export const LIVE_MESSAGE_WINDOW_DEFAULT = 80;
export const LIVE_MESSAGE_PAGE_SIZE = 80;

function clampVisibleCount(totalCount, visibleCount) {
  const safeTotal = Math.max(0, totalCount);
  const safeVisible = Math.max(0, Math.trunc(visibleCount));
  return Math.min(safeTotal, safeVisible);
}

export function createWindowRecord(totalCount, visibleCount = LIVE_MESSAGE_WINDOW_DEFAULT) {
  return {
    visibleCount: clampVisibleCount(totalCount, visibleCount),
    lastTotal: Math.max(0, totalCount),
  };
}

export function syncConversationWindow(windowStore, sessionId, totalCount) {
  const safeTotal = Math.max(0, totalCount);
  const current = windowStore.get(sessionId);
  if (!current) {
    const initial = createWindowRecord(safeTotal, LIVE_MESSAGE_WINDOW_DEFAULT);
    windowStore.set(sessionId, initial);
    return initial;
  }

  const previousTotal = Math.max(0, current.lastTotal ?? 0);
  const next = {
    visibleCount: clampVisibleCount(safeTotal, current.visibleCount ?? LIVE_MESSAGE_WINDOW_DEFAULT),
    lastTotal: safeTotal,
  };

  if (safeTotal <= LIVE_MESSAGE_WINDOW_DEFAULT) {
    next.visibleCount = safeTotal;
  } else if (next.visibleCount === 0) {
    next.visibleCount = Math.min(safeTotal, LIVE_MESSAGE_WINDOW_DEFAULT);
  } else if (next.visibleCount >= previousTotal) {
    next.visibleCount = safeTotal;
  }

  windowStore.set(sessionId, next);
  return next;
}

export function expandConversationWindow(windowStore, sessionId, totalCount, step = LIVE_MESSAGE_PAGE_SIZE) {
  const current = syncConversationWindow(windowStore, sessionId, totalCount);
  const next = {
    visibleCount: clampVisibleCount(totalCount, current.visibleCount + Math.max(1, Math.trunc(step))),
    lastTotal: Math.max(0, totalCount),
  };
  windowStore.set(sessionId, next);
  return next;
}

export function resetConversationWindow(windowStore, sessionId) {
  windowStore.delete(sessionId);
}

export function getConversationWindowSnapshot(windowStore, sessionId, conversation) {
  const items = Array.isArray(conversation) ? conversation : [];
  const totalCount = items.length;
  const windowRecord = syncConversationWindow(windowStore, sessionId, totalCount);
  const visibleCount = clampVisibleCount(totalCount, windowRecord.visibleCount);
  const hiddenCount = Math.max(0, totalCount - visibleCount);
  const visibleMessages = hiddenCount > 0 ? items.slice(-visibleCount) : items;

  return {
    totalCount,
    visibleCount,
    hiddenCount,
    visibleMessages,
  };
}

export function capturePrependedScrollState(scrollElement) {
  if (!(scrollElement instanceof HTMLElement)) {
    return null;
  }
  return {
    element: scrollElement,
    scrollHeight: scrollElement.scrollHeight,
    scrollTop: scrollElement.scrollTop,
  };
}

export function schedulePrependedScrollRestore(snapshot) {
  if (!snapshot?.element) {
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const { element, scrollHeight, scrollTop } = snapshot;
      if (!(element instanceof HTMLElement) || !element.isConnected) {
        return;
      }
      const delta = element.scrollHeight - scrollHeight;
      if (delta > 0) {
        element.scrollTop = scrollTop + delta;
      }
    });
  });
}

function buildRevealOlderLabel(hiddenCount) {
  const nextStep = Math.min(LIVE_MESSAGE_PAGE_SIZE, hiddenCount);
  return `Show ${nextStep} older message${nextStep === 1 ? "" : "s"}`;
}

function buildWindowSummary(hiddenCount, totalCount, visibleCount) {
  if (hiddenCount <= 0) {
    return "";
  }
  return `Showing the latest ${visibleCount} of ${totalCount} messages to keep long sessions responsive on mobile.`;
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

function getSpeechSummary(message) {
  const summary = typeof message?.speech?.summary === "string" ? message.speech.summary.trim() : "";
  return summary;
}

function createSpeechSummaryElement(summary) {
  const element = document.createElement("p");
  element.className = "wm-message-speech-summary";
  element.dataset.testid = "message-speech-summary";
  element.textContent = summary;
  return element;
}

function createMessageBubble(message, options = {}) {
  const role = String(message?.role ?? message?.type ?? "assistant").toLowerCase();
  const bubble = document.createElement("article");
  const styleRole = isWorkingNotesMessage(message) ? "assistant" : role;
  bubble.className = `wm-message ${styleRole}`;
  bubble.dataset.role = role;
  const body = document.createElement("div");
  body.className = "wm-message-body";
  const workingNotesKey = isWorkingNotesMessage(message)
    ? getWorkingNotesPanelKey(options.sessionId, message)
    : null;
  const workingNotesLabel = isWorkingNotesMessage(message) ? getWorkingNotesLabel(message) : null;
  const cacheOptions = getChatMessageHtmlCacheOptions(message, { sessionId: options.sessionId });
  body.innerHTML = isWorkingNotesMessage(message)
    ? renderWorkingNotesHtml(message.content ?? message.message ?? "", {
        cleanAgentText: Boolean(options.agentOutputFormattingEnabled),
        workingNotesKey,
        workingNotesOpen: isWorkingNotesPanelOpen(
          workingNotesKey,
          shouldDefaultWorkingNotesOpen(message, options.isFirstMessage),
        ),
        workingNotesLabel,
        config: options.config,
        ...cacheOptions,
      })
    : renderChatMessageHtml(message.content ?? message.message ?? "", {
        cleanAgentText: Boolean(options.agentOutputFormattingEnabled && shouldFormatAgentMessage(message)),
        config: options.config,
        ...cacheOptions,
      });
  bubble.append(body);
  const speechSummary = getSpeechSummary(message);
  if (speechSummary) {
    bubble.append(createSpeechSummaryElement(speechSummary));
  }
  attachCopyButton(bubble);
  attachMessageSpeechButton(bubble, {
    sessionId: options.sessionId,
    message,
    showToast: options.showToast,
  });
  return bubble;
}

function createWindowNotice(snapshot, onRevealOlder) {
  const notice = document.createElement("div");
  notice.className = "wm-conversation-window-notice";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-conversation-window-button";
  button.textContent = buildRevealOlderLabel(snapshot.hiddenCount);
  button.setAttribute("aria-label", `${buildRevealOlderLabel(snapshot.hiddenCount)} in this session`);
  button.dataset.testid = "conversation-show-older";
  button.addEventListener("click", () => {
    const scrollElement = button.closest(".wm-live-conversation");
    onRevealOlder?.(scrollElement);
  });

  const summary = document.createElement("p");
  summary.className = "wm-conversation-window-summary";
  summary.textContent = buildWindowSummary(snapshot.hiddenCount, snapshot.totalCount, snapshot.visibleCount);

  notice.append(button, summary);
  return notice;
}

export function createConversationElement(options) {
  const {
    sessionId,
    conversation,
    windowStore,
    onRevealOlder,
    agentOutputFormattingEnabled = false,
    showToast = null,
  } = options;
  const snapshot = getConversationWindowSnapshot(windowStore, sessionId, conversation);

  const wrapper = document.createElement("div");
  wrapper.className = "wm-conversation";
  wrapper.dataset.sessionId = sessionId;
  wrapper.dataset.totalMessages = String(snapshot.totalCount);
  wrapper.dataset.visibleMessages = String(snapshot.visibleCount);

  if (snapshot.totalCount === 0) {
    const information = buildEmptySessionInformation(options.session);
    if (information) {
      wrapper.append(createSessionInformationBubble(information));
      return wrapper;
    }
    const empty = document.createElement("p");
    empty.textContent = "Session ready. Send a message to begin.";
    wrapper.append(empty);
    return wrapper;
  }

  if (snapshot.hiddenCount > 0) {
    wrapper.append(createWindowNotice(snapshot, onRevealOlder));
  }

  snapshot.visibleMessages.forEach((message) => {
    wrapper.append(createMessageBubble(message, {
      agentOutputFormattingEnabled,
      config: options.config,
      isFirstMessage: conversation[0] === message,
      sessionId,
      showToast,
    }));
  });

  return wrapper;
}
