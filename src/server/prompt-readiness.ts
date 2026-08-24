import type { AgentAdapter, PromptReadiness, PromptReadinessState } from "../agents/agent-adapter";
import type { SessionSnapshot } from "../agents/process-manager";

const DEFAULT_READY_RETRY_MS = 250;
const DEFAULT_BUSY_RETRY_MS = 1000;
const DEFAULT_STARTING_RETRY_MS = 1000;
const DEFAULT_UNREACHABLE_RETRY_MS = 5000;

export function createPromptReadiness(
  state: PromptReadinessState,
  reason: string,
  retryAfterMs: number,
): PromptReadiness {
  return {
    state,
    reason,
    retryAfterMs,
    observedAt: Date.now(),
  };
}

export function readyPromptReadiness(reason: string): PromptReadiness {
  return createPromptReadiness("ready", reason, DEFAULT_READY_RETRY_MS);
}

export function startingPromptReadiness(reason: string): PromptReadiness {
  return createPromptReadiness("starting", reason, DEFAULT_STARTING_RETRY_MS);
}

export function busyPromptReadiness(reason: string): PromptReadiness {
  return createPromptReadiness("busy", reason, DEFAULT_BUSY_RETRY_MS);
}

export function unreachablePromptReadiness(reason: string): PromptReadiness {
  return createPromptReadiness("unreachable", reason, DEFAULT_UNREACHABLE_RETRY_MS);
}

export async function getSessionPromptReadiness(options: {
  session: SessionSnapshot | null;
  adapter: AgentAdapter | null;
  timeoutMs?: number;
}): Promise<PromptReadiness> {
  const { session, adapter, timeoutMs } = options;
  if (!session) {
    return unreachablePromptReadiness("session-missing");
  }
  if (session.status !== "running") {
    return unreachablePromptReadiness("session-not-running");
  }
  if (!adapter) {
    return unreachablePromptReadiness("adapter-missing");
  }

  if (adapter.getPromptReadiness) {
    try {
      return await adapter.getPromptReadiness(timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return unreachablePromptReadiness(`prompt-readiness-error: ${message}`);
    }
  }

  try {
    const status = await adapter.fetchStatus(timeoutMs);
    if (status === "stable") {
      return readyPromptReadiness("runtime-status-stable");
    }
    if (status === "running") {
      return busyPromptReadiness("runtime-status-running");
    }
    return unreachablePromptReadiness("runtime-status-unavailable");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unreachablePromptReadiness(`runtime-status-error: ${message}`);
  }
}
