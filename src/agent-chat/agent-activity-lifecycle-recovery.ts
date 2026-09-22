import type { ProcessManager } from '../agents/process-manager';
import { AgentActivityPublisher, buildAgentActivityId } from './agent-activity-publisher';
import { agentActivityPublicationStore } from './agent-activity-publication-store';
import type { ActivityIdentityRunner } from './agent-activity-recovery';
import type { AgentDirectDeliveryTransport } from './direct-chat-delivery-reconciler';
import type { DirectChatTurnRecord, DirectChatTurnStore } from './direct-chat-turn-store';
import type { RuntimeBotIdentity } from './types';

export function createActivityProfileRecovery(deps: {
  store: Pick<DirectChatTurnStore, 'get'>;
  resolveTransport: (record: DirectChatTurnRecord) => AgentDirectDeliveryTransport | null;
  withProfileIdentity: <T>(record: DirectChatTurnRecord, operation: (identity: RuntimeBotIdentity) => Promise<T>) => Promise<T>;
}): ActivityIdentityRunner {
  return async (request, operation) => {
    const turn = deps.store.get(request.turnId);
    if (!turn || turn.agentNpub !== request.agentNpub || turn.workspaceId !== request.workspaceId
      || turn.channelId !== request.channelId || turn.threadId !== request.threadId) return;
    const transport = deps.resolveTransport(turn);
    if (!transport || transport.backendBaseUrl !== request.backendBaseUrl || transport.appNpub !== request.appNpub) return;
    await deps.withProfileIdentity(turn, operation);
  };
}

export function createReconciledActivityPublisher(manager: ProcessManager, terminal = false) {
  return async (record: DirectChatTurnRecord, botIdentity: RuntimeBotIdentity, transport: AgentDirectDeliveryTransport) => {
    const fallback = { ...transport, botIdentity, channelId: record.channelId!, threadId: record.threadId!,
      triggerMessageId: record.triggerMessageId ?? record.sourceMessageIds.at(-1)!,
      sessionId: `pending:${record.turnId}`, turnId: record.turnId, agentNpub: record.agentNpub!, startedAt: record.createdAt };
    const activityId = buildAgentActivityId(fallback);
    const saved = agentActivityPublicationStore.contextFor(activityId);
    const publisher = new AgentActivityPublisher({ ...fallback, ...saved, botIdentity });
    if (record.sessionId) publisher.bindSession(record.sessionId);
    if (!terminal) await publisher.publish('working');
    const source = agentActivityPublicationStore.commentarySourceFor(activityId);
    if (source) await publisher.publishCommentaryFromSource(source);
    else await publisher.publishLatestCommentary(manager);
    if (terminal) await publisher.publish('completed');
  };
}
