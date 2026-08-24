/**
 * Floating chat scroll pill indicators.
 *
 * Shows small pills above the composer for jumping between user prompts and
 * scrolling back to the bottom.
 */

const THRESHOLD = 50;
const PILL_VISIBLE_DURATION_MS = 3000;
const PROMPT_SCROLL_GAP_PX = 8;
const USER_MESSAGE_SELECTOR = '.wm-message[data-role="user"]';
const HEADER_OFFSET_FALLBACK = 12;

function isDocumentScrollTarget(el) {
  return (
    el === document.body ||
    el === document.documentElement ||
    el === document.scrollingElement
  );
}

function getHeaderInset(scrollTarget) {
  const header = document.querySelector(".wm-header");
  if (!header) {
    return HEADER_OFFSET_FALLBACK;
  }
  if (isDocumentScrollTarget(scrollTarget)) {
    return Math.max(HEADER_OFFSET_FALLBACK, header.getBoundingClientRect().height);
  }
  const containerRect = getScrollContainerRect(scrollTarget);
  const headerRect = header.getBoundingClientRect();
  if (headerRect.height <= 0) {
    return HEADER_OFFSET_FALLBACK;
  }
  const overlap = headerRect.bottom - containerRect.top;
  return Math.max(HEADER_OFFSET_FALLBACK, overlap);
}

function clampScrollTop(scrollTop, scrollElement) {
  const maxTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  return Math.max(0, Math.min(maxTop, scrollTop));
}

function scrollToElementAtTop(scrollElement, element) {
  if (!scrollElement || !(scrollElement instanceof HTMLElement) || !element || !(element instanceof HTMLElement)) {
    return;
  }
  const targetRect = element.getBoundingClientRect();
  const containerRect = getScrollContainerRect(scrollElement);
  const headerInset = getHeaderInset(scrollElement);

  if (isDocumentScrollTarget(scrollElement)) {
    const currentTop = window.scrollY || (document.scrollingElement?.scrollTop ?? 0);
    const targetTop = currentTop + (targetRect.top - containerRect.top) - headerInset;
    window.scrollTo({ top: targetTop, behavior: "smooth" });
    return;
  }

  const targetOffset = scrollElement.scrollTop + (targetRect.top - containerRect.top) - headerInset;
  const finalTop = clampScrollTop(targetOffset, scrollElement);
  scrollElement.scrollTo({ top: finalTop, behavior: "smooth" });
}

function createPillState() {
  return {
    pillEl: null,
    scrollTarget: null,
    conversationElement: null,
    scrollListener: null,
    scrollListenerTarget: null,
    resizeListener: null,
    mutationObserver: null,
    visibilityTimer: null,
  };
}

const bottomPillState = createPillState();
const lastPromptPillState = createPillState();
const nextPromptPillState = createPillState();

function resolveListenerTarget(el) {
  if (el === document.body || el === document.documentElement || el === document.scrollingElement) {
    return window;
  }
  return el;
}

function getScrollContainerRect(el) {
  if (el === document.body || el === document.documentElement || el === document.scrollingElement) {
    return {
      top: 0,
      bottom: window.innerHeight,
      left: 0,
      right: window.innerWidth,
    };
  }
  return el.getBoundingClientRect();
}

function checkNearBottom(el) {
  if (!el) return true;
  if (el === document.body || el === document.documentElement || el === document.scrollingElement) {
    const doc = document.scrollingElement || document.documentElement || document.body;
    return doc.scrollHeight - doc.scrollTop - doc.clientHeight < THRESHOLD;
  }
  return el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD;
}

function cleanupPillState(state) {
  if (state.visibilityTimer) {
    clearTimeout(state.visibilityTimer);
  }
  if (state.scrollListenerTarget && state.scrollListener) {
    state.scrollListenerTarget.removeEventListener("scroll", state.scrollListener);
  }
  if (state.mutationObserver) {
    state.mutationObserver.disconnect();
  }
  if (state.resizeListener) {
    window.removeEventListener("resize", state.resizeListener);
  }
  if (state.pillEl && state.pillEl.parentNode) {
    state.pillEl.parentNode.removeChild(state.pillEl);
  }
  state.pillEl = null;
  state.scrollTarget = null;
  state.conversationElement = null;
  state.scrollListener = null;
  state.scrollListenerTarget = null;
  state.resizeListener = null;
  state.visibilityTimer = null;
}

