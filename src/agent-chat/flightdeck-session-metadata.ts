import type { SessionMetadataInput } from '../sessions/session-metadata';
import { agentInboxScope } from './agent-inbox-scope';
import type { WorkspaceSubscriptionRecord } from './types';

export interface FlightDeckSessionLocation {
  scopeId?: string | null;
  channelId?: string | null;
  threadId?: string | null;
}

function required(value: string | null | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`Flight Deck dispatch requires ${field}.`);
  return value;
}

export function buildFlightDeckSessionMetadata(
  subscription: WorkspaceSubscriptionRecord,
  agentNpub: string,
  location: FlightDeckSessionLocation,
): SessionMetadataInput {
  return {
    flightdeckSubscriptionId: required(subscription.subscriptionId, 'subscription ID'),
    flightdeckTowerServiceNpub: required(subscription.towerServiceNpub, 'Tower service identity'),
    flightdeckWorkspaceId: required(subscription.workspaceId, 'workspace ID'),
    flightdeckBackendConnectionId: subscription.backendConnectionId ?? undefined,
    flightdeckAgentNpub: required(agentNpub, 'agent identity'),
    flightdeckScopeId: location.scopeId ?? undefined,
    flightdeckChannelId: required(location.channelId, 'channel ID'),
    flightdeckThreadId: location.threadId ?? undefined,
    // Sessions launched inside a strict-inbox notification scope are marked so legacy-era sessions are never reused.
    ...(agentInboxScope.getStore() ? { flightdeckDeliveryMode: 'agent_inbox' as const } : {}),
  };
}

/**
 * During a strict-inbox delivery, a previous session may only be reused or natively resumed when it was itself created
 * for the inbox on this same subscription. Legacy-era sessions carry broad pre-migration context and history.
 */
export function requiresFreshInboxSession(previous: SessionMetadataInput | null | undefined, subscriptionId: string): boolean {
  if (!agentInboxScope.getStore()) return false;
  return previous?.flightdeckDeliveryMode !== 'agent_inbox' || previous?.flightdeckSubscriptionId !== subscriptionId;
}
