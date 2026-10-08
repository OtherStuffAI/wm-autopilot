export function shouldFormatAgentMessage(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  return role === "assistant" || role === "agent" || role === "agent-streaming";
}

export function isWorkingNotesMessage(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  return role === "agent-working" || role === "agent-thinking" || role === "agent-tools" || role === "agent-context";
}

export function getWorkingNotesLabel(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  if (role === "agent-tools") return "Tools";
  if (role === "agent-context") return "Context";
  return "Thinking";
}

export function isReadableAgentMessage(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  const content = String(message?.content ?? message?.message ?? "").trim();
  return (role === "assistant" || role === "agent") && Boolean(content);
}

export function isErrorMessage(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  return role === "agent-error";
}
