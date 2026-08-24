import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TaskDirectRuntime, TaskDirectStore } from './task-direct-runtime';

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
  return { runtime, sessions, prompts, publications, processManager, subscription, botIdentity, taskEvent, get creates() { return creates; } };
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
});
