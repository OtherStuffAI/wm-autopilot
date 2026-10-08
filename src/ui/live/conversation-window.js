import { createMessageBubble } from "./chat-message-bubble.js";
import { buildEmptySessionInformation, createSessionInformationBubble } from "./session-information.js";

export {
  LIVE_MESSAGE_WINDOW_DEFAULT, LIVE_MESSAGE_PAGE_SIZE, createWindowRecord,
  syncConversationWindow, expandConversationWindow, resetConversationWindow,
  getConversationWindowSnapshot,
} from "./conversation-window-state.js";
import { LIVE_MESSAGE_PAGE_SIZE, getConversationWindowSnapshot } from "./conversation-window-state.js";

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
    onRevealOlder?.(scrollElement, snapshot.totalCount);
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
