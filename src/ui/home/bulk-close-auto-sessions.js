export function createBulkCloseAutoSessionsButton({
  closeSessions,
  confirmClose,
  refreshSessions,
  showToast,
}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-button secondary";
  button.textContent = "Close > 21";
  button.setAttribute("aria-label", "Close stable auto sessions older than 21 minutes");
  button.dataset.testid = "close-stale-auto-sessions";

  button.addEventListener("click", async () => {
    const confirmed = await confirmClose({
      title: "Close old auto sessions?",
      description: "Close every stable auto session whose last update is more than 21 minutes old? Active thinking sessions and user-created sessions will be skipped.",
      confirmLabel: "Close eligible sessions",
      testId: "close-stale-auto-sessions-confirm",
    });
    if (!confirmed) return;

    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Closing…";
    try {
      const result = await closeSessions();
      const eligible = Number.isFinite(result?.eligible) ? result.eligible : 0;
      const closed = Array.isArray(result?.closed) ? result.closed.length : 0;
      const skipped = Array.isArray(result?.skipped) ? result.skipped.length : 0;
      const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
      showToast(`Close > 21: ${eligible} eligible, ${closed} closed, ${skipped} skipped, ${failed} failed.`, {
        type: failed > 0 ? "warning" : "success",
      });
      await refreshSessions();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Failed to close auto sessions", { type: "error" });
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Close > 21";
    }
  });

  return button;
}
