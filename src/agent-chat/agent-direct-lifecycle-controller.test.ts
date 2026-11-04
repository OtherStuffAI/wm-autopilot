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

  test('renews only while the exact turn is owned; orphan timers stop silently; quiet sessions stay alive', async () => {
    const leases: any[] = [];
    const puts: any[] = [];
    const activity = new AgentActivityPublisher(context, async (input) => { puts.push(input); return { agent_activity: { contract_version: 2, lease_epoch: 1, lease_sequence: 0 } }; }, 0,
      async () => [], undefined, new AgentActivityPublicationStore(':memory:'), undefined,
      async (input) => { leases.push(input); return { status: 200, code: null, body: { agent_activity: { lease_epoch: 1, lease_sequence: input.leaseSequence } } }; });
    const manager = { getSession: () => ({ status: 'running' }) } as any;
    let owned: 'live' | 'gone' = 'live';
    const lifecycle = new AgentDirectLifecycleController(context, manager, activity, async () => ({}),
      new AgentSessionHealthPublicationStore(':memory:'), 7, () => owned);
    const due = async () => { (lifecycle as any).lastRenewAt = 0; await (lifecycle as any).tick(); };
    await lifecycle.accepted();
    // A witness tick before the interval elapses renews nothing.
    await (lifecycle as any).tick();
    expect(leases).toHaveLength(0);
    // Before a runtime session is bound (pending:...), the beat must not mistake it for a dead session.
    await due();
    await lifecycle.working('session-1');
    // No commentary for a long provider call: still renewed while owned.
    await due();
    await due();
    expect(leases).toHaveLength(3);
    owned = 'gone';
    await due();
    expect(leases).toHaveLength(3);
    expect((lifecycle as any).activityTimer).toBeNull();
    expect(puts.some((item) => ['completed', 'failed', 'cancelled'].includes(item.state))).toBe(false);
  });

  test('after the observer is released, keeps renewing and publishing commentary, then publishes the durable outcome', async () => {
    const leases: any[] = [];
    const puts: any[] = [];
    let commentaryReads = 0;
    const activity = new AgentActivityPublisher(context, async (input) => { puts.push(input); return { agent_activity: { contract_version: 2, lease_epoch: 1, lease_sequence: 0 } }; }, 0,
      async () => [], undefined, new AgentActivityPublicationStore(':memory:'), undefined,
      async (input) => { leases.push(input); return { status: 200, code: null, body: { agent_activity: { lease_epoch: 1, lease_sequence: input.leaseSequence } } }; });
    (activity as any).publishLatestCommentary = async () => { commentaryReads += 1; };
    const manager = { getSession: () => ({ status: 'running' }) } as any;
    let status: 'live' | 'completed' | 'cancelled' = 'live';
    const lifecycle = new AgentDirectLifecycleController(context, manager, activity, async () => ({}),
      new AgentSessionHealthPublicationStore(':memory:'), 7, () => status);
    await lifecycle.accepted();
    await lifecycle.working('session-1');
    lifecycle.releaseObservation();
    expect((lifecycle as any).activityTimer).not.toBeNull();
    (lifecycle as any).lastRenewAt = 0;
    await (lifecycle as any).tick();
    expect(leases).toHaveLength(1);
    expect(commentaryReads).toBeGreaterThanOrEqual(1);
    // The reconciler published the reply: the next witness tick terminalizes promptly.
    status = 'completed';
    await (lifecycle as any).tick();
    expect(puts.filter((item) => ['completed', 'failed', 'cancelled'].includes(item.state)).map((item) => item.state)).toEqual(['completed']);
    expect((lifecycle as any).activityTimer).toBeNull();
  });

  test('renews queued rows while still queued and closes folded queued rows as completed', async () => {
    const leases: any[] = [];
    const puts: any[] = [];
    const activity = new AgentActivityPublisher(context, async (input) => { puts.push(input); return { agent_activity: { contract_version: 2, lease_epoch: 1, lease_sequence: 0 } }; }, 0,
      async () => [], undefined, new AgentActivityPublicationStore(':memory:'), undefined,
      async (input) => { leases.push(input); return { status: 200, code: null, body: { agent_activity: { lease_epoch: 1, lease_sequence: input.leaseSequence } } }; });
    let waiting = true;
    const lifecycle = new AgentDirectLifecycleController(context, { getSession: () => null } as any, activity, async () => ({}),
      new AgentSessionHealthPublicationStore(':memory:'), 7, () => 'gone');
    await lifecycle.queued('turn-0', 2, () => waiting);
    await (lifecycle as any).renewQueued();
    expect(leases).toHaveLength(1);
    waiting = false;
    await (lifecycle as any).renewQueued();
    expect(leases).toHaveLength(1);
    expect((lifecycle as any).queuedTimer).toBeNull();
    await lifecycle.closeQueued('Included in the current reply');
    expect(puts.map((item) => item.state)).toEqual(['queued', 'completed']);
  });
});
