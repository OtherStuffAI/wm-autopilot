export function getSessionAgentLabel(session) {
  const agent = typeof session?.agent === "string" ? session.agent.trim().toLowerCase() : "";
  const transport = session?.metadata?.agentTransport;
  if (agent === "codex") {
    if (transport === "codex-sdk") return "Codex (SDK)";
    if (transport === "codex-acp") return "Codex (ACP)";
    if (transport === "agentapi") return "Codex (Agent API)";
  }
  if (agent === "goose" && transport === "goose-acp") return "Goose (ACP)";
  return null;
}
