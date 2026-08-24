import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';
import { nip19 } from 'nostr-tools';

import type { SessionSnapshot } from '../agents/process-manager';
import type { AgentDefinitionRecord, WorkspaceSubscriptionRecord } from '../agent-chat/types';
import { AgentWorkSessionBindingStore } from './session-binding-store';
import {
  AgentWorkSessionRuntime,
  evaluateTaskDispatchEligibility,
  normaliseInboundApprovalRecord,
  normaliseInboundTaskRecord,
} from './session-runtime';

function makeTempDb(): string {
  return join(tmpdir(), `agent-work-runtime-${randomUUID()}.sqlite`);
}

function makeSession(id: string, metadata: SessionSnapshot['metadata'] = { AGENT: true, billingMode: 'subscription' }): SessionSnapshot {
  return {
    id,
    agent: 'codex',
    port: 3700,
    name: id,
    status: 'running',
    agentRuntimeStatus: 'stable',
    startedAt: new Date().toISOString(),
    npub: 'npub1manager',
    pid: 1234,
    command: ['codex'],
    workingDirectory: '/tmp/work',
    logs: [],
    metadata,
  };
}

function makeAgent(): AgentDefinitionRecord {
  const now = new Date().toISOString();
  const botNpub = nip19.npubEncode('ab'.repeat(32));
  return {
    agentId: 'agent-work',
    label: 'Worker',
    botNpub,
    workspaceOwnerNpub: 'npub1workspace',
    groupNpubs: ['npub1group'],
    workingDirectory: '/tmp/work',
    capabilities: ['task_dispatch'],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    managedByNpub: 'npub1manager',
  };
}

function botPubkeyHex(agent: AgentDefinitionRecord): string {
  const decoded = nip19.decode(agent.botNpub);
  if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
    throw new Error('Expected bot npub');
  }
  return decoded.data;
}

function makeSubscription(): WorkspaceSubscriptionRecord {
  const now = new Date().toISOString();
  return {
    subscriptionId: 'sub-1',
    workspaceOwnerNpub: 'npub1workspace',
    backendBaseUrl: 'https://tower.example.com',
    botNpub: 'npub1bot',
    sourceAppNpub: 'npub1source',
    wsKeyNpub: 'npub1wskey',
    wsKeyStatus: 'active',
    groupKeyStatus: 'active',
    sseStatus: 'connected',
    healthStatus: 'healthy',
    triggerConfigRecordId: null,
    lastSseEventId: null,
    lastAuthOkAt: now,
    lastGroupRefreshAt: now,
    lastErrorCode: null,
    lastErrorAt: null,
    createdAt: now,
    updatedAt: now,
    managedByNpub: 'npub1manager',
    wsKeyBlobJson: null,
    wrappedGroupKeysJson: null,
    lastAuthResult: null,
    lastGroupRefreshResult: null,
    lastRecordPullResult: null,
    lastDecryptResult: null,
    lastRoutingResult: null,
    lastSseEvent: null,
    recentSseEvents: [],
    recentDispatches: [],
    lastSuccessfulStartupReloadAt: null,
  };
}

