import type { SessionSnapshot } from "../agents/process-manager";
import { resolveSessionOwnerNpub } from "../sessions/session-ownership";
import { flightDeckSessionTransportBinding, type FlightDeckTransportBinding } from "../agent-chat/flightdeck-session-transport";

export function createWorkerContextValidator(resolver: {
  resolveFlightDeckTurnDelivery(input: FlightDeckTransportBinding): { botIdentity: { botNpub: string } } | null;
}): (session: SessionSnapshot) => boolean {
  return (session) => {
    const binding = flightDeckSessionTransportBinding(session);
    return resolver.resolveFlightDeckTurnDelivery(binding)?.botIdentity.botNpub === binding.agentNpub;
  };
}

/** Reporting hints never select a signer, subscription, backend, or workspace. */
export function inheritWorkerContext(
  parent: SessionSnapshot | null,
  reporting: Record<string, unknown>,
  validateParent?: (session: SessionSnapshot) => boolean,
): Record<string, unknown> {
  const metadata = parent?.metadata;
  if (!parent || !metadata) return {};
  const hasContext = metadata.flightdeckTowerServiceNpub || metadata.flightdeckWorkspaceId
    || metadata.flightdeckSubscriptionId || metadata.flightdeckBackendConnectionId;
  if (!hasContext) return {};
  if (!resolveSessionOwnerNpub(parent.npub, metadata)) throw new Error("Flight Deck parent owner is required");
  const bot = metadata.agentChatBotNpub ?? metadata.flightdeckAgentNpub;
  if (!bot || (metadata.flightdeckAgentNpub && metadata.flightdeckAgentNpub !== bot)) {
    throw new Error("Flight Deck parent bot identity is inconsistent");
  }
  if (!metadata.flightdeckTowerServiceNpub || !metadata.flightdeckWorkspaceId
    || !validateParent?.(parent)) {
    throw new Error("Flight Deck parent transport must match an active owner subscription");
  }
  for (const [hint, field] of [["workspaceId", "flightdeckWorkspaceId"],
    ["channelId", "flightdeckChannelId"], ["threadId", "flightdeckThreadId"]] as const) {
    if (reporting[hint] !== undefined && reporting[hint] !== metadata[field]) {
      throw new Error(`Reporting ${hint} does not match trusted parent context`);
    }
  }
  const result: Record<string, unknown> = { agentChatBotNpub: bot, flightdeckAgentNpub: bot };
  for (const field of ["agentProfileId", "agentChatAgentId", "flightdeckSubscriptionId",
    "flightdeckBackendConnectionId", "flightdeckTowerServiceNpub", "flightdeckWorkspaceId",
    "flightdeckScopeId", "flightdeckChannelId", "flightdeckThreadId"] as const) {
    if (metadata[field]) result[field] = metadata[field];
  }
  // Task IDs are routing hints within the validated workspace, never grants.
  const taskId = reporting.taskId ?? (metadata.bindingType === "task" ? metadata.bindingId
    : metadata.taskIds?.length === 1 ? metadata.taskIds[0] : undefined);
  if (taskId !== undefined) {
    if (typeof taskId !== "string" || !taskId.trim()) throw new Error("Reporting taskId must be a nonempty string");
    result.bindingType = "task";
    result.bindingId = taskId.trim();
    result.taskIds = [taskId.trim()];
  }
  return result;
}
