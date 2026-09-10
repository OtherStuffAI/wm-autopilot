import * as scrollPill from "./scroll-pill.js";

let detachLayoutListener = null;

export function getConversationScrollTarget(scope = document) {
  const scrollRegion = scope?.querySelector(".wm-live-scroll");
  const independentlyScrolling = scrollRegion && ["auto", "scroll"].includes(getComputedStyle(scrollRegion).overflowY);
  return independentlyScrolling ? scrollRegion : (document.scrollingElement || document.documentElement);
}

export function attachComposerScrollControls(composerEl) {
  detachLayoutListener?.();
  const phoneLayout = window.matchMedia("(max-width: 600px) and (pointer: coarse)");
  function attach() {
    requestAnimationFrame(() => {
      if (!composerEl?.isConnected) return;
      const scope = composerEl.closest(".wm-live-chat-col") || composerEl.closest(".wm-live");
      const conversationEl = scope?.querySelector(".wm-live-conversation");
      const scrollTarget = getConversationScrollTarget(scope);
      scrollPill.attachLastPromptPill(composerEl, scrollTarget, conversationEl);
      scrollPill.attachNextPromptPill(composerEl, scrollTarget, conversationEl);
      scrollPill.attachScrollPill(composerEl, scrollTarget, conversationEl);
    });
  }
  phoneLayout.addEventListener("change", attach);
  detachLayoutListener = () => phoneLayout.removeEventListener("change", attach);
  attach();
}
