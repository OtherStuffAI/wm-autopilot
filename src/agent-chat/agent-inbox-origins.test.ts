import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { AgentInboxEnvelope } from './agent-inbox-client';
import {
  AgentInboxOriginStore, beginActiveInboxAttempt, currentInboxOrigin, liveInboxOrigin, notificationIdForEvent, recordInboxRunOrigin,
  recordInboxTurn, setAgentInboxOriginStoresForTests, snapshotWorkerInboxOrigin, type LiveOrigin,
} from './agent-inbox-origins';
import { AgentInboxProcessor } from './agent-inbox-runtime';
import { agentInboxScope } from './agent-inbox-scope';
import { AgentInboxStore } from './agent-inbox-store';
import { sendPromptAndAwaitAssistantReply } from './session-runtime-session-ops';
import type { WorkspaceSubscriptionRecord } from './types';

const dirs: string[] = [];
afterEach(() => {
  setAgentInboxOriginStoresForTests(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const record = { subscriptionId: 'sub-1', botNpub: 'npub1bot' } as WorkspaceSubscriptionRecord;
const request = { backendBaseUrl: 'https://tower.example', workspaceId: 'ws-1', appNpub: 'npub1app', botIdentity: { botNpub: 'npub1bot' } } as any;
const envelope = (id: string, seq: number, patch: Partial<AgentInboxEnvelope> = {}): AgentInboxEnvelope => ({
  id, seq, state: 'active', kind: 'chat_mention', occurred_at: '2026-11-03T01:00:00.000Z',
  source: { type: 'message', id: `m-${id}`, version: 1, channel_id: 'channel-1', thread_id: 'thread-1', task_id: null, doc_id: null }, ...patch,
});
const context = { channel: { id: 'channel-1', workspace_id: 'ws-1' }, trigger: { type: 'message', message: { id: 'm', channel_id: 'channel-1', thread_id: 'thread-1', body: 'hi' } } };

function stores() {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-origin-'));
  dirs.push(dir);
  const inbox = new AgentInboxStore(join(dir, 'db.sqlite'));
  const origins = new AgentInboxOriginStore(join(dir, 'db.sqlite'));
  inbox.setMode('sub-1', 'inbox_required', 'c');
  inbox.update('sub-1', { towerSubscriptionId: 'tower-sub', floorAt: '2026-11-02T00:00:00.000Z' });
  const handled = (id: string, seq: number, outcome: string | null = 'handled', patch: Partial<AgentInboxEnvelope> = {}) => {
    inbox.beginAttempt('sub-1', id, seq, envelope(id, seq, patch) as any);
    if (outcome) inbox.markHandled('sub-1', id, seq, outcome, null);
  };
  return { inbox, origins, handled };
}

const owner = { sessionId: 'session-1', subscriptionId: 'sub-1' };
const liveId = (live: LiveOrigin) => (live.ok ? live.envelope.id : live.code);

describe('strict-inbox origin liveness (fail closed)', () => {
  test('requires an established inbox state, a finite floor and a finite post-floor occurrence', () => {
    const s = stores();
    const origin = { subscriptionId: 'sub-1', notificationId: 'n-1' };
    s.handled('n-1', 1);
    expect(liveId(liveInboxOrigin(origin, s.inbox))).toBe('n-1');
    s.inbox.update('sub-1', { floorAt: 'not-a-date' });
    expect(liveId(liveInboxOrigin(origin, s.inbox))).toBe('agent_inbox_origin_expired');
    s.inbox.update('sub-1', { floorAt: null });
    expect(liveId(liveInboxOrigin(origin, s.inbox))).toBe('agent_inbox_origin_expired');
    s.inbox.update('sub-1', { floorAt: '2026-11-02T00:00:00.000Z', towerSubscriptionId: null });
    expect(liveId(liveInboxOrigin(origin, s.inbox))).toBe('agent_inbox_origin_expired');
    s.inbox.update('sub-1', { towerSubscriptionId: 'tower-sub' });
    s.inbox.setMode('sub-1', 'legacy', 'c');
    expect(liveId(liveInboxOrigin(origin, s.inbox))).toBe('agent_inbox_origin_expired');
    s.inbox.setMode('sub-1', 'inbox_required', 'c');
    for (const occurred_at of [undefined, '', 'garbage', '2026-11-01T23:59:59.000Z']) {
      s.handled('n-x', 9, 'handled', { occurred_at } as any);
      expect([occurred_at, liveId(liveInboxOrigin({ subscriptionId: 'sub-1', notificationId: 'n-x' }, s.inbox))]).toEqual([occurred_at, 'agent_inbox_origin_expired']);
    }
    expect(liveId(liveInboxOrigin({ subscriptionId: 'sub-1', notificationId: 'unknown' }, s.inbox))).toBe('agent_inbox_no_origin');
    expect(liveId(liveInboxOrigin({ subscriptionId: 'sub-2', notificationId: 'n-1' }, s.inbox))).toBe('agent_inbox_origin_expired');
  });

  test('attempt ownership is reference-counted so an overlapping retry keeps the other attempt live', () => {
    const s = stores();
    const origin = { subscriptionId: 'sub-1', notificationId: 'n-1' };
    s.handled('n-1', 1, null);
    const first = beginActiveInboxAttempt('sub-1', 'n-1');
    const second = beginActiveInboxAttempt('sub-1', 'n-1');
    first();
    first(); // idempotent
    expect(liveId(liveInboxOrigin(origin, s.inbox))).toBe('n-1');
    second();
    expect(liveId(liveInboxOrigin(origin, s.inbox))).toBe('agent_inbox_origin_expired');
  });
});

describe('strict-inbox turns are recorded at activation from the turn\'s own trigger', () => {
  test('records the notification of the activated trigger event; legacy subscriptions record nothing', () => {
    const s = stores();
    expect(recordInboxTurn('session-1', { subscriptionId: 'sub-1', eventId: 'n-1' }, s)).toBeNumber();
    expect(s.origins.history('session', 'session-1')).toEqual([{ subscriptionId: 'sub-1', notificationId: 'n-1' }]);
    expect(recordInboxTurn('session-1', { subscriptionId: 'legacy-sub', eventId: 'n-9' }, s)).toBeNull();
    expect(notificationIdForEvent('n-7:review')).toBe('n-7');
  });

  test('a turn without a notification is recorded unbound, so the session never keeps acting for a stale origin', () => {
    const s = stores();
    s.handled('n-1', 1);
    recordInboxTurn('session-1', { subscriptionId: 'sub-1', eventId: 'n-1' }, s);
    expect(currentInboxOrigin(owner, s.origins)).toEqual({ subscriptionId: 'sub-1', notificationId: 'n-1' });
    recordInboxTurn('session-1', { subscriptionId: 'sub-1', eventId: null }, s);
    expect(currentInboxOrigin(owner, s.origins)).toBeNull();
  });

  test('the prompt sender keeps the intended origin on uncertain failures and retracts only a proven rejection', async () => {
    const s = stores();
    setAgentInboxOriginStoresForTests(s);
    for (const [id, seq] of [['n-1', 1], ['n-2', 2], ['n-3', 3]] as const) s.handled(id, seq);
    let failure: Error | null = null;
    const messages: any[] = [];
    const manager = {
      getAdapter: () => ({
        waitForReady: async () => {}, fetchMessages: async () => [...messages], fetchStatus: async () => 'stable',
        sendMessage: async (prompt: string) => {
          if (failure) throw failure;
          messages.push({ role: 'user', content: prompt }, { role: 'assistant', content: 'done' });
        },
      }),
      getSession: () => ({ id: 'session-1', agent: 'claude', status: 'running', metadata: {} }),
    } as any;
    const send = (eventId: string) => sendPromptAndAwaitAssistantReply(manager, 'session-1', `turn ${eventId}`,
      { inboxTurn: { subscriptionId: 'sub-1', eventId }, timeoutMs: 2000, pollIntervalMs: 10 });
    await send('n-1');
    expect(currentInboxOrigin(owner, s.origins)?.notificationId).toBe('n-1');
    // A definite busy refusal proves the prompt was never accepted: the session keeps acting for n-1.
    failure = Object.assign(new Error('Agent working'), { certainty: 'rejected' });
    await expect(send('n-2')).rejects.toThrow('Agent working');
    expect(currentInboxOrigin(owner, s.origins)?.notificationId).toBe('n-1');
    // A generic transport/network failure may follow acceptance: never fall back to n-1 while n-3 may be running.
    failure = new Error('Failed to deliver agent message: socket hang up');
    await expect(send('n-3')).rejects.toThrow('socket hang up');
    expect(currentInboxOrigin(owner, s.origins)?.notificationId).toBe('n-3');
  });
});

describe('strict-inbox dispatch attempts and run origins', () => {
  function harness(dispatch: () => Promise<void>) {
    const s = stores();
    const processor = new AgentInboxProcessor({
      store: s.inbox, record: () => {}, maxAttempts: 3, dispatch: async () => dispatch(),
      client: {
        createSubscription: async () => ({ recipient_npub: 'npub1bot', created: true, subscription: { id: 'tower-sub', consumer_id: 'c', floor_at: '2026-11-02T00:00:00.000Z', policy_version: 1, acked_through_seq: 0 }, cursor: 'tower-sub~c0' }),
        list: async () => ({ subscription_id: 'tower-sub', notifications: [envelope('n-1', 1)], next_cursor: 'tower-sub~c1', has_more: false }),
        context: async () => context as any,
        ack: async (_ctx, _id, input) => ({ outcome: input.outcome, replayed: false, acked_through_seq: 1 }),
      },
    });
    s.inbox.update('sub-1', { cursor: 'tower-sub~c0' });
    return { ...s, processor };
  }

  test('an inline write during dispatch acts for the running attempt; afterwards for the handled notification', async () => {
    let during: string | null = null;
    const h = harness(async () => {
      recordInboxTurn('session-1', { subscriptionId: 'sub-1', eventId: 'n-1' }, h);
      during = liveId(liveInboxOrigin(currentInboxOrigin(owner, h.origins), h.inbox));
    });
    await h.processor.pollOnce(record, request);
    expect(during).toBe('n-1');
    expect(liveId(liveInboxOrigin(currentInboxOrigin(owner, h.origins), h.inbox))).toBe('n-1');
  });

  test('failed and retried attempts never stay live', async () => {
    const failed = harness(async () => {
      recordInboxTurn('session-1', { subscriptionId: 'sub-1', eventId: 'n-1' }, failed);
      throw Object.assign(new Error('Tower refused'), { status: 403, detailCode: 'write_refused' });
    });
    await failed.processor.pollOnce(record, request);
    expect(failed.inbox.ledger('sub-1', 'n-1')?.outcome).toBe('failed_permanent');
    expect(liveId(liveInboxOrigin(currentInboxOrigin(owner, failed.origins), failed.inbox))).toBe('agent_inbox_origin_expired');
    const retried = harness(async () => {
      recordInboxTurn('session-1', { subscriptionId: 'sub-1', eventId: 'n-1' }, retried);
      throw new Error('transient');
    });
    await retried.processor.pollOnce(record, request);
    expect(retried.inbox.ledger('sub-1', 'n-1')?.handledAt).toBeNull();
    expect(liveId(liveInboxOrigin(currentInboxOrigin(owner, retried.origins), retried.inbox))).toBe('agent_inbox_origin_expired');
  });

  test('a run created during dispatch records that notification once; helper-call scopes record nothing', async () => {
    const h = harness(async () => {
      recordInboxRunOrigin('run-1', h.origins);
      recordInboxRunOrigin('run-1', h.origins);
    });
    await h.processor.pollOnce(record, request);
    expect(h.origins.history('run', 'run-1')).toEqual([{ subscriptionId: 'sub-1', notificationId: 'n-1' }]);
    recordInboxRunOrigin('run-2', h.origins);
    await agentInboxScope.run({ notification: envelope('n-9', 9), context: context as any, profileNpub: 'npub1bot', subscriptionId: 'sub-1' },
      async () => { recordInboxRunOrigin('run-2', h.origins); });
    expect(h.origins.history('run', 'run-2')).toEqual([]);
  });

  test('a declared worker or run owner never substitutes session turns for a missing snapshot', () => {
    const s = stores();
    s.handled('n-1', 1);
    recordInboxTurn('session-1', { subscriptionId: 'sub-1', eventId: 'n-1' }, s);
    expect(currentInboxOrigin({ ...owner, worker: true }, s.origins)).toBeNull();
    expect(currentInboxOrigin({ ...owner, runId: 'run-missing' }, s.origins)).toBeNull();
    s.origins.recordWorker('session-1', { subscriptionId: 'sub-1', notificationId: 'n-1' });
    // A recorded worker snapshot stays authoritative even if role metadata was patched away.
    expect(currentInboxOrigin({ ...owner, worker: false }, s.origins)?.notificationId).toBe('n-1');
  });
});

describe('supervised workers and manager fan-in', () => {
  const parent = (id: string, role?: string) => ({ id, metadata: { flightdeckSubscriptionId: 'sub-1', ...(role ? { role } : {}) } });

  test('a worker keeps the parent origin from dispatch time; the manager acts for its own later turns', () => {
    const s = stores();
    s.handled('n-1', 1);
    s.handled('n-2', 2);
    recordInboxTurn('manager', { subscriptionId: 'sub-1', eventId: 'n-1' }, s);
    snapshotWorkerInboxOrigin(parent('manager'), 'worker-1', s.origins);
    recordInboxTurn('manager', { subscriptionId: 'sub-1', eventId: 'n-2' }, s);
    expect(currentInboxOrigin({ sessionId: 'worker-1', subscriptionId: 'sub-1', worker: true }, s.origins)?.notificationId).toBe('n-1');
    // A callback prompt to the manager is not a notification turn: fan-in writes keep acting for n-2.
    expect(currentInboxOrigin({ sessionId: 'manager', subscriptionId: 'sub-1' }, s.origins)?.notificationId).toBe('n-2');
    // A nested worker inherits its parent worker's snapshot, never the parent's (empty) session turns.
    snapshotWorkerInboxOrigin(parent('worker-1', 'dispatched-worker'), 'worker-2', s.origins);
    expect(currentInboxOrigin({ sessionId: 'worker-2', subscriptionId: 'sub-1', worker: true }, s.origins)?.notificationId).toBe('n-1');
  });

  test('a parent without an origin dispatches a worker that acts for nothing', () => {
    const s = stores();
    snapshotWorkerInboxOrigin(parent('manager'), 'worker-1', s.origins);
    snapshotWorkerInboxOrigin({ id: 'legacy', metadata: {} }, 'worker-2', s.origins);
    expect(currentInboxOrigin({ sessionId: 'worker-1', subscriptionId: 'sub-1', worker: true }, s.origins)).toBeNull();
    expect(s.origins.history('worker', 'worker-2')).toEqual([]);
  });

  test('fan-in after the origin is no longer live fails closed without renewal', () => {
    const s = stores();
    s.handled('n-1', 1);
    recordInboxTurn('manager', { subscriptionId: 'sub-1', eventId: 'n-1' }, s);
    const origin = currentInboxOrigin({ sessionId: 'manager', subscriptionId: 'sub-1' }, s.origins);
    expect(liveId(liveInboxOrigin(origin, s.inbox))).toBe('n-1');
    s.inbox.update('sub-1', { floorAt: '2026-11-04T00:00:00.000Z' }); // re-anchored past the origin
    expect(liveId(liveInboxOrigin(origin, s.inbox))).toBe('agent_inbox_origin_expired');
  });
});

describe('deliberate self-address origins', () => {
  test('a self_mention notification acts only while the non-self notification it names is live; Tower gets the non-self id', () => {
    const s = stores();
    s.handled('n-human', 1);
    s.handled('n-self', 2, 'handled', { reason: 'self_mention', origin_notification_id: 'n-human' } as any);
    const self = { subscriptionId: 'sub-1', notificationId: 'n-self' };
    const live = liveInboxOrigin(self, s.inbox);
    expect(live.ok && [live.envelope.id, live.towerOriginId]).toEqual(['n-self', 'n-human']);
    const plain = liveInboxOrigin({ subscriptionId: 'sub-1', notificationId: 'n-human' }, s.inbox);
    expect(plain.ok && plain.towerOriginId).toBe('n-human');
    s.inbox.markHandled('sub-1', 'n-human', 1, 'failed_permanent', null);
    expect(liveId(liveInboxOrigin(self, s.inbox))).toBe('agent_inbox_origin_expired');
  });

  test('a self_mention without a named origin, or naming another self_mention, never acts', () => {
    const s = stores();
    s.handled('n-self-a', 1, 'handled', { reason: 'self_mention', origin_notification_id: null } as any);
    s.handled('n-self-b', 2, 'handled', { reason: 'self_mention', origin_notification_id: 'n-self-c' } as any);
    s.handled('n-self-c', 3, 'handled', { reason: 'self_mention', origin_notification_id: 'n-missing' } as any);
    for (const id of ['n-self-a', 'n-self-b', 'n-self-c']) {
      expect([id, liveId(liveInboxOrigin({ subscriptionId: 'sub-1', notificationId: id }, s.inbox))]).toEqual([id, 'agent_inbox_origin_expired']);
    }
  });
});
