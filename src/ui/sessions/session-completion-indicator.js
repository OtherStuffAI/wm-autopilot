export function decorateSessionTabCompletion(button, {
  displayName,
  tabState,
  unread,
}) {
  const statusLabel = unread ? "completed, unread" : tabState;
  button.setAttribute("aria-label", `Open ${displayName} (${statusLabel})`);
  if (!unread) return null;

  const dot = document.createElement("span");
  dot.className = "wm-tab__completion-dot";
  dot.dataset.testid = "session-completion-unread";
  dot.setAttribute("aria-hidden", "true");
  button.append(dot);
  return dot;
}
