function readText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function buildEmptySessionInformation(session) {
  const agent = readText(session?.agent).toLowerCase();
  const transport = readText(session?.metadata?.agentTransport).toLowerCase();
  const agentLabel = agent === "goose" && transport === "goose-acp"
    ? "Goose (ACP)"
    : agent === "codex" && transport === "codex-acp"
      ? "Codex (ACP)"
      : agent === "codex" && transport === "agentapi"
        ? "Codex (Agent API)"
        : null;
  if (!agentLabel) {
    return null;
  }

  const workingDirectory = readText(session?.workingDirectory);
  const selectedModel = readText(session?.model);
  return {
    title: "Session information",
    agent: agentLabel,
    workingDirectory: workingDirectory || "Unavailable (session metadata missing)",
    model: selectedModel && selectedModel.toLowerCase() !== "default"
      ? selectedModel
      : "default (provider default)",
  };
}

export function createSessionInformationBubble(information) {
  const bubble = document.createElement("article");
  bubble.className = "wm-message system wm-session-information";
  bubble.dataset.role = "system";
  bubble.dataset.testid = "session-information-message";

  const body = document.createElement("div");
  body.className = "wm-message-body";
  const title = document.createElement("strong");
  title.textContent = information.title;
  const details = document.createElement("dl");
  details.className = "wm-session-information-details";
  for (const [label, value] of [
    ["Agent", information.agent],
    ["Directory", information.workingDirectory],
    ["Model", information.model],
  ]) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    details.append(term, description);
  }
  body.append(title, details);
  bubble.append(body);
  return bubble;
}
