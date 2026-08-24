import { describe, expect, test } from 'bun:test';

import { AgentActivityPublisher, buildAgentActivityId, normalizeUserVisibleActivity } from './agent-activity-publisher';
import { AgentActivityPublicationStore } from './agent-activity-publication-store';

const context = {
  backendBaseUrl: 'https://tower', workspaceId: 'workspace-1', appNpub: 'npub1app',
  botIdentity: { botNpub: 'npub1agent', botPubkeyHex: '00', botSecret: new Uint8Array([1]) },
  channelId: 'channel-1', threadId: 'thread-1', triggerMessageId: 'message-1',
  sessionId: 'session-1', agentNpub: 'npub1agent', turnId: 'turn-1',
};

const publicationStore = () => new AgentActivityPublicationStore(':memory:');

describe('Agent activity publisher', () => {
  test('normalizes bounded explicit commentary and rejects empty content', () => {
    expect(normalizeUserVisibleActivity('  Checking the task.\u0000  ')).toBe('Checking the task.');
    expect(normalizeUserVisibleActivity(' \n ')).toBeNull();
    expect(normalizeUserVisibleActivity('abcdef', 5)).toBe('abcd…');
  });

  test('builds a stable interaction id and publishes monotonic lifecycle snapshots', async () => {
    const delivered: any[] = [];
    const publisher = new AgentActivityPublisher(context, async (input) => { delivered.push(input); return {}; }, 0,
      undefined, undefined, publicationStore());
    await publisher.publish('accepted');
    await publisher.publish('working', 'Running validation.');
    await publisher.publish('working', 'Running validation.');
    await publisher.publish('completed');
    await publisher.publish('failed');
    expect(delivered.map((item) => [item.state, item.sequence])).toEqual([
      ['accepted', 1], ['working', 2], ['completed', 3],
    ]);
    expect(delivered.map((item) => item.label)).toEqual(['Message received', 'Working', undefined]);
    expect(delivered[1]).toMatchObject({ channelId: 'channel-1', threadId: 'thread-1',
      triggerMessageId: 'message-1', turnId: 'turn-1', sessionId: 'session-1', agentNpub: 'npub1agent' });
    expect(delivered[0].activityId).toBe(buildAgentActivityId(context));
  });

  test('advances one activity without changing its published session correlation', async () => {
    const delivered: any[] = [];
    const publisher = new AgentActivityPublisher({ ...context, sessionId: 'pending:turn-1' }, async (input) => {
      delivered.push(input);
      return {};
    }, 0, undefined, undefined, publicationStore());
    await publisher.publish('accepted');
    publisher.bindSession('session-opened');
    await publisher.publish('working');
    expect(delivered.map((item) => ({ activityId: item.activityId, sessionId: item.sessionId, label: item.label }))).toEqual([
      { activityId: buildAgentActivityId(context), sessionId: 'pending:turn-1', label: 'Message received' },
      { activityId: buildAgentActivityId(context), sessionId: 'pending:turn-1', label: 'Agent started' },
    ]);
  });

  test('reads successive commentary from the bound runtime session while replacing one published activity', async () => {
    const delivered: any[] = [];
    const lookedUpSessionIds: string[] = [];
    const commentary = [
      { content: 'First update', createdAt: '2026-07-24T00:00:01.000Z' },
      { content: 'Latest update', createdAt: '2026-07-24T00:00:02.000Z' },
    ];
    const publisher = new AgentActivityPublisher(
      { ...context, sessionId: 'pending:turn-1' },
      async (input) => { delivered.push(input); return {}; },
      0,
      async () => commentary.shift() ?? null, undefined, publicationStore(),
    );
    publisher.bindSession('session-opened');
    const manager = { getSession: (sessionId: string) => {
      lookedUpSessionIds.push(sessionId);
      return { agent: 'codex', metadata: { nativeAgentSession: {
        agent: 'codex', sessionId: 'native-1', workingDirectory: '/repo',
      } } };
    } } as any;

    await publisher.publishLatestCommentary(manager);
    await publisher.publishLatestCommentary(manager);

    expect(lookedUpSessionIds).toEqual(['session-opened', 'session-opened']);
    expect(delivered.map((item) => ({
      activityId: item.activityId, sessionId: item.sessionId, sequence: item.sequence, body: item.body,
    }))).toEqual([
      { activityId: buildAgentActivityId(context), sessionId: 'pending:turn-1', sequence: 1, body: 'First update' },
      { activityId: buildAgentActivityId(context), sessionId: 'pending:turn-1', sequence: 2, body: 'Latest update' },
    ]);
  });

  test('retries one delivery failure and never throws into the reply path', async () => {
    let attempts = 0;
    const publisher = new AgentActivityPublisher(context, async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('temporary Tower failure');
      return {};
    }, undefined, undefined, console, publicationStore());
    await expect(publisher.publish('accepted')).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    const errors: unknown[] = [];
    const unavailable = new AgentActivityPublisher(context, async () => { throw new Error('offline'); },
      undefined, undefined, { error: (...args: unknown[]) => { errors.push(args); } }, publicationStore());
    await expect(unavailable.publish('accepted')).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
  });

  test('does not let an unestablished replay terminalize the owning activity', async () => {
    let sequence = 0;
    let state = '';
    const errors: unknown[] = [];
    const deliver = async (input: any) => {
      if (input.sequence <= sequence) throw new Error('stale_agent_activity_sequence');
      sequence = input.sequence;
      state = input.state;
      return {};
    };
    const durableContext = { ...context, startedAt: '2026-08-04T01:15:38.706Z' };
    const store = publicationStore();
    const owner = new AgentActivityPublisher(durableContext, deliver, undefined, undefined,
      { error: (...args: unknown[]) => { errors.push(args); } }, store);
    await owner.publish('accepted');
    await owner.publish('working');

    const replay = new AgentActivityPublisher(durableContext, deliver, undefined, undefined,
      { error: (...args: unknown[]) => { errors.push(args); } }, store);
    await replay.publish('accepted');
    await replay.publish('failed');
    await owner.publish('working', 'Commentary remains visible.');

    expect(state).toBe('working');
    expect(sequence).toBe(Date.parse(durableContext.startedAt) * 1_000 + 3);
    expect(errors).toHaveLength(0);
  });

  test('keeps commentary monotonic and deduplicated across replay and reconnect publishers', async () => {
    const store = publicationStore();
    const delivered: any[] = [];
    const durableContext = { ...context, startedAt: '2026-08-04T01:15:38.706Z' };
    const deliver = async (input: any) => {
      delivered.push(input);
      return { agent_activity: { id: 'row-1' }, event: { event_id: `event-${input.sequence}`, cursor: String(input.sequence) } };
    };
    const first = new AgentActivityPublisher(durableContext, deliver, undefined,
      async () => ({ content: 'Inspecting the event path.', createdAt: '2026-08-04T01:15:57.249Z' }),
      undefined, store);
    await first.publish('accepted');
    await first.publish('working');

    const reconnect = new AgentActivityPublisher(durableContext, deliver, undefined,
      async () => ({ content: 'Inspecting the event path.', createdAt: '2026-08-04T01:15:57.249Z' }),
      undefined, store);
    await reconnect.publish('accepted');
    await reconnect.publish('working');
    await reconnect.publishLatestCommentary({ getSession: () => ({ agent: 'codex', metadata: { nativeAgentSession: {
      agent: 'codex', sessionId: 'native-1', workingDirectory: '/repo',
    } } }) } as any);

    const replay = new AgentActivityPublisher(durableContext, deliver, undefined,
      async () => ({ content: 'Inspecting the event path.', createdAt: '2026-08-04T01:15:57.249Z' }),
      undefined, store);
    await replay.publish('accepted');
    await replay.publishLatestCommentary({ getSession: () => ({ agent: 'codex', metadata: { nativeAgentSession: {
      agent: 'codex', sessionId: 'native-1', workingDirectory: '/repo',
    } } }) } as any);
    await replay.publish('completed');

    expect(delivered.map((item) => [item.state, item.sequence, item.body ?? null])).toEqual([
      ['accepted', Date.parse(durableContext.startedAt) * 1_000 + 1, null],
      ['working', Date.parse(durableContext.startedAt) * 1_000 + 2, null],
      ['working', Date.parse(durableContext.startedAt) * 1_000 + 3, 'Inspecting the event path.'],
      ['completed', Date.parse(durableContext.startedAt) * 1_000 + 4, null],
    ]);
    expect(delivered.every((item) => item.turnId === durableContext.turnId)).toBe(true);
  });

  test('reports Tower turn identity mismatches with compatibility telemetry', async () => {
    const errors: unknown[][] = [];
    const mismatch = Object.assign(new Error('Agent activity turn identity does not match.'), {
      status: 409,
      detailCode: 'agent_activity_turn_identity_mismatch',
      details: { fields: [{ path: 'turn_id', code: 'mismatch', message: 'turn_id is immutable' }] },
    });
    const publisher = new AgentActivityPublisher(context, async () => { throw mismatch; }, 0, undefined,
      { error: (...args: unknown[]) => { errors.push(args); } }, publicationStore());

    await expect(publisher.publish('accepted')).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBe('[agent-activity] Tower publication failed after retry');
    expect(errors[0]?.[1]).toMatchObject({
      activityId: buildAgentActivityId(context), turnId: 'turn-1', state: 'accepted', stage: 'publication_failed',
      attempts: 2, status: 409, detailCode: 'agent_activity_turn_identity_mismatch',
      details: { fields: [{ path: 'turn_id', code: 'mismatch', message: 'turn_id is immutable' }] },
    });
  });

  test('serializes deliveries so a slower earlier publish cannot overwrite newer commentary', async () => {
    const delivered: string[] = [];
    let releaseFirst!: () => void;
    const firstDelivery = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const publisher = new AgentActivityPublisher(context, async (input) => {
      if (input.body === 'First commentary') await firstDelivery;
      delivered.push(input.body ?? input.state);
      return {};
    }, 0, undefined, undefined, publicationStore());
    const first = publisher.publish('working', 'First commentary');
    const second = publisher.publish('working', 'Newest commentary');
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);
    expect(delivered).toEqual(['First commentary', 'Newest commentary']);
  });

  test('ignores an older commentary read that completes after a newer poll', async () => {
    const delivered: string[] = [];
    let resolveOlder!: (value: any) => void;
    let reads = 0;
    const publisher = new AgentActivityPublisher(context, async (input) => {
      delivered.push(input.body ?? input.state);
      return {};
    }, 0, async () => {
      reads += 1;
      if (reads === 1) return await new Promise((resolve) => { resolveOlder = resolve; });
      return { content: 'Newest commentary', createdAt: '2026-07-24T00:00:03.000Z' };
    }, undefined, publicationStore());
    const manager = { getSession: () => ({
      agent: 'codex', metadata: { nativeAgentSession: { agent: 'codex', sessionId: 'native-1', workingDirectory: '/repo' } },
    }) } as any;
    const olderPoll = publisher.publishLatestCommentary(manager);
    await publisher.publishLatestCommentary(manager);
    resolveOlder({ content: 'Older commentary', createdAt: '2026-07-24T00:00:02.000Z' });
    await olderPoll;
    expect(delivered).toEqual(['Newest commentary']);
  });
});
