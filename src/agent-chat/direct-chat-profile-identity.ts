import type { AgentDefinitionStore } from './agent-definition-store';
import type { DirectChatTurnRecord } from './direct-chat-turn-store';
import type { AgentDefinitionRecord, RuntimeBotIdentity } from './types';

export class DirectChatProfileIntegrityError extends Error {
  constructor(readonly integrityClass: string, message: string) {
    super(message);
    this.name = 'DirectChatProfileIntegrityError';
  }
}

export function createDirectChatProfileIdentityRunner(deps: {
  agentStore: Pick<AgentDefinitionStore, 'getByAgentId'>;
  withBotIdentity: <T>(agent: AgentDefinitionRecord, operation: (identity: RuntimeBotIdentity) => Promise<T>) => Promise<T>;
}) {
  return async function withDirectChatProfileIdentity<T>(
    record: DirectChatTurnRecord,
    operation: (identity: RuntimeBotIdentity) => Promise<T>,
  ): Promise<T> {
    const profile = record.agentId ? deps.agentStore.getByAgentId(record.agentId) : null;
    if (!profile || !profile.enabled || profile.archived) {
      throw new DirectChatProfileIntegrityError('profile_unavailable',
        'Saved Agent Direct profile is missing, disabled, or archived.');
    }
    if (profile.botNpub !== record.agentNpub) {
      throw new DirectChatProfileIntegrityError('profile_turn_identity_mismatch',
        'Saved Agent Direct profile ID and npub no longer identify the same profile.');
    }
    return deps.withBotIdentity(profile, operation);
  };
}