function resolveConversationElement(scrollElement, conversationElement) {
  if (conversationElement instanceof Element) {
    if (conversationElement.isConnected) {
      return conversationElement;
    }
  }
  if (scrollElement?.querySelector instanceof Function) {
    const fromScroll = scrollElement.querySelector(".wm-live-conversation");
    if (fromScroll) {
      return fromScroll;
    }
  }
  const fallback = document.querySelector(".wm-live-conversation");
  if (fallback) {
    return fallback;
  }
  if (conversationElement instanceof Element) {
    return conversationElement;
  }
  return null;
}

function getUserMessages(conversationElement) {
  if (!(conversationElement instanceof Element)) {
    return [];
  }
  return Array.from(conversationElement.querySelectorAll(USER_MESSAGE_SELECTOR));
}

export function isMessageRectInView(messageRect, scrollRect, headerInset = 0) {
  return (
    messageRect.top >= scrollRect.top + headerInset &&
    messageRect.bottom <= scrollRect.bottom
  );
}

export function isMessageRectAboveView(messageRect, scrollRect, headerInset = 0) {
  return messageRect.bottom < scrollRect.top + headerInset;
}

export function isMessageRectBelowView(messageRect, scrollRect) {
  return messageRect.bottom > scrollRect.bottom;
}

export function findPreviousPromptRectIndex(messageRects, scrollAnchorTop, gapPx = PROMPT_SCROLL_GAP_PX) {
  if (!Array.isArray(messageRects) || !Number.isFinite(scrollAnchorTop)) {
    return -1;
  }
  const boundaryTop = scrollAnchorTop - gapPx;
  for (let index = messageRects.length - 1; index >= 0; index -= 1) {
    const top = Number(messageRects[index]?.top);
    if (Number.isFinite(top) && top < boundaryTop) {
      return index;
    }
  }
  return -1;
}

export function findNextPromptRectIndex(messageRects, scrollAnchorTop, gapPx = PROMPT_SCROLL_GAP_PX) {
  if (!Array.isArray(messageRects) || !Number.isFinite(scrollAnchorTop)) {
    return -1;
  }
  const boundaryTop = scrollAnchorTop + gapPx;
  for (let index = 0; index < messageRects.length; index += 1) {
    const top = Number(messageRects[index]?.top);
    if (Number.isFinite(top) && top > boundaryTop) {
      return index;
    }
  }
  return -1;
}

function getScrollAnchorTop(scrollElement) {
  if (!scrollElement) {
    return Number.NaN;
  }
  const scrollRect = getScrollContainerRect(scrollElement);
  return scrollRect.top + getHeaderInset(scrollElement);
}

function getPreviousUserMessageAboveScroll(conversationElement, scrollElement) {
  const messages = getUserMessages(conversationElement);
  if (!messages.length || !scrollElement) {
    return null;
  }
  const targetIndex = findPreviousPromptRectIndex(
    messages.map((message) => message.getBoundingClientRect()),
    getScrollAnchorTop(scrollElement),
  );
  return targetIndex >= 0 ? messages[targetIndex] : null;
}

function getNextUserMessageBelowScroll(conversationElement, scrollElement) {
  const messages = getUserMessages(conversationElement);
  if (!messages.length || !scrollElement) {
    return null;
  }
  const targetIndex = findNextPromptRectIndex(
    messages.map((message) => message.getBoundingClientRect()),
    getScrollAnchorTop(scrollElement),
  );
  return targetIndex >= 0 ? messages[targetIndex] : null;
}

function setPillVisible(state, visible) {
  if (!state?.pillEl) return;
  state.pillEl.dataset.visible = visible ? "true" : "false";
  state.pillEl.setAttribute("aria-hidden", visible ? "false" : "true");
  state.pillEl.tabIndex = visible ? 0 : -1;
}

function revealPillForDuration(state) {
  if (!state?.pillEl) return;
  if (state.visibilityTimer) {
    clearTimeout(state.visibilityTimer);
  }
  setPillVisible(state, true);
  state.visibilityTimer = setTimeout(() => {
    setPillVisible(state, false);
    state.visibilityTimer = null;
  }, PILL_VISIBLE_DURATION_MS);
}

function hasAnyUserMessage(state) {
  state.conversationElement = resolveConversationElement(state.scrollTarget, state.conversationElement);
  return getUserMessages(state.conversationElement).length > 0;
}

