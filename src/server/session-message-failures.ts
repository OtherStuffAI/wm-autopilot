import type { AgentAdapter } from "../agents/agent-adapter";
import type { SessionSnapshot } from "../agents/process-manager";
import type { AgentRuntimeStatus } from "../types/agent-status";
import type { SessionAgentMessageResult } from "./session-agent-message";

const BUSY_COMPATIBLE_ERROR_PATTERNS = [
  "internal server error",
  "failed to contact agent",
  "agent request failed",
];

function isGenericBusyCompatibleFailure(result: SessionAgentMessageResult): boolean {
  if (result.ok) {
    return false;
  }
  if (result.status < 500 || result.status > 504) {
    return false;
  }
  const normalizedMessage = result.message.trim().toLowerCase();
  if (!normalizedMessage) {
    return true;
  }
  return BUSY_COMPATIBLE_ERROR_PATTERNS.some((pattern) => normalizedMessage.includes(pattern));
}

async function readRuntimeStatus(
  session: SessionSnapshot,
  adapter: AgentAdapter | null,
): Promise<AgentRuntimeStatus | null> {
  if (session.agentRuntimeStatus === "running") {
    return "running";
  }
  if (!adapter) {
    return typeof session.agentRuntimeStatus === "string" ? session.agentRuntimeStatus : null;
  }
  try {
    return await adapter.fetchStatus(750);
  } catch {
    return typeof session.agentRuntimeStatus === "string" ? session.agentRuntimeStatus : null;
  }
}

export async function normalizeBusySessionMessageFailure(
  session: SessionSnapshot,
  result: SessionAgentMessageResult,
  adapter: AgentAdapter | null,
): Promise<SessionAgentMessageResult> {
  if (!isGenericBusyCompatibleFailure(result)) {
    return result;
  }

  const runtimeStatus = await readRuntimeStatus(session, adapter);
  if (runtimeStatus !== "running") {
    return result;
  }

  return {
    ok: false,
    status: 409,
    message: "Agent working",
  };
}
