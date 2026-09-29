import { getSessionModelDisplay } from "../sessions/session-model-display.js";
import { getSessionAgentLabel } from "../sessions/session-agent-label.js";

function readText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function buildEmptySessionInformation(session) {
  const agentLabel = getSessionAgentLabel(session);
  if (!agentLabel) {
    return null;
  }

  const workingDirectory = readText(session?.workingDirectory);
  const model = getSessionModelDisplay(session);
  return {
    title: "Session information",
    agent: agentLabel,
    workingDirectory: workingDirectory || "Unavailable (session metadata missing)",
    modelLabel: model.label,
    model: model.value,
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
    [information.modelLabel || "Selected model", information.model],
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
