import { describe, expect, test } from 'bun:test';

import { AgentActivityPublicationStore } from './agent-activity-publication-store';
import { AgentActivityPublisher } from './agent-activity-publisher';
import { AgentDirectLifecycleController, AgentSessionHealthPublicationStore } from './agent-direct-lifecycle-controller';

const context = {
  subscriptionId: 'subscription-1', backendBaseUrl: 'https://tower', workspaceId: 'workspace-1', appNpub: 'npub1app',
  botIdentity: { botNpub: 'npub1agent', botPubkeyHex: '00', botSecret: new Uint8Array([1]) },
  channelId: 'channel-1', threadId: 'thread-1', triggerMessageId: 'message-1',
  sessionId: 'pending:turn-1', agentNpub: 'npub1agent', turnId: 'turn-1',
};

describe('Agent Direct lifecycle controller', () => {
  test('retries health durably with monotonic generation/sequence and terminalizes once', async () => {
    const activities: any[] = [];
    const health: any[] = [];
    let healthAttempts = 0;
    const activity = new AgentActivityPublisher(context, async (input) => { activities.push(input); return {}; }, 0,
      async () => [], undefined, new AgentActivityPublicationStore(':memory:'));
    const manager = { getSession: () => ({ status: 'running' }) } as any;
    const store = new AgentSessionHealthPublicationStore(':memory:');
    const lifecycle = new AgentDirectLifecycleController(context, manager, activity, async (input: any) => {
      healthAttempts += 1;
      if (healthAttempts === 1) throw new Error('Tower unavailable');
      health.push(input);
      return {};
    }, store, 42);

    await lifecycle.accepted();
    await lifecycle.working('session-1');
    expect(store.pending('session-1')).toHaveLength(1);
    await (lifecycle as any).publishHealth('busy', 'turn-1');
    await lifecycle.finish('cancelled');
    await lifecycle.finish('failed', 'must not replace terminal state');

    expect(health.map((item) => [item.generation, item.sequence, item.status, item.activeTurnId ?? null])).toEqual([
      [42, 1, 'busy', 'turn-1'], [42, 2, 'busy', 'turn-1'], [42, 3, 'idle', null],
    ]);
    expect(store.pending('session-1')).toEqual([]);
    expect(activities.filter((item) => ['completed', 'failed', 'cancelled'].includes(item.state)).map((item) => item.state))
      .toEqual(['cancelled']);
  });

  test('marks confirmed runtime death failed and stops further heartbeats', async () => {
    const activities: any[] = [];
    const activity = new AgentActivityPublisher(context, async (input) => { activities.push(input); return {}; }, 0,
      async () => [], undefined, new AgentActivityPublicationStore(':memory:'));
    const manager = { getSession: () => ({ status: 'error' }) } as any;
    const lifecycle = new AgentDirectLifecycleController(context, manager, activity, async () => ({}),
      new AgentSessionHealthPublicationStore(':memory:'), 7);
    await lifecycle.accepted();
    await lifecycle.working('session-1');
    await (lifecycle as any).heartbeat();
    await (lifecycle as any).heartbeat();
    expect(activities.filter((item) => item.state === 'failed')).toHaveLength(1);
  });
});
