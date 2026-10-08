import type { ProcessManager } from "../agents/process-manager";
import type { NightWatchDeps } from "../nightwatch/nightwatch-engine";

/** Native transports share the same reflection hooks as AgentAPI sessions. */
export function createNightWatchRuntimeDeps(
  manager: ProcessManager,
  options: Pick<NightWatchDeps, "store" | "featureFlagStore" | "agentHost">,
): NightWatchDeps {
  return {
    ...options,
    getSession: (id) => manager.getSession(id) ?? null,
    getAdapter: (id) => manager.getAdapter(id),
    updateSessionMetadata: (id, metadata) => manager.updateSessionMetadata(id, metadata),
  };
}
