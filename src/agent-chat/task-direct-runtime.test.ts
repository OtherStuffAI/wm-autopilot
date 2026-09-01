import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TaskDirectRuntime, TaskDirectStore } from './task-direct-runtime';

const rickInstanceNpub = 'npub1s4658awhcachmhzk5jhsg256gzdl7e4gh5a9zq8skjyt7g3k2axql224qz';
const stableBotNpub = 'npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'task-direct-'));
  dirs.push(dir);
  const sessions = new Map<string, any>();
  const prompts: string[] = [];
  const publications: any[] = [];
  let creates = 0;
  const processManager = {
    getSession: (id: string) => sessions.get(id) ?? null,
    createSession: async (...args: any[]) => {
      creates += 1;
      const session = { id: `session-${creates}`, agent: args[0], status: 'running', workingDirectory: args[1], metadata: args[6] };
      sessions.set(session.id, session);
      return session;
    },
  };
  const runtime = new TaskDirectRuntime({
    defaultAgent: 'codex', processManager: processManager as any,
    agentStore: {
      listByWorkspaceAndBot: () => [{
        agentId: 'exampleAgent', label: 'Example Agent', botNpub: 'npub-exampleAgent', workspaceOwnerNpub: 'npub-workspace',
        managedByNpub: 'npub-human', workingDirectory: '/repo', capabilities: ['task_dispatch'], enabled: true,
        groupNpubs: [], createdAt: '', updatedAt: '',
      }],
    } as any,
    store: new TaskDirectStore(join(dir, 'state.sqlite')),
    fetchTask: async () => ({ task: { id: 'task-1', title: 'Build it', description: 'Latest', channel_id: 'channel-2', thread_id: 'thread-1' } }) as any,
    fetchComments: async () => ({ comments: [{ id: 'comment-1', body: 'Do it' }], next_cursor: null }) as any,
    fetchChannel: async () => ({ id: 'channel-2', scope_id: 'scope-1' }) as any,
    fetchMessages: async () => ({ messages: [{ id: 'message-1', body: 'Originating thread' }], next_cursor: null }) as any,
    fetchWorkroomContext: async () => ({ isWorkroom: true, workroom: { id: 'thread-1' }, participant: null, appTargets: [], recentEvents: [], recentLinks: [], openApprovals: [] }),
    sendFinalResponse: async (_manager, _sessionId, prompt) => {
      prompts.push(prompt);
      return { content: `final-${prompts.length}`, createdAt: new Date().toISOString() };
    },
    publish: async (input) => {
      publications.push(input);
      return { comment: { id: `published-${publications.length}` } } as any;
    },
  });
  const subscription = {
    subscriptionId: 'sub-1', workspaceServiceNpub: 'npub-workspace', workspaceOwnerNpub: 'npub-human',
    backendBaseUrl: 'http://tower', towerServiceNpub: 'npub-tower', workspaceId: 'workspace-1',
    sourceAppNpub: 'npub-app', botNpub: 'npub-exampleAgent', wsKeyNpub: 'npub-workspace-key', managedByNpub: 'npub-human',
  } as any;
  const botIdentity = { botNpub: 'npub-exampleAgent', botPubkeyHex: '00', botSecret: new Uint8Array() };
  const taskEvent = (id: string, payload: Record<string, unknown>) => ({
    event_id: id, event_type: 'flightdeck_pg.task.created', entity_type: 'task', entity_id: 'task-1',
    operation: 'created', actor_npub: 'npub-human', payload,
  });
  const taskCommentEvent = (id: string, mentionedNpub: string, actorNpub = 'npub-human') => {
    const mention = { type: 'agent', actor_id: `actor-${mentionedNpub}`, npub: mentionedNpub, label: 'Agent' };
    return {
      event_id: id, event_type: 'flightdeck_pg.task_comment.created', entity_type: 'task_comment',
      entity_id: `comment-${id}`, operation: 'created', actor_npub: actorNpub,
      payload: {
        task_id: 'task-1', mentions: [mention],
        comment: { id: `comment-${id}`, task_id: 'task-1', metadata: { mentions: [mention] } },
      },
    };
  };
  return { runtime, sessions, prompts, publications, processManager, subscription, botIdentity, taskEvent, taskCommentEvent,
    get creates() { return creates; } };
}

