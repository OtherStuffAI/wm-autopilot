export function bindCommentAutosaveLifecycle(commentAutosave) {
  function flush() {
    void commentAutosave.flush();
  }

  function flushWhenHidden() {
    if (document.visibilityState === "hidden") flush();
  }

  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", flushWhenHidden);

  return {
    flush,
    cleanup() {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    },
  };
}
