import type { OwnerAccessResolution } from "../auth/delegation-access";
import type { PipelineStore } from "./pipeline-store";
import { rootPipelineRunId } from "./pipeline-run-authority";

export interface ViewerContext { workspaceId: string; towerServiceNpub: string; appNpub: string }
export interface ViewerAgentAccess { canReadAgent: (id: string, npub: string | null) => boolean }

export function viewerCanReadRun(store: PipelineStore, runId: string, access: OwnerAccessResolution,
  context: ViewerContext, agents: ViewerAgentAccess): boolean {
  const rootId = rootPipelineRunId(store, runId);
  const root = store.getRunSummary(rootId);
  const run = store.getRunSummary(runId);
  if (!root || !run || root.ownerNpub !== access.ownerNpub || run.ownerNpub !== access.ownerNpub) return false;
  const event = store.listEvents(rootId).find(entry => entry.type === "flightdeck_invocation_context");
  if (!event || typeof event.data_json !== "string") return false;
  let trusted: Record<string, unknown>;
  try { trusted = JSON.parse(event.data_json); } catch { return false; }
  if (!trusted || trusted.workspaceId !== context.workspaceId || trusted.towerServiceNpub !== context.towerServiceNpub || trusted.appNpub !== context.appNpub) return false;
  const snapshot = store.composition.snapshot(rootId);
  const agentId = trusted.initiatingAgentProfileId ?? snapshot?.context.initiatingAgentProfileId ?? trusted.resolvedAgentProfileId;
  const agentNpub = trusted.initiatingAgentNpub ?? snapshot?.context.initiatingAgentNpub;
  if (typeof agentId !== "string" || !agentId || typeof agentNpub !== "string" || !agentNpub) return false;
  const filters = access.delegation?.resourceFilters?.agentIds;
  if (filters?.length && !filters.includes(agentId)) return false;
  return agents.canReadAgent(agentId, agentNpub);
}
