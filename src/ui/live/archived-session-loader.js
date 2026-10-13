/** Late history responses must never replace the selected session's view. */
export async function loadSelectedArchivedSession(sessionId, deps) {
  if (deps.getState().sessionId === sessionId && deps.getState().loading) return;
  const empty = { sessionId, status: null, session: null, messages: [], loading: true, error: null };
  deps.setState(empty);
  deps.render();
  let next;
  try {
    const data = await deps.fetchHistory(sessionId);
    next = !data ? { ...empty, loading: false, error: "Session not found" }
      : data.status === "live" ? { ...empty, sessionId: null, loading: false }
      : { ...empty, status: data.status, session: data.session, messages: data.messages || [], loading: false };
  } catch (error) {
    next = { ...empty, loading: false, error: error.message || "Failed to load session" };
  }
  if (deps.getSelectedSessionId() !== sessionId || deps.getState() !== empty) return;
  deps.setState(next);
  deps.render();
}

export function archivedSessionStatusLabel(status, messages) {
  if (status === "abandoned") return "ABANDONED";
  const lastUser = messages.findLastIndex(message => message.role === "user");
  const outcome = messages.slice(lastUser + 1).findLast(message =>
    ["assistant", "agent", "agent-error"].includes(message.role) && message.content?.trim());
  return lastUser >= 0 && (!outcome || outcome.role === "agent-error") ? "ARCHIVED · INTERRUPTED" : "ARCHIVED";
}