function revealScrollPillsForDuration() {
  revealPillForDuration(bottomPillState);
  if (hasAnyUserMessage(lastPromptPillState)) {
    revealPillForDuration(lastPromptPillState);
    revealPillForDuration(nextPromptPillState);
  } else {
    setPillVisible(lastPromptPillState, false);
    setPillVisible(nextPromptPillState, false);
  }
}

function fadeScrollPills() {
  setPillVisible(bottomPillState, false);
  setPillVisible(lastPromptPillState, false);
  setPillVisible(nextPromptPillState, false);
}

function handleScrollActivity() {
  revealScrollPillsForDuration();
}

function createPillButton({ className, text, ariaLabel, testId }) {
  const button = document.createElement("button");
  button.className = className;
  button.textContent = text;
  button.setAttribute("aria-label", ariaLabel);
  button.dataset.testid = testId;
  button.dataset.visible = "false";
  button.setAttribute("aria-hidden", "true");
  button.tabIndex = -1;
  return button;
}

/**
 * Create (or re-use) the floating pill and attach it to a parent container.
 * The parent should be position:sticky or position:relative so the pill can
 * anchor itself via position:absolute.
 *
 * @param {HTMLElement} parent  - element to append the pill into (e.g. composer-shell)
 * @param {HTMLElement} scrollElement - the scrollable element to watch & scroll
 * @param {HTMLElement} conversationElement - optional conversation wrapper
 */
export function attachScrollPill(parent, scrollElement, conversationElement = null) {
  cleanupPillState(bottomPillState);

  if (!parent || !scrollElement) return;

  bottomPillState.scrollTarget = scrollElement;
  bottomPillState.conversationElement = resolveConversationElement(scrollElement, conversationElement);

  const button = createPillButton({
    className: "wm-scroll-pill wm-scroll-pill--scroll-bottom",
    text: "Scroll to End",
    ariaLabel: "Scroll to end",
    testId: "scroll-to-bottom",
  });

  button.addEventListener("click", () => {
    if (!bottomPillState.scrollTarget) return;
    bottomPillState.scrollTarget.scrollTo({ top: bottomPillState.scrollTarget.scrollHeight, behavior: "smooth" });
    const docTarget = document.scrollingElement || document.documentElement || document.body;
    if (docTarget !== bottomPillState.scrollTarget) {
      docTarget.scrollTo({ top: docTarget.scrollHeight, behavior: "smooth" });
    }
    hide();
  });

  parent.appendChild(button);
  bottomPillState.pillEl = button;

  bottomPillState.scrollListener = () => {
    if (!bottomPillState.scrollTarget || !bottomPillState.pillEl) return;
    handleScrollActivity();
  };
  bottomPillState.scrollListenerTarget = resolveListenerTarget(scrollElement);
  bottomPillState.scrollListenerTarget.addEventListener("scroll", bottomPillState.scrollListener, { passive: true });

  bottomPillState.pillEl = button;
}

/**
 * Create and attach a "last prompt" pill next to the bottom scroll pill.
 *
 * @param {HTMLElement} parent  - fallback element to append the pill into
 * @param {HTMLElement} scrollElement - the scrollable element to watch
 * @param {HTMLElement} conversationElement - optional conversation wrapper
 */
