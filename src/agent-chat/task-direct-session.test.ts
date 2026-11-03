import { describe, expect, test } from 'bun:test';

import { agentInboxScope } from './agent-inbox-scope';
import { resolveTaskDirectSession } from './task-direct-session';

const agent: any = { agentId: 'bot', label: 'Bot', botNpub: 'npub1bot', workingDirectory: '/w', directChat: { enabled: true, sessionAgent: 'codex', directory: '/w', model: null } };
const subscription: any = { subscriptionId: 'sub-1', workspaceId: 'ws-1', towerServiceNpub: 'npub1tower', backendBaseUrl: 'https://tower', managedByNpub: 'npub1manager' };
const task = { id: 'task-1', workspace_id: 'ws-1', channel_id: 'channel-1', scope_id: 'scope-1', thread_id: null };

function manager(existingMetadata: Record<string, unknown>) {
  const created: any[] = [];
  const existing = { id: 'legacy-session', status: 'running', agent: 'codex', workingDirectory: '/w', model: undefined,
    metadata: { agentChatAgentId: 'bot', agentChatBotNpub: 'npub1bot', flightdeckSubscriptionId: 'sub-1', ...existingMetadata } };
  return {
    created,
    api: {
      getSession: (id: string) => (id === existing.id ? existing : null),
      updateSessionMetadata: (id: string, metadata: any) => ({ ...existing, id, metadata: { ...existing.metadata, ...metadata } }),
      createSession: async (...args: any[]) => { created.push(args); return { id: `fresh-${created.length}`, metadata: args[6] }; },
    } as any,
  };
}

const state = () => ({ taskId: 'task-1', routingKey: 'rk', sessionId: 'legacy-session', generation: 1, previousSessionIds: [] } as any);
const scope = { notification: { id: 'n-1', seq: 1, state: 'active' } as any, context: {} as any, profileNpub: 'npub1bot' };

describe('task sessions under strict-inbox delivery', () => {
  test('a running legacy-era task session is replaced by a fresh inbox generation', async () => {
    const m = manager({});
    const result = await agentInboxScope.run(scope, () => resolveTaskDirectSession({ state: state(), agent, subscription, task, manager: m.api, defaultAgent: 'codex' }));
    expect(result.session.id).toBe('fresh-1');
    expect(result.generation).toBe(2);
    expect(result.previousSessionIds).toEqual(['legacy-session']);
    expect(m.created[0][6].flightdeckDeliveryMode).toBe('agent_inbox');
  });

  test('an inbox-created task session on the same subscription is reused; legacy delivery is unchanged', async () => {
    const inbox = manager({ flightdeckDeliveryMode: 'agent_inbox' });
    const reused = await agentInboxScope.run(scope, () => resolveTaskDirectSession({ state: state(), agent, subscription, task, manager: inbox.api, defaultAgent: 'codex' }));
    expect(reused.session.id).toBe('legacy-session');
    const legacy = manager({});
    const outside = await resolveTaskDirectSession({ state: state(), agent, subscription, task, manager: legacy.api, defaultAgent: 'codex' });
    expect(outside.session.id).toBe('legacy-session');
    expect(legacy.created).toEqual([]);
  });
});
