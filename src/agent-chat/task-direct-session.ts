import type { AgentType } from '../config';
import { isAgentType } from '../agent-types';
import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
import type { TaskDirectState } from './task-direct-runtime';
import type { AgentDefinitionRecord, WorkspaceSubscriptionRecord } from './types';
import { buildFlightDeckSessionMetadata } from './flightdeck-session-metadata';

export async function resolveTaskDirectSession(input: {
  state: TaskDirectState;
  agent: AgentDefinitionRecord;
  subscription: WorkspaceSubscriptionRecord;
  task: Record<string, unknown>;
  manager: ProcessManager;
  defaultAgent: AgentType;
}): Promise<{ session: SessionSnapshot; generation: number; previousSessionIds: string[] }> {
  const { state, agent, subscription, task, manager } = input;
  if (task.id !== state.taskId || task.workspace_id !== subscription.workspaceId) {
    throw new Error('Task dispatch context does not match the requested task and workspace.');
  }
  const connection = buildFlightDeckSessionMetadata(subscription, agent.botNpub, {
    scopeId: typeof task.scope_id === 'string' ? task.scope_id : null,
    channelId: typeof task.channel_id === 'string' ? task.channel_id : null,
    threadId: typeof task.thread_id === 'string' ? task.thread_id : null,
  });
  const metadata = { ...connection, bindingType: 'task' as const, bindingId: state.taskId,
    taskIds: [state.taskId], flightdeckRoutingKey: state.routingKey };
  const configuredAgent = agent.directChat?.sessionAgent;
  const sessionAgent = configuredAgent && isAgentType(configuredAgent) ? configuredAgent : input.defaultAgent;
  const directory = agent.directChat?.directory || agent.workingDirectory;
  const existing = state.sessionId ? manager.getSession(state.sessionId) : null;
  const compatible = existing?.metadata?.agentChatAgentId === agent.agentId
    && existing?.metadata?.agentChatBotNpub === agent.botNpub
    && existing.agent === sessionAgent && existing.workingDirectory === directory;
  if (compatible && (existing.status === 'running' || existing.status === 'starting')) {
    for (const key of ['flightdeckTowerServiceNpub', 'flightdeckWorkspaceId', 'flightdeckSubscriptionId',
      'flightdeckBackendConnectionId', 'flightdeckAgentNpub', 'bindingType', 'bindingId', 'flightdeckRoutingKey'] as const) {
      const previous = existing.metadata?.[key];
      if (previous && previous !== metadata[key]) {
        throw new Error(`Task session ${existing.id} has conflicting ${key}; refusing to dispatch.`);
      }
    }
    const session = manager.updateSessionMetadata(existing.id, metadata);
    if (!session) throw new Error(`Task session ${existing.id} disappeared while restoring its Flight Deck binding.`);
    return { session, generation: state.generation, previousSessionIds: state.previousSessionIds };
  }
  const generation = state.generation + 1;
  const previousSessionIds = state.sessionId
    ? [...new Set([...state.previousSessionIds, state.sessionId])] : state.previousSessionIds;
  const session = await manager.createSession(sessionAgent, directory,
    `${agent.label || agent.agentId} Task ${state.taskId}`.slice(0, 120),
    { type: 'agent-work', id: state.taskId, label: `${state.routingKey}:generation:${generation}` },
    undefined, subscription.managedByNpub ?? undefined, {
      ...metadata, AGENT: true, role: 'agent-work', nextAction: 'reflect',
      createdByNpub: subscription.managedByNpub ?? undefined,
      agentChatAgentId: agent.agentId, agentChatBotNpub: agent.botNpub, sessionGeneration: generation,
    }, agent.directChat?.model ?? undefined);
  return { session, generation, previousSessionIds };
}
