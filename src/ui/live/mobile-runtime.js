const MOBILE_WIDTH_PX = 820;
const KEYBOARD_DELTA_THRESHOLD_PX = 120;
const VIEWPORT_SETTLE_DELAY_MS = 300;

let initialized = false;
let animationFrameId = null;
let settleTimerId = null;
let lastAppliedHeight = null;

function getViewportHeight() {
  const visualViewportHeight = window.visualViewport?.height;
  if (typeof visualViewportHeight === "number" && Number.isFinite(visualViewportHeight) && visualViewportHeight > 0) {
    return visualViewportHeight;
  }
  return window.innerHeight;
}

function isCoarsePointerDevice() {
  if (!window.matchMedia) {
    return window.innerWidth <= MOBILE_WIDTH_PX;
  }
  try {
    return window.matchMedia("(pointer: coarse)").matches || window.matchMedia(`(max-width: ${MOBILE_WIDTH_PX}px)`).matches;
  } catch {
    return window.innerWidth <= MOBILE_WIDTH_PX;
  }
}

function detectKeyboardOpen() {
  if (!isCoarsePointerDevice()) {
    return false;
  }
  const visualViewportHeight = window.visualViewport?.height;
  if (typeof visualViewportHeight !== "number" || !Number.isFinite(visualViewportHeight)) {
    return false;
  }
  return window.innerHeight - visualViewportHeight > KEYBOARD_DELTA_THRESHOLD_PX;
}

function applyViewportState() {
  animationFrameId = null;
  const root = document.documentElement;
  const body = document.body;
  if (!root || !body) {
    return;
  }

  const keyboardOpen = detectKeyboardOpen();
  body.dataset.keyboardOpen = keyboardOpen ? "true" : "false";

  const newHeight = Math.round(getViewportHeight());
  if (lastAppliedHeight !== null && lastAppliedHeight === newHeight) {
    return;
  }
  lastAppliedHeight = newHeight;
  root.style.setProperty("--wm-viewport-height", `${newHeight}px`);
}

function scheduleViewportStateSync() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
  }
  animationFrameId = requestAnimationFrame(applyViewportState);
}

function debouncedViewportSync() {
  if (settleTimerId !== null) {
    clearTimeout(settleTimerId);
  }
  settleTimerId = setTimeout(() => {
    settleTimerId = null;
    scheduleViewportStateSync();
  }, VIEWPORT_SETTLE_DELAY_MS);
}

export function initLiveMobileRuntime() {
  if (initialized) {
    applyViewportState();
    return;
  }

  initialized = true;
  applyViewportState();

  const visualViewport = window.visualViewport;
  window.addEventListener("resize", scheduleViewportStateSync, { passive: true });
  window.addEventListener("orientationchange", scheduleViewportStateSync, { passive: true });
  if (visualViewport) {
    visualViewport.addEventListener("resize", debouncedViewportSync, { passive: true });
    visualViewport.addEventListener("scroll", debouncedViewportSync, { passive: true });
  }
  document.addEventListener("focusin", debouncedViewportSync, true);
  document.addEventListener("focusout", debouncedViewportSync, true);
}

export function isMobileViewport() {
  return isCoarsePointerDevice();
}

export function isMobileKeyboardOpen() {
  return document.body?.dataset.keyboardOpen === "true";
}

export function isComposerInteractionActive() {
  const activeElement = document.activeElement;
  return activeElement instanceof HTMLTextAreaElement && Boolean(activeElement.closest(".wm-composer"));
}

export function shouldAutoFocusComposer(reason = "mount") {
  if (!isMobileViewport()) {
    return true;
  }
  return reason === "send" || reason === "queue";
}

export function focusComposerTextarea(textarea, reason = "mount") {
  if (!(textarea instanceof HTMLTextAreaElement) || !document.contains(textarea)) {
    return;
  }
  if (!shouldAutoFocusComposer(reason)) {
    return;
  }
  requestAnimationFrame(() => {
    if (!document.contains(textarea)) {
      return;
    }
    textarea.focus({ preventScroll: true });
  });
}
