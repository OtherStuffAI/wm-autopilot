import type { SessionMetadataInput } from '../sessions/session-metadata';
import { buildFlightDeckSessionMetadata } from './flightdeck-session-metadata';
import type { AgentDefinitionRecord, ChatInterceptStateRecord, WorkspaceSubscriptionRecord } from './types';

function compactGoalMessage(value: string, maxLength = 240): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return 'the latest Agent Direct message';
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

export function buildDirectChatSessionBinding(input: {
  subscription: WorkspaceSubscriptionRecord;
  intercept: ChatInterceptStateRecord;
  agent: AgentDefinitionRecord;
  scopeId: string | null;
  generation: number;
  latestMessage: string;
}): NonNullable<SessionMetadataInput> {
  return {
    AGENT: true,
    role: 'agent-chat',
    sessionClass: 'flightdeck_chat',
    ...buildFlightDeckSessionMetadata(input.subscription, input.intercept.botNpub, {
      scopeId: input.scopeId,
      channelId: input.intercept.channelId,
      threadId: input.intercept.threadId,
    }),
    bindingType: 'thread',
    bindingId: input.intercept.threadId,
    routedBy: 'agent-chat',
    agentChatAgentId: input.agent.agentId,
    agentChatBotNpub: input.agent.botNpub,
    flightdeckRoutingKey: input.intercept.routingKey,
    sessionGeneration: input.generation,
    goal: `Answer the Agent Direct message thoroughly: ${compactGoalMessage(input.latestMessage)}`,
    nextAction: 'reflect',
    createdByNpub: input.subscription.managedByNpub ?? undefined,
    lastManagedByNpub: input.subscription.managedByNpub ?? undefined,
  };
}

export function assertDirectChatWorkspaceCompatible(
  metadata: SessionMetadataInput | null | undefined,
  intended: NonNullable<SessionMetadataInput>,
  sessionId: string,
): void {
  for (const key of ['flightdeckTowerServiceNpub', 'flightdeckWorkspaceId'] as const) {
    const previous = metadata?.[key];
    const next = intended[key];
    if (previous && next && previous !== next) {
      throw new Error(`Agent Direct session ${sessionId} has conflicting ${key}; refusing to rebind across workspaces.`);
    }
  }
}