describe('AgentWorkSessionRuntime', () => {
  test('chooses task binding first, then creates task sessions', async () => {
    const bindingStore = new AgentWorkSessionBindingStore(makeTempDb());
    const sessions = new Map<string, SessionSnapshot>();
    sessions.set('task-session', makeSession('task-session'));
    sessions.set('flow-session', makeSession('flow-session'));
    let createCount = 0;

    const runtime = new AgentWorkSessionRuntime({
      defaultAgent: 'codex',
      bindingStore,
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      createSession: async () => {
        createCount += 1;
        const session = makeSession(`created-${createCount}`);
        sessions.set(session.id, session);
        return session;
      },
      updateSessionMetadata: (sessionId, metadata) => {
        const existing = sessions.get(sessionId)!;
        const next = { ...existing, metadata: { ...existing.metadata, ...(metadata ?? {}) } };
        sessions.set(sessionId, next);
        return next;
      },
      addPrompt: () => undefined,
      maybeAutoDispatchQueuedPrompt: () => undefined,
      enableNightWatch: () => undefined,
    });

    const subscription = makeSubscription();
    const agent = makeAgent();
    const now = new Date().toISOString();
    bindingStore.save({
      subscriptionId: subscription.subscriptionId,
      agentId: agent.agentId,
      bindingType: 'task',
      bindingId: 'task-1',
      sessionId: 'task-session',
      lastRecordIdSeen: 'record-1',
      state: 'active',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const taskFirst = await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-3',
      recordState: null,
      task: {
        taskId: 'task-1',
        flowId: 'flow-a',
        flowRunId: 'flow-1',
        flowStep: 'step-1',
        title: 'Task one',
        description: 'Do the thing',
        state: 'ready',
        assignedTo: agent.botNpub,
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });
    expect(taskFirst?.id).toBe('task-session');

    const flowFallback = await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-4',
      recordState: null,
      task: {
        taskId: 'task-2',
        flowId: 'flow-a',
        flowRunId: 'flow-1',
        flowStep: 'step-2',
        title: 'Task two',
        description: 'Do the next thing',
        state: 'ready',
        assignedTo: agent.botNpub,
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });
    expect(flowFallback?.id).toBe('created-1');

    const created = await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-5',
      recordState: null,
      task: {
        taskId: 'task-3',
        flowId: null,
        flowRunId: null,
        flowStep: null,
        title: 'Task three',
        description: 'Create a new session',
        state: 'ready',
        assignedTo: agent.botNpub,
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });
    expect(created?.id).toBe('created-2');
    expect(createCount).toBe(2);
  });

  test('keeps delivery tasks bound to their own sessions', async () => {
    const bindingStore = new AgentWorkSessionBindingStore(makeTempDb());
    const sessions = new Map<string, SessionSnapshot>();
    const prompts: Array<{ sessionId: string; content: string }> = [];
    const dispatches: string[] = [];
    const nightWatch: string[] = [];
    let createCount = 0;

    const runtime = new AgentWorkSessionRuntime({
      defaultAgent: 'codex',
      bindingStore,
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      createSession: async (_agent, workingDirectory, name, _origin, explicitNpub, metadata) => {
        createCount += 1;
        const session = makeSession(`session-${createCount}`, {
          AGENT: true,
          billingMode: 'subscription',
          ...metadata,
        });
        session.name = name;
        session.workingDirectory = workingDirectory;
        session.npub = explicitNpub;
        sessions.set(session.id, session);
        return session;
      },
      updateSessionMetadata: (sessionId, metadata) => {
        const existing = sessions.get(sessionId)!;
        const next = { ...existing, metadata: { ...existing.metadata, ...(metadata ?? {}) } };
        sessions.set(sessionId, next);
        return next;
      },
      addPrompt: (sessionId, content) => {
        prompts.push({ sessionId, content });
        return null;
      },
      maybeAutoDispatchQueuedPrompt: (session) => {
        if (session) dispatches.push(session.id);
      },
      enableNightWatch: (sessionId) => {
        nightWatch.push(sessionId);
      },
    });

    const subscription = makeSubscription();
    const agent = makeAgent();

    const first = await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-task-1',
      recordState: null,
      task: {
        taskId: 'task-1',
        flowId: 'flow-a',
        flowRunId: 'run-1',
        flowStep: 'step-1',
        title: 'First task',
        description: 'Initial task',
        state: 'ready',
        assignedTo: agent.botNpub,
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });

    expect(first?.id).toBe('session-1');
    expect(createCount).toBe(1);
    expect(bindingStore.getByBinding(subscription.subscriptionId, agent.agentId, 'task', 'task-1')?.sessionId).toBe('session-1');
    expect(prompts[0]?.content).toContain('Dispatch reason: new task.');
    expect(prompts[0]?.content).toContain('Task id: task-1');

    const second = await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-task-2',
      recordState: null,
      task: {
        taskId: 'task-2',
        flowId: 'flow-a',
        flowRunId: 'run-1',
        flowStep: 'step-2',
        title: 'Second task',
        description: 'Follow-up task',
        state: 'ready',
        assignedTo: agent.botNpub,
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });

    expect(second?.id).toBe('session-2');
    expect(createCount).toBe(2);
    expect(bindingStore.getByBinding(subscription.subscriptionId, agent.agentId, 'task', 'task-2')?.sessionId).toBe('session-2');

    expect(createCount).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(dispatches).toEqual(['session-1', 'session-2']);
    expect(nightWatch).toEqual([]);
  });

  test('routes task comments into the existing live task session with yoke commands', async () => {
    const bindingStore = new AgentWorkSessionBindingStore(makeTempDb());
    const sessions = new Map<string, SessionSnapshot>();
    const prompts: Array<{ sessionId: string; content: string }> = [];
    const dispatches: string[] = [];
    const nightWatch: string[] = [];
    const now = new Date().toISOString();
    const liveSession = makeSession('task-comment-session', {
      AGENT: true,
      billingMode: 'subscription',
      bindingType: 'task',
      bindingId: 'task-comment-1',
      taskIds: ['task-comment-1'],
    });
    sessions.set(liveSession.id, liveSession);

    bindingStore.save({
      subscriptionId: 'sub-1',
      agentId: 'agent-work',
      bindingType: 'task',
      bindingId: 'task-comment-1',
      sessionId: liveSession.id,
      lastRecordIdSeen: 'record-task-1',
      state: 'active',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const runtime = new AgentWorkSessionRuntime({
      defaultAgent: 'codex',
      bindingStore,
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      createSession: async () => {
        throw new Error('createSession should not run for task comments with an active task session');
      },
      updateSessionMetadata: (sessionId, metadata) => {
        const existing = sessions.get(sessionId)!;
        const next = { ...existing, metadata: { ...existing.metadata, ...(metadata ?? {}) } };
        sessions.set(sessionId, next);
        return next;
      },
      addPrompt: (sessionId, content) => {
        prompts.push({ sessionId, content });
        return null;
      },
      maybeAutoDispatchQueuedPrompt: (session) => {
        if (session) {
          dispatches.push(session.id);
        }
      },
      enableNightWatch: (sessionId) => {
        nightWatch.push(sessionId);
      },
      prepareWorkspaceYokeRuntime: async () => ({
        stateDir: '/tmp/agent-work-task-comment',
        commandPrefix: 'ignored',
        didSync: true,
      }),
    });

    const subscription = makeSubscription();
    const agent = makeAgent();

    const session = await runtime.handleTaskCommentDispatch({
      subscription,
      agent,
      recordId: 'record-comment-1',
      comment: {
        commentId: 'comment-1',
        targetRecordId: 'task-comment-1',
        targetRecordFamilyHash: 'npub1source:task',
        parentCommentId: null,
        anchorLineNumber: null,
        commentStatus: 'open',
        body: 'Please review the latest change and confirm next steps.',
        attachments: [],
        senderNpub: 'npub1reviewer',
        recordState: 'active',
      },
      botIdentity: {
        botNpub: agent.botNpub,
        botPubkeyHex: botPubkeyHex(agent),
        botSecret: new Uint8Array(32),
      },
    });

    expect(session?.id).toBe(liveSession.id);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionId).toBe(liveSession.id);
    expect(prompts[0]?.content).toContain('Dispatch reason: task comment added.');
    expect(prompts[0]?.content).toContain("tasks show 'task-comment-1'");
    expect(prompts[0]?.content).toContain("tasks reply 'comment-1'");
    expect(dispatches).toEqual([liveSession.id]);
    expect(nightWatch).toEqual([]);
  });

  test('does not re-enqueue the same task comment advisory when the same record is seen again', async () => {
    const bindingStore = new AgentWorkSessionBindingStore(makeTempDb());
    const sessions = new Map<string, SessionSnapshot>();
    const prompts: Array<{ sessionId: string; content: string }> = [];
    const dispatches: string[] = [];
    const now = new Date().toISOString();
    const liveSession = makeSession('task-comment-session', {
      AGENT: true,
      billingMode: 'subscription',
      bindingType: 'task',
      bindingId: 'task-comment-1',
      taskIds: ['task-comment-1'],
    });
    sessions.set(liveSession.id, liveSession);

    bindingStore.save({
      subscriptionId: 'sub-1',
      agentId: 'agent-work',
      bindingType: 'task',
      bindingId: 'task-comment-1',
      sessionId: liveSession.id,
      lastRecordIdSeen: 'record-task-1',
      state: 'active',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const runtime = new AgentWorkSessionRuntime({
      defaultAgent: 'codex',
      bindingStore,
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      createSession: async () => {
        throw new Error('createSession should not run for task comments with an active task session');
      },
      updateSessionMetadata: (sessionId, metadata) => {
        const existing = sessions.get(sessionId)!;
        const next = { ...existing, metadata: { ...existing.metadata, ...(metadata ?? {}) } };
        sessions.set(sessionId, next);
        return next;
      },
      addPrompt: (sessionId, content) => {
        prompts.push({ sessionId, content });
        return null;
      },
      maybeAutoDispatchQueuedPrompt: (session) => {
        if (session) {
          dispatches.push(session.id);
        }
      },
      enableNightWatch: () => undefined,
      prepareWorkspaceYokeRuntime: async () => ({
        stateDir: '/tmp/agent-work-task-comment',
        commandPrefix: 'ignored',
        didSync: true,
      }),
    });

    const subscription = makeSubscription();
    const agent = makeAgent();
    const comment = {
      commentId: 'comment-1',
      targetRecordId: 'task-comment-1',
      targetRecordFamilyHash: 'npub1source:task',
      parentCommentId: null,
      anchorLineNumber: null,
      commentStatus: 'open' as const,
      body: 'Please review the latest change and confirm next steps.',
      attachments: [],
      senderNpub: 'npub1reviewer',
      recordState: 'active',
    };
    const botIdentity = {
      botNpub: agent.botNpub,
      botPubkeyHex: botPubkeyHex(agent),
      botSecret: new Uint8Array(32),
    };

    await runtime.handleTaskCommentDispatch({
      subscription,
      agent,
      recordId: 'record-comment-1',
      comment,
      botIdentity,
    });

    await runtime.handleTaskCommentDispatch({
      subscription,
      agent,
      recordId: 'record-comment-1',
      comment,
      botIdentity,
    });

    expect(prompts).toHaveLength(1);
    expect(dispatches).toEqual([liveSession.id]);
  });

  test('does not enqueue duplicate task update advisories while the same prompt is already queued', async () => {
    const bindingStore = new AgentWorkSessionBindingStore(makeTempDb());
    const sessions = new Map<string, SessionSnapshot>();
    const prompts: Array<{ sessionId: string; content: string }> = [];
    const dispatches: string[] = [];

    const runtime = new AgentWorkSessionRuntime({
      defaultAgent: 'codex',
      bindingStore,
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      createSession: async (_agent, workingDirectory, name, _origin, explicitNpub, metadata) => {
        const session = makeSession('session-1', {
          AGENT: true,
          billingMode: 'subscription',
          ...metadata,
        });
        session.name = name;
        session.workingDirectory = workingDirectory;
        session.npub = explicitNpub;
        sessions.set(session.id, session);
        return session;
      },
      updateSessionMetadata: (sessionId, metadata) => {
        const existing = sessions.get(sessionId)!;
        const next = { ...existing, metadata: { ...existing.metadata, ...(metadata ?? {}) } };
        sessions.set(sessionId, next);
        return next;
      },
      addPrompt: (sessionId, content) => {
        prompts.push({ sessionId, content });
        return null;
      },
      hasQueuedTaskDispatchPrompt: (sessionId, taskId) =>
        prompts.some(
          (prompt) =>
            prompt.sessionId === sessionId &&
            prompt.content.includes('Agent work dispatch.') &&
            prompt.content.includes(`Task id: ${taskId}`),
        ),
      maybeAutoDispatchQueuedPrompt: (session) => {
        if (session) dispatches.push(session.id);
      },
      enableNightWatch: () => undefined,
    });

    const subscription = makeSubscription();
    const agent = makeAgent();
    const task = {
      taskId: 'task-1',
      flowId: 'flow-a',
      flowRunId: 'run-1',
      flowStep: 'step-1',
      title: 'First task',
      description: 'Initial task',
      state: 'ready',
      assignedTo: agent.botNpub,
      deleted: false,
      done: false,
      predecessorTaskIds: [],
    } as const;

    await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-task-1',
      recordState: null,
      task,
    });

    await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-task-2',
      recordState: null,
      task,
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.content).toContain('Dispatch reason: new task.');
    expect(dispatches).toEqual(['session-1', 'session-1']);
  });

  test('accepts hex pubkey assignments as well as npub assignments', async () => {
    const bindingStore = new AgentWorkSessionBindingStore(makeTempDb());
    const sessions = new Map<string, SessionSnapshot>();
    let createCount = 0;

    const runtime = new AgentWorkSessionRuntime({
      defaultAgent: 'codex',
      bindingStore,
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      createSession: async () => {
        createCount += 1;
        const session = makeSession(`hex-session-${createCount}`);
        sessions.set(session.id, session);
        return session;
      },
      updateSessionMetadata: (sessionId, metadata) => {
        const existing = sessions.get(sessionId)!;
        const next = { ...existing, metadata: { ...existing.metadata, ...(metadata ?? {}) } };
        sessions.set(sessionId, next);
        return next;
      },
      addPrompt: () => undefined,
      maybeAutoDispatchQueuedPrompt: () => undefined,
      enableNightWatch: () => undefined,
    });

    const subscription = makeSubscription();
    const agent = makeAgent();

    const created = await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-hex-1',
      recordState: null,
      task: {
        taskId: 'task-hex-1',
        flowId: null,
        flowRunId: null,
        flowStep: null,
        title: 'Hex assignment task',
        description: 'Assigned using bot pubkey hex',
        state: 'ready',
        assignedTo: botPubkeyHex(agent),
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });

    expect(created?.id).toBe('hex-session-1');
    expect(createCount).toBe(1);
  });

  test('uses explicit repo and artifact paths from the task description to choose the dispatch working directory', async () => {
    const bindingStore = new AgentWorkSessionBindingStore(makeTempDb());
    const sessions = new Map<string, SessionSnapshot>();
    let createdWorkingDirectory: string | null = null;

    const runtime = new AgentWorkSessionRuntime({
      defaultAgent: 'codex',
      bindingStore,
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      createSession: async (_agent, workingDirectory, name, _origin, explicitNpub, metadata) => {
        createdWorkingDirectory = workingDirectory;
        const session = makeSession('repo-aware-session', {
          AGENT: true,
          billingMode: 'subscription',
          ...metadata,
        });
        session.name = name;
        session.workingDirectory = workingDirectory;
        session.npub = explicitNpub;
        sessions.set(session.id, session);
        return session;
      },
      updateSessionMetadata: (sessionId, metadata) => {
        const existing = sessions.get(sessionId)!;
        const next = { ...existing, metadata: { ...existing.metadata, ...(metadata ?? {}) } };
        sessions.set(sessionId, next);
        return next;
      },
      addPrompt: () => undefined,
      maybeAutoDispatchQueuedPrompt: () => undefined,
      enableNightWatch: () => undefined,
    });

    const subscription = makeSubscription();
    const agent = makeAgent();

    await runtime.handleTaskDispatch({
      subscription,
      agent,
      recordId: 'record-repo-aware-1',
      recordState: null,
      task: {
        taskId: 'task-repo-aware-1',
        flowId: 'flow-1',
        flowRunId: 'run-1',
        flowStep: '5',
        scopeId: 'scope-7',
        scopeL1Id: null,
        scopeL2Id: null,
        scopeL3Id: null,
        scopeL4Id: null,
        scopeL5Id: null,
        title: 'Review design handoff',
        description: [
          'Review the design handoff before implementation.',
          'Run contract:',
          'Working directory: /srv/code/wingmen',
          'Primary artifact: /srv/code/wingmen/docs/feature-links.md',
        ].join('\n'),
        state: 'ready',
        assignedTo: agent.botNpub,
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });

    expect(createdWorkingDirectory).toBe('/srv/code/wingmen');
  });

  test('normalises camelCase wrapped task payloads', () => {
    const task = normaliseInboundTaskRecord({
      payload: {
        taskId: 'task-camel-1',
        flowId: 'flow-1',
        flowRunId: 'run-1',
        flowStep: 'step-1',
        name: 'Camel task',
        details: 'Wrapped payload task',
        status: 'OPEN',
        assignedTo: 'npub1bot',
        predecessorTaskIds: [{ taskId: 'pred-1' }, { id: 'pred-2' }],
      },
    });

    expect(task).not.toBeNull();
    expect(task?.taskId).toBe('task-camel-1');
    expect(task?.flowRunId).toBe('run-1');
    expect(task?.title).toBe('Camel task');
    expect(task?.description).toBe('Wrapped payload task');
    expect(task?.state).toBe('open');
    expect(task?.assignedTo).toBe('npub1bot');
    expect(task?.predecessorTaskIds).toEqual(['pred-1', 'pred-2']);
  });

  test('normalises yoke inbound task payloads that use data and assigned_to_npub', () => {
    const task = normaliseInboundTaskRecord({
      record_id: 'task-yoke-1',
      data: {
        title: 'Yoke task',
        description: 'Translator-shaped payload',
        state: 'new',
        assigned_to_npub: 'npub1bot',
        predecessor_task_ids: ['pred-a'],
        flow_id: 'flow-yoke-1',
        flow_run_id: 'run-yoke-1',
        flow_step: 2,
      },
    });

    expect(task).not.toBeNull();
    expect(task?.taskId).toBe('task-yoke-1');
    expect(task?.assignedTo).toBe('npub1bot');
    expect(task?.flowId).toBe('flow-yoke-1');
    expect(task?.flowRunId).toBe('run-yoke-1');
    expect(task?.flowStep).toBe('2');
    expect(task?.predecessorTaskIds).toEqual(['pred-a']);
  });

  test('requires ready state before dispatching assigned tasks', () => {
    const agent = makeAgent();

    expect(evaluateTaskDispatchEligibility({
      task: {
        taskId: 'task-open-1',
        flowId: null,
        flowRunId: null,
        flowStep: null,
        title: 'Open task',
        description: null,
        state: 'open',
        assignedTo: agent.botNpub,
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
      recordState: null,
      agent,
    })).toBe('skip_not_ready');

    expect(evaluateTaskDispatchEligibility({
      task: {
        taskId: 'task-ready-1',
        flowId: null,
        flowRunId: null,
        flowStep: null,
        title: 'Ready task',
        description: null,
        state: 'ready',
        assignedTo: agent.botNpub,
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
      recordState: null,
      agent,
    })).toBe('dispatch');
  });

  test('normalises yoke inbound approval payloads that use data and status', () => {
    const approval = normaliseInboundApprovalRecord({
      record_id: 'approval-yoke-1',
      data: {
        flow_id: 'flow-yoke-1',
        flow_run_id: 'run-yoke-1',
        flow_step: 3,
        status: 'approved',
      },
    });

    expect(approval).not.toBeNull();
    expect(approval?.approvalId).toBe('approval-yoke-1');
    expect(approval?.flowRunId).toBe('run-yoke-1');
    expect(approval?.flowStep).toBe('3');
    expect(approval?.state).toBe('approved');
  });
});
