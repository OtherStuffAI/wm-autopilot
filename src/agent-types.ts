export const AGENT_TYPES = ["claude", "codex", "goose", "maple", "opencode", "gemini", "pi"] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export const DEFAULT_AGENT_TYPE: AgentType = "codex";

export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  claude: "Claude",
  codex: "Codex",
  goose: "Goose",
  maple: "Maple Desktop",
  opencode: "OpenCode",
  gemini: "Gemini",
  pi: "Pi",
};

export const AGENT_TYPE_LIST = AGENT_TYPES.join(", ");

export function isAgentType(value: string): value is AgentType {
  return AGENT_TYPES.includes(value as AgentType);
}
