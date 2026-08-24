export type AgentRuntimeStatus = "running" | "stable";

export const isAgentRuntimeStatus = (value: unknown): value is AgentRuntimeStatus => {
  return value === "running" || value === "stable";
};
