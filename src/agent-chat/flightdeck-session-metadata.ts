import type { SessionMetadataInput } from '../sessions/session-metadata';
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
  };
}