export function attachLastPromptPill(parent, scrollElement, conversationElement = null) {
  cleanupPillState(lastPromptPillState);

  if (!parent || !scrollElement) return;

  lastPromptPillState.scrollTarget = scrollElement;
  lastPromptPillState.conversationElement = resolveConversationElement(scrollElement, conversationElement);

  const button = createPillButton({
    className: "wm-scroll-pill wm-scroll-pill--last-prompt",
    text: "Last Prompt",
    ariaLabel: "Scroll to last prompt",
    testId: "scroll-to-last-prompt",
  });

  button.addEventListener("click", () => {
    lastPromptPillState.conversationElement = resolveConversationElement(
      lastPromptPillState.scrollTarget,
      lastPromptPillState.conversationElement,
    );
    const previousMessage = getPreviousUserMessageAboveScroll(
      lastPromptPillState.conversationElement,
      lastPromptPillState.scrollTarget,
    );
    if (!previousMessage) {
      return;
    }
    scrollToElementAtTop(lastPromptPillState.scrollTarget, previousMessage);
    revealScrollPillsForDuration();
  });

  const pillParent = parent;
  pillParent.appendChild(button);
  lastPromptPillState.pillEl = button;

  lastPromptPillState.scrollListener = () => {
    if (!lastPromptPillState.scrollTarget || !lastPromptPillState.pillEl) return;
    handleScrollActivity();
  };
  lastPromptPillState.scrollListenerTarget = resolveListenerTarget(scrollElement);
  lastPromptPillState.scrollListenerTarget.addEventListener("scroll", lastPromptPillState.scrollListener, { passive: true });
  lastPromptPillState.resizeListener = () => {
    fadeScrollPills();
  };
  window.addEventListener("resize", lastPromptPillState.resizeListener, { passive: true });

  if (typeof MutationObserver === "function" && lastPromptPillState.conversationElement) {
    lastPromptPillState.mutationObserver = new MutationObserver(() => {
      if (!lastPromptPillState.pillEl) return;
      if (!hasAnyUserMessage(lastPromptPillState)) {
        setPillVisible(lastPromptPillState, false);
        setPillVisible(nextPromptPillState, false);
      }
    });
    lastPromptPillState.mutationObserver.observe(lastPromptPillState.conversationElement, {
      childList: true,
      subtree: true,
    });
  }

  lastPromptPillState.pillEl = button;
}

/**
 * Create and attach a "next prompt" pill between the prompt and bottom pills.
 *
 * @param {HTMLElement} parent  - fallback element to append the pill into
 * @param {HTMLElement} scrollElement - the scrollable element to watch
 * @param {HTMLElement} conversationElement - optional conversation wrapper
 */
export function attachNextPromptPill(parent, scrollElement, conversationElement = null) {
  cleanupPillState(nextPromptPillState);

  if (!parent || !scrollElement) return;

  nextPromptPillState.scrollTarget = scrollElement;
  nextPromptPillState.conversationElement = resolveConversationElement(scrollElement, conversationElement);

  const button = createPillButton({
    className: "wm-scroll-pill wm-scroll-pill--next-prompt",
    text: "Next Prompt",
    ariaLabel: "Scroll to next prompt",
    testId: "scroll-to-next-prompt",
  });

  button.addEventListener("click", () => {
    nextPromptPillState.conversationElement = resolveConversationElement(
      nextPromptPillState.scrollTarget,
      nextPromptPillState.conversationElement,
    );
    const nextMessage = getNextUserMessageBelowScroll(
      nextPromptPillState.conversationElement,
      nextPromptPillState.scrollTarget,
    );
    if (!nextMessage) {
      return;
    }
    scrollToElementAtTop(nextPromptPillState.scrollTarget, nextMessage);
    revealScrollPillsForDuration();
  });

  const pillParent = parent;
  pillParent.appendChild(button);
  nextPromptPillState.pillEl = button;

  nextPromptPillState.scrollListener = () => {
    if (!nextPromptPillState.scrollTarget || !nextPromptPillState.pillEl) return;
    handleScrollActivity();
  };
  nextPromptPillState.scrollListenerTarget = resolveListenerTarget(scrollElement);
  nextPromptPillState.scrollListenerTarget.addEventListener("scroll", nextPromptPillState.scrollListener, { passive: true });

  nextPromptPillState.pillEl = button;
}

/** Show the scroll pills temporarily (call when new content arrives and user is scrolled up). */
export function show() {
  revealScrollPillsForDuration();
}

/** Hide all scroll pills. */
export function hide() {
  fadeScrollPills();
}

export function hideLastPromptPill() {
  setPillVisible(lastPromptPillState, false);
}

/** Returns true if the scroll target is near the bottom. */
export function isNearBottom() {
  return checkNearBottom(bottomPillState.scrollTarget);
}

export function scrollLastMessageToTop(scrollElement, conversationElement) {
  const activeConversation = resolveConversationElement(scrollElement, conversationElement);
  const previousMessage = getPreviousUserMessageAboveScroll(activeConversation, scrollElement);
  if (!previousMessage || !scrollElement) {
    return;
  }
  scrollToElementAtTop(scrollElement, previousMessage);
}

/** Remove listeners and elements. Call on view teardown. */
export function cleanup() {
  cleanupPillState(bottomPillState);
  cleanupPillState(lastPromptPillState);
  cleanupPillState(nextPromptPillState);
}
