const COLLAPSED_BY_DEFAULT_ROLES = new Set(["agent-tools"]);

export function shouldDefaultWorkingNotesOpen(message, isFirstMessage = false) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  if (COLLAPSED_BY_DEFAULT_ROLES.has(role)) {
    return false;
  }
  return !isFirstMessage;
}