describe('TaskDirectRuntime', () => {
  const mention = { type: 'agent', actor_id: 'actor-exampleAgent', npub: 'npub-exampleAgent', label: 'exampleAgent' };

  test('creates once, reuses live session, and publishes each final once', async () => {
    const f = fixture();
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity,
      event: f.taskEvent('event-1', { newly_added_mentions: [{ type: 'agent', npub: 'npub-exampleAgent' }] }) });
    await f.runtime.waitForIdle();
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity,
      event: f.taskEvent('event-2', { newly_assigned_agents: [{ agent_npub: 'npub-exampleAgent' }] }) });
    await f.runtime.waitForIdle();
    expect(f.creates).toBe(1);
    expect(f.prompts).toHaveLength(2);
    expect(f.publications).toHaveLength(2);
    expect(f.prompts[0]).toContain('description_mention_added');
    expect(f.prompts[1]).toContain('agent_assigned');
    expect(f.publications[0].metadata.source).toBe('autopilot_task_session');
  });

  test('starts a new generation after the bound session stops', async () => {
    const f = fixture();
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity,
      event: f.taskEvent('event-1', { newly_assigned_agents: [{ agent_npub: 'npub-exampleAgent' }] }) });
    await f.runtime.waitForIdle();
    f.sessions.get('session-1').status = 'stopped';
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity,
      event: f.taskEvent('event-2', { newly_assigned_agents: [{ agent_npub: 'npub-exampleAgent' }] }) });
    await f.runtime.waitForIdle();
    expect(f.creates).toBe(2);
    expect(f.prompts[1]).toContain('Generation: 2');
    expect(f.prompts[1]).toContain('session-1');
  });

  test('suppresses replayed and self-authored events', async () => {
    const f = fixture();
    const event = f.taskEvent('event-1', { task_id: 'task-1', mentions: [mention], task: { id: 'task-1' } });
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity, event });
    await f.runtime.waitForIdle();
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity, event });
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity,
      event: { ...f.taskEvent('event-self', { task_id: 'task-1', mentions: [mention], task: { id: 'task-1' } }), actor_npub: 'npub-exampleAgent' } });
    await f.runtime.waitForIdle();
    expect(f.publications).toHaveLength(1);
  });

  test('coalesces separate Tower description and assignment outbox rows', async () => {
    const f = fixture();
    const description = f.taskEvent('event-description', { task_id: 'task-1', mentions: [mention], task: { id: 'task-1' } });
    const assignment = {
      event_id: 'event-assignment', event_type: 'flightdeck_pg.task_assignment.assigned',
      entity_type: 'task_assignment', entity_id: 'task-1', operation: 'assigned', actor_npub: 'npub-human',
      payload: { task_id: 'task-1', assignee: { actor_id: 'actor-exampleAgent', actor_npub: 'npub-exampleAgent' },
        transition: { previous: 'absent', current: 'present' }, assignment: { task_id: 'task-1', actor_id: 'actor-exampleAgent' } },
    };
    await Promise.all([
      f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity, event: description }),
      f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity, event: assignment }),
    ]);
    await f.runtime.waitForIdle();
    expect(f.creates).toBe(1);
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain('description_mention_added');
    expect(f.prompts[0]).toContain('agent_assigned');
    expect(f.publications[0].metadata.source_event_ids).toEqual(['event-description', 'event-assignment']);
  });

  test('authorizes by typed task read before session creation and releases failed events for retry', async () => {
    const f = fixture();
    let attempts = 0;
    (f.runtime as any).deps.fetchTask = async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('forbidden'), { status: 403 });
      return { task: { id: 'task-1', title: 'Build it', channel_id: 'channel-2', thread_id: 'thread-1' } };
    };
    const event = f.taskEvent('event-auth', { newly_assigned_agents: [{ agent_npub: 'npub-exampleAgent' }] });
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity, event });
    await expect(f.runtime.waitForIdle()).rejects.toThrow('forbidden');
    expect(f.creates).toBe(0);
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity, event });
    await f.runtime.waitForIdle();
    expect(f.creates).toBe(1);
    expect(f.publications).toHaveLength(1);
  });

  test('keeps different agents on separate routing identities', async () => {
    const f = fixture();
    (f.runtime as any).deps.agentStore.listByWorkspaceAndBot = () => [
      { agentId: 'exampleAgent', label: 'Example Agent', botNpub: 'npub-exampleAgent', workspaceOwnerNpub: 'npub-workspace', workingDirectory: '/repo', enabled: true, capabilities: [] },
      { agentId: 'wm22', label: 'Jane', botNpub: 'npub-jane', workspaceOwnerNpub: 'npub-workspace', workingDirectory: '/repo', enabled: true, capabilities: [] },
    ];
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity,
      event: f.taskEvent('event-1', { newly_added_mentions: [
        { type: 'agent', npub: 'npub-exampleAgent' }, { type: 'agent', npub: 'npub-jane' },
      ] }) });
    await f.runtime.waitForIdle();
    expect(f.creates).toBe(2);
    expect(new Set(f.publications.map((entry) => entry.metadata.routing_key)).size).toBe(2);
  });

  test('routes a canonical task-comment mention directly to the stable bot', async () => {
    const f = fixture();
    const result = await f.runtime.handle({
      subscription: f.subscription,
      botIdentity: f.botIdentity,
      instanceNpub: rickInstanceNpub,
      event: f.taskCommentEvent('direct-stable', 'npub-exampleAgent'),
    });
    await f.runtime.waitForIdle();
    expect(result).toEqual({ handled: true, reason: 'task_direct_queued', targeting: 'direct_bot' });
    expect(f.publications).toHaveLength(1);
    expect(f.publications[0].metadata).toMatchObject({ targeting: 'direct_bot', instance_alias_npub: null });
  });

  test('resolves the Rick instance alias only to the subscription-bound current task assignee', async () => {
    const f = fixture();
    f.subscription.botNpub = stableBotNpub;
    f.botIdentity.botNpub = stableBotNpub;
    (f.runtime as any).deps.agentStore.listByWorkspaceAndBot = () => [
      { agentId: 'stable-agent', label: 'Stable Agent', botNpub: stableBotNpub, workspaceOwnerNpub: 'npub-workspace', workingDirectory: '/repo', enabled: true, capabilities: [] },
      { agentId: 'other-agent', label: 'Other Agent', botNpub: 'npub-other-agent', workspaceOwnerNpub: 'npub-workspace', workingDirectory: '/other', enabled: true, capabilities: [] },
    ];
    (f.runtime as any).deps.fetchTask = async () => ({ task: {
      id: 'task-1', assigned_to_npub: stableBotNpub, channel_id: 'channel-2', thread_id: 'thread-1',
      assignments: [{ actor_npub: stableBotNpub }, { actor_npub: 'npub-other-agent' }],
    } });
    const result = await f.runtime.handle({
      subscription: f.subscription,
      botIdentity: f.botIdentity,
      instanceNpub: rickInstanceNpub,
      event: f.taskCommentEvent('rick-alias', rickInstanceNpub),
    });
    await f.runtime.waitForIdle();
    expect(result).toEqual({ handled: true, reason: 'task_direct_alias_queued', targeting: 'instance_alias' });
    expect(f.creates).toBe(1);
    expect(f.publications).toHaveLength(1);
    expect(f.publications[0].metadata).toMatchObject({
      agent_npub: stableBotNpub, targeting: 'instance_alias', instance_alias_npub: rickInstanceNpub,
    });
    expect(f.prompts[0]).toContain('Targeting: instance_alias');
  });

  test('does not fan an instance alias across agents or workspace subscriptions', async () => {
    const f = fixture();
    const otherBotNpub = 'npub-other-workspace-agent';
    (f.runtime as any).deps.agentStore.listByWorkspaceAndBot = (_workspaceNpub: string, botNpub: string) => [{
      agentId: botNpub === stableBotNpub ? 'stable-agent' : 'other-workspace-agent',
      label: 'Bound Agent', botNpub, workspaceOwnerNpub: _workspaceNpub,
      workingDirectory: '/repo', enabled: true, capabilities: [],
    }];
    (f.runtime as any).deps.fetchTask = async ({ workspaceId }: { workspaceId: string }) => ({ task: {
      id: 'task-1', workspace_id: workspaceId, assigned_to_npub: stableBotNpub,
      channel_id: 'channel-2', thread_id: 'thread-1',
    } });
    const primary = { ...f.subscription, botNpub: stableBotNpub };
    const other = {
      ...f.subscription, subscriptionId: 'sub-2', workspaceId: 'workspace-2',
      workspaceServiceNpub: 'npub-workspace-2', botNpub: otherBotNpub,
    };
    const event = f.taskCommentEvent('workspace-safe-alias', rickInstanceNpub);
    const primaryResult = await f.runtime.handle({
      subscription: primary, botIdentity: { ...f.botIdentity, botNpub: stableBotNpub }, instanceNpub: rickInstanceNpub, event,
    });
    const otherResult = await f.runtime.handle({
      subscription: other, botIdentity: { ...f.botIdentity, botNpub: otherBotNpub }, instanceNpub: rickInstanceNpub, event,
    });
    await f.runtime.waitForIdle();
    expect(primaryResult.reason).toBe('task_direct_alias_queued');
    expect(otherResult).toEqual({ handled: false, reason: 'instance_alias_not_targeted', targeting: null });
    expect(f.publications).toHaveLength(1);
    expect(f.publications[0].metadata.agent_npub).toBe(stableBotNpub);
  });

  test('suppresses self-authored and duplicate instance-alias task comments', async () => {
    const f = fixture();
    f.subscription.botNpub = stableBotNpub;
    f.botIdentity.botNpub = stableBotNpub;
    (f.runtime as any).deps.agentStore.listByWorkspaceAndBot = () => [{
      agentId: 'stable-agent', label: 'Stable Agent', botNpub: stableBotNpub,
      workspaceOwnerNpub: 'npub-workspace', workingDirectory: '/repo', enabled: true, capabilities: [],
    }];
    (f.runtime as any).deps.fetchTask = async () => ({ task: {
      id: 'task-1', assigned_to_npub: stableBotNpub, channel_id: 'channel-2', thread_id: 'thread-1',
    } });
    const event = f.taskCommentEvent('deduped-alias', rickInstanceNpub);
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity, instanceNpub: rickInstanceNpub, event });
    await f.runtime.waitForIdle();
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity, instanceNpub: rickInstanceNpub, event });
    await f.runtime.handle({
      subscription: f.subscription, botIdentity: f.botIdentity, instanceNpub: rickInstanceNpub,
      event: f.taskCommentEvent('self-alias', rickInstanceNpub, stableBotNpub),
    });
    await f.runtime.waitForIdle();
    expect(f.publications).toHaveLength(1);
  });

  test('leaves an unmatched arbitrary npub not targeted', async () => {
    const f = fixture();
    expect(await f.runtime.handle({
      subscription: f.subscription,
      botIdentity: f.botIdentity,
      instanceNpub: rickInstanceNpub,
      event: f.taskCommentEvent('arbitrary', 'npub-arbitrary'),
    })).toEqual({ handled: false, reason: 'not_targeted', targeting: null });
    await f.runtime.waitForIdle();
    expect(f.publications).toHaveLength(0);
  });
});
