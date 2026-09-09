import type { SessionSnapshot } from "../agents/process-manager";
import { resolveSessionOwnerNpub } from "../sessions/session-ownership";
import type { WorkspaceSubscriptionRecord } from "./types";

export interface FlightDeckTransportBinding {
  towerServiceNpub: string;
  workspaceId: string;
  agentNpub: string;
  subscriptionId?: string | null;
  backendConnectionId?: string | null;
  managerNpub?: string | null;
}

export function flightDeckSessionTransportBinding(session: SessionSnapshot): FlightDeckTransportBinding {
  return {
    towerServiceNpub: session.metadata?.flightdeckTowerServiceNpub ?? "",
    workspaceId: session.metadata?.flightdeckWorkspaceId ?? "",
    agentNpub: session.metadata?.flightdeckAgentNpub ?? session.metadata?.agentChatBotNpub ?? "",
    subscriptionId: session.metadata?.flightdeckSubscriptionId,
    backendConnectionId: session.metadata?.flightdeckBackendConnectionId,
    managerNpub: resolveSessionOwnerNpub(session.npub ?? null, session.metadata),
  };
}

export function selectFlightDeckTransportSubscription(records: WorkspaceSubscriptionRecord[], input: FlightDeckTransportBinding): WorkspaceSubscriptionRecord | null {
  if (!input.managerNpub) throw new Error("Flight Deck session owner is required for transport resolution");
  const matches = records.filter((record) => (record.lifecycleStatus ?? "active") === "active"
    && record.towerServiceNpub === input.towerServiceNpub && record.workspaceId === input.workspaceId
    && record.botNpub === input.agentNpub && record.managedByNpub === input.managerNpub
    && (!input.subscriptionId || record.subscriptionId === input.subscriptionId)
    && (!input.backendConnectionId || record.backendConnectionId === input.backendConnectionId));
  if (matches.length > 1) throw new Error("Flight Deck session transport binding is ambiguous; explicit subscription is required");
  return matches[0] ?? null;
}
