import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import type { SessionSnapshot } from '../agents/process-manager';
import type { AgentWorkSessionRuntime } from '../agent-work/session-runtime';
import type { AgentCommentSessionRuntime } from './comment-session-runtime';
import type { BotKeyStoreRecord, WorkspaceSubscriptionRecord } from './types';
import { DispatchPipelineRuntime } from './dispatch-pipelines/runtime';
import { DispatchRouteStore } from './dispatch-pipelines/route-store';
import { AgentDefinitionStore } from './agent-definition-store';
import { AgentProfilePolicyStore } from './agent-profile-policy-store';
import { WorkspaceSubscriptionManager } from './subscription-runtime';
import { buildRecordFamilyHash } from './tower-client';
import { WorkspaceSubscriptionStore } from './workspace-subscription-store';
import { PipelineStore, type PipelineRunRecord } from '../pipelines/pipeline-store';

function makeTempDb(name: string): string {
  return join(tmpdir(), `${name}-${randomUUID()}.sqlite`);
}

function makeSubscription(): WorkspaceSubscriptionRecord {
  const now = new Date().toISOString();
  return {
    subscriptionId: 'sub-1',
    workspaceOwnerNpub: 'npub1workspace',
    backendBaseUrl: 'https://tower.example.com',
    botNpub: 'npub1bot',
    sourceAppNpub: 'npub1source',
    onboardingSource: 'nostr_33357',
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
    wrappedGroupKeysJson: JSON.stringify([{ group_npub: 'npub1group' }]),
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

function makeBotKeyRecord(): BotKeyStoreRecord {
  const now = new Date().toISOString();
  return {
    id: 'bot-key-1',
    userNpub: 'npub1manager',
    botPubkeyHex: 'ab'.repeat(32),
    botNpub: 'npub1bot',
    displayName: 'Bot',
    encryptedToUser: 'encrypted-user',
    encryptedEscrow: 'encrypted-escrow',
    escrowUuid: 'escrow-1',
    isActive: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function makeSession(id: string): SessionSnapshot {
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
    workingDirectory: '/tmp/agent-work',
    logs: [],
    metadata: { AGENT: true, billingMode: 'subscription' },
  };
}

function seedRuntime(manager: WorkspaceSubscriptionManager, subscriptionId: string): void {
  const runtimeMap = (manager as unknown as { runtimes: Map<string, unknown> }).runtimes;
  runtimeMap.set(subscriptionId, {
    abortController: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    botIdentity: {
      botNpub: 'npub1bot',
      botPubkeyHex: 'ab'.repeat(32),
      botSecret: new Uint8Array(32),
    },
    wsSession: {
      npub: 'npub1wskey',
      secret: new Uint8Array(32),
    },
    groupKeys: { loaded: true },
    wrappedKeyRows: [{ group_npub: 'npub1group' }],
    removed: false,
  });
}

function makePipelineRun(id: string, input: Record<string, unknown>): PipelineRunRecord {
  const now = new Date().toISOString();
  return {
    id,
    definitionId: 'task-pipeline',
    definitionPath: '/tmp/task-pipeline.json',
    name: 'Task Pipeline',
    status: 'ok',
    ownerNpub: 'npub1manager',
    ownerAlias: 'manager',
    scope: 'user',
    input,
    current: input,
    cursorIndex: 0,
    activeStepId: null,
    result: input,
    error: null,
    startedAt: now,
    completedAt: now,
  };
}

async function waitForRunDefinitions(
  pipelineStore: PipelineStore,
  expectedDefinitionIds: string[],
  timeoutMs = 500,
): Promise<string[]> {
  const expected = [...expectedDefinitionIds].sort();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const definitions = pipelineStore.listRuns().map((run) => run.definitionId).sort();
    if (JSON.stringify(definitions) === JSON.stringify(expected)) {
      return definitions;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return pipelineStore.listRuns().map((run) => run.definitionId).sort();
}

describe('WorkspaceSubscriptionManager agent-work routing', () => {
  test('suppresses legacy dispatch when pipeline routes are required but missing', async () => {
    const runtime = new DispatchPipelineRuntime({
      routeStore: new DispatchRouteStore(makeTempDb('agent-pipeline-required-routes')),
      pipelineStore: new PipelineStore(makeTempDb('agent-pipeline-required-runs')),
      getSessionApiContext: () => null as any,
      callbackOrigin: 'http://localhost:3600',
      requirePipelineRoutes: true,
    });

    const result = await runtime.dispatch({
      subscription: makeSubscription(),
      triggerKind: 'task',
      capability: 'task_dispatch',
      recordId: 'task-without-route',
      record: {},
      payload: { task_id: 'task-without-route', title: 'Task without route' },
      recordFamily: 'task',
      recordState: 'ready',
      recordVersion: 1,
      updaterNpub: 'npub1user',
      bindingType: 'task',
      bindingId: 'task-without-route',
      groupNpubs: ['npub1group'],
    });

    expect(result.handled).toBe(true);
    expect(result.historyEntries[0]?.action).toBe('task_pipeline_route_missing');
    expect(result.historyEntries[0]?.suppressionReason).toBe('pipeline_route_required');
    expect(result.historyEntries[0]?.sourceLabel).toBe('Task without route');

    const documentResult = await runtime.dispatch({
      subscription: makeSubscription(), triggerKind: 'document', capability: 'task_dispatch',
      recordId: 'doc-without-route', record: {}, payload: { title: 'Document without route' },
      recordFamily: 'document', recordState: 'active', recordVersion: 1, updaterNpub: 'npub1user',
      bindingType: 'document', bindingId: 'doc-without-route', groupNpubs: ['npub1group'],
    });
    const chatResult = await runtime.dispatch({
      subscription: makeSubscription(), triggerKind: 'chat', capability: 'chat_intercept',
      recordId: 'message-without-route', record: {},
      payload: { body: 'one two three four five six seven eight nine ten eleven' },
      recordFamily: 'chat', recordState: 'active', recordVersion: 1, updaterNpub: 'npub1user',
      bindingType: 'thread', bindingId: 'thread-without-route', groupNpubs: ['npub1group'],
    });
    expect(documentResult.historyEntries[0]?.sourceLabel).toBe('Document without route');
    expect(chatResult.historyEntries[0]?.sourceLabel).toBe('one two three four five six seven eight nine ten');
  });

  test('acknowledges eligible inbound chat messages before pipeline execution', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('agent-chat-pipeline-routes'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-chat-pipeline-agents'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-chat-pipeline-runs'));
    const subscription = makeSubscription();
    const now = new Date().toISOString();
    agentStore.save({
      agentId: 'agent-chat',
      label: 'Chat Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-chat',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });
    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      pipelineDefinitionId: 'chat-pipeline',
    });
    const runInputs: Record<string, unknown>[] = [];
    const eventOrder: string[] = [];
    const runtime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      defaultAgent: 'codex',
      acknowledgeChatMessage: async (ackInput) => {
        eventOrder.push('acknowledge');
        expect(ackInput.eventInput.recordId).toBe('chat-record-1');
        expect(ackInput.eventInput.triggerKind).toBe('chat');
        return {
          acknowledged: true,
          status: 'ok',
          operation: 'chat.acknowledge-message',
          emoji: 'shaka',
          targetMessageId: ackInput.eventInput.recordId,
        };
      },
      loadDefinition: async () => {
        eventOrder.push('load-definition');
        return {
          id: 'chat-pipeline',
          slug: 'chat-pipeline',
          name: 'Chat Pipeline',
          scope: 'user',
          ownerAlias: 'manager',
          path: '/tmp/chat-pipeline.json',
          spec: { name: 'Chat Pipeline', input: {}, steps: [] },
        };
      },
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        eventOrder.push('run-pipeline');
        runInputs.push(input.input);
        return makePipelineRun('chat-run-1', input.input);
      },
    });

    const result = await runtime.dispatch({
      subscription,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      recordId: 'chat-record-1',
      record: {},
      payload: {
        body: 'Can you see this message?',
        sender_npub: 'npub1sender',
        channel_id: 'channel-1',
        parent_message_id: null,
        attachments: [],
      },
      recordFamily: 'chat',
      recordState: 'active',
      recordVersion: 1,
      updaterNpub: 'npub1sender',
      bindingType: 'thread',
      bindingId: 'thread-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      groupNpubs: ['npub1group'],
    });

    expect(result.handled).toBe(true);
    expect(eventOrder).toEqual(['acknowledge', 'load-definition', 'run-pipeline']);
    expect(runInputs).toHaveLength(1);
    expect((runInputs[0]?.record as any)?.payload?.body).toBe('Can you see this message?');
    expect((runInputs[0]?.chat as any)?.messageText).toBe('Can you see this message?');
    expect((runInputs[0]?.chat as any)?.channelId).toBe('channel-1');
    expect((runInputs[0]?.chat as any)?.threadId).toBe('thread-1');
    expect((runInputs[0]?.agent as any)?.defaultAgent).toBe('codex');
    expect((runInputs[0]?.runtime as any)?.acknowledgement).toMatchObject({
      acknowledged: true,
      status: 'ok',
      operation: 'chat.acknowledge-message',
      emoji: 'shaka',
      targetMessageId: 'chat-record-1',
    });
    expect(result.historyEntries[0]?.details?.chat_acknowledgement).toMatchObject({
      acknowledged: true,
      status: 'ok',
      operation: 'chat.acknowledge-message',
    });
  });

  test('resolves generated built-in dispatch ids to stable latest definitions at runtime', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('agent-chat-built-in-latest-routes'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-chat-built-in-latest-agents'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-chat-built-in-latest-runs'));
    const subscription = makeSubscription();
    const now = new Date().toISOString();
    agentStore.save({
      agentId: 'agent-chat',
      label: 'Chat Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-chat',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });
    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      pipelineDefinitionId: 'shared:7df6cda5438c',
      pipelineVersionPolicy: 'latest',
    });
    const requestedDefinitionIds: string[] = [];
    const runtime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      defaultAgent: 'codex',
      acknowledgeChatMessage: async () => ({ acknowledged: true, status: 'ok' }),
      loadDefinition: async (id) => {
        requestedDefinitionIds.push(id);
        return {
          id: 'shared:current',
          slug: 'fd-agent-dispatch-chat',
          name: 'fd-agent-dispatch-chat',
          scope: 'shared',
          ownerAlias: null,
          path: '/tmp/fd-agent-dispatch-chat.json',
          spec: { name: 'fd-agent-dispatch-chat', input: {}, steps: [] },
        };
      },
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => makePipelineRun('chat-run-1', input.input),
    });

    await runtime.dispatch({
      subscription,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      recordId: 'chat-record-1',
      record: {},
      payload: {
        body: 'Can you see this message?',
        sender_npub: 'npub1sender',
        channel_id: 'channel-1',
        parent_message_id: null,
        attachments: [],
      },
      recordFamily: 'chat',
      recordState: null,
      recordVersion: null,
      updaterNpub: 'npub1sender',
      bindingType: 'thread',
      bindingId: 'thread-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      groupNpubs: ['npub1group'],
    });

    expect(requestedDefinitionIds).toEqual(['fd-agent-dispatch-chat']);
  });

  test('suppresses chat pipeline dispatch for messages authored by the workspace key', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('agent-chat-self-pipeline-routes'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-chat-self-pipeline-agents'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-chat-self-pipeline-runs'));
    const subscription = makeSubscription();
    const now = new Date().toISOString();
    agentStore.save({
      agentId: 'agent-chat',
      label: 'Chat Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-chat',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });
    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      pipelineDefinitionId: 'chat-pipeline',
    });
    const startedInputs: Record<string, unknown>[] = [];
    const runtime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      acknowledgeChatMessage: async () => {
        throw new Error('self-authored messages must not be acknowledged');
      },
      loadDefinition: async () => ({
        id: 'chat-pipeline',
        slug: 'chat-pipeline',
        name: 'Chat Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/chat-pipeline.json',
        spec: { name: 'Chat Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      startPipeline: (input: any) => {
        startedInputs.push(input.input);
        return input.store.createRun({
          definitionId: input.definition.id,
          definitionPath: input.definition.path,
          name: input.definition.spec.name,
          ownerNpub: input.ownerNpub,
          ownerAlias: input.ownerAlias,
          scope: input.definition.scope,
          input: input.input,
        });
      },
    });

    const result = await runtime.dispatch({
      subscription,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      recordId: 'chat-self-1',
      record: {},
      payload: {
        body: 'Bot status update.',
        sender_npub: subscription.wsKeyNpub,
        channel_id: 'channel-1',
        parent_message_id: 'thread-1',
        attachments: [],
      },
      recordFamily: 'chat',
      recordState: 'active',
      recordVersion: 1,
      updaterNpub: 'npub1human',
      bindingType: 'thread',
      bindingId: 'thread-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      groupNpubs: ['npub1group'],
    });

    expect(result.handled).toBe(true);
    expect(result.historyEntries[0]?.status).toBe('suppressed');
    expect(result.historyEntries[0]?.suppressionReason).toBe('self_authored');
    expect(result.historyEntries[0]?.details?.chat_acknowledgement).toBeUndefined();
    expect(startedInputs).toHaveLength(0);
  });

  test('keeps chat pipeline dispatch running when intake acknowledgement fails', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('agent-chat-ack-failure-routes'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-chat-ack-failure-agents'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-chat-ack-failure-runs'));
    const subscription = makeSubscription();
    const now = new Date().toISOString();
    agentStore.save({
      agentId: 'agent-chat',
      label: 'Chat Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-chat',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });
    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      pipelineDefinitionId: 'chat-pipeline',
    });
    const runInputs: Record<string, unknown>[] = [];
    const runtime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      acknowledgeChatMessage: async () => {
        throw new Error('reaction sync failed');
      },
      loadDefinition: async () => ({
        id: 'chat-pipeline',
        slug: 'chat-pipeline',
        name: 'Chat Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/chat-pipeline.json',
        spec: { name: 'Chat Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('chat-run-ack-failure', input.input);
      },
    });

    const result = await runtime.dispatch({
      subscription,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      recordId: 'chat-record-ack-failure',
      record: {},
      payload: {
        body: 'Please handle this.',
        sender_npub: 'npub1sender',
        channel_id: 'channel-1',
        parent_message_id: null,
        attachments: [],
      },
      recordFamily: 'chat',
      recordState: 'active',
      recordVersion: 1,
      updaterNpub: 'npub1sender',
      bindingType: 'thread',
      bindingId: 'thread-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      groupNpubs: ['npub1group'],
    });

    expect(result.handled).toBe(true);
    expect(runInputs).toHaveLength(1);
    expect(result.historyEntries[0]?.action).toBe('chat_pipeline_dispatch');
    expect(result.historyEntries[0]?.details?.chat_acknowledgement).toMatchObject({
      acknowledged: false,
      status: 'failed',
      reason: 'reaction sync failed',
    });
    expect(result.historyEntries[0]?.details?.diagnostic_summary).toContain('Chat acknowledgement failed: reaction sync failed');
  });

  test('starts dispatch pipelines without awaiting full execution by default', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('agent-chat-background-pipeline-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-chat-background-pipeline-runs'));
    const subscription = makeSubscription();
    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      pipelineDefinitionId: 'chat-pipeline',
    });
    const startedInputs: Record<string, unknown>[] = [];
    const runtime = new DispatchPipelineRuntime({
      routeStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'chat-pipeline',
        slug: 'chat-pipeline',
        name: 'Chat Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/chat-pipeline.json',
        spec: { name: 'Chat Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      startPipeline: (input: any) => {
        startedInputs.push(input.input);
        return input.store.createRun({
          definitionId: input.definition.id,
          definitionPath: input.definition.path,
          name: input.definition.spec.name,
          ownerNpub: input.ownerNpub,
          ownerAlias: input.ownerAlias,
          scope: input.definition.scope,
          input: input.input,
        });
      },
    });

    const result = await runtime.dispatch({
      subscription,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      recordId: 'chat-background-1',
      record: {},
      payload: {
        body: 'Do this in the background.',
        sender_npub: 'npub1sender',
        channel_id: 'channel-1',
        parent_message_id: null,
        attachments: [],
      },
      recordFamily: 'chat',
      recordState: 'active',
      recordVersion: 1,
      updaterNpub: 'npub1sender',
      bindingType: 'thread',
      bindingId: 'thread-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      groupNpubs: ['npub1group'],
    });

    expect(result.handled).toBe(true);
    expect(result.historyEntries[0]?.status).toBe('running');
    expect(startedInputs).toHaveLength(1);
    expect((startedInputs[0]?.chat as any)?.messageText).toBe('Do this in the background.');
  });

  test('suppresses duplicate task dispatches inside the route dedupe window', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('agent-work-dedupe-pipeline-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-work-dedupe-pipeline-runs'));
    const subscription = makeSubscription();
    const route = routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'task',
      capability: 'task_dispatch',
      pipelineDefinitionId: 'task-pipeline',
      dedupeWindowSeconds: 300,
    });
    const runtime = new DispatchPipelineRuntime({
      routeStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'task-pipeline',
        slug: 'task-pipeline',
        name: 'Task Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/task-pipeline.json',
        spec: { name: 'Task Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
    });
    const dispatchInput = {
      subscription,
      triggerKind: 'task' as const,
      capability: 'task_dispatch' as const,
      recordId: 'record-task-dedupe-1',
      record: {},
      payload: {
        task_id: 'task-dedupe-1',
        state: 'ready',
        assigned_to: subscription.botNpub,
      },
      recordFamily: 'task',
      recordState: 'active',
      recordVersion: 1,
      updaterNpub: 'npub1user',
      bindingType: 'task' as const,
      bindingId: 'record-task-dedupe-1',
      groupNpubs: ['npub1group'],
    };

    const first = await runtime.dispatch(dispatchInput);
    const second = await runtime.dispatch(dispatchInput);

    expect(first.historyEntries[0]?.action).toBe('task_pipeline_dispatch');
    expect(first.historyEntries[0]?.dedupeKey).toBe([
      subscription.subscriptionId,
      subscription.workspaceOwnerNpub,
      subscription.sourceAppNpub,
      'record-task-dedupe-1',
      1,
      'record-task-dedupe-1',
      route.routeId,
    ].join(':'));
    expect(second.historyEntries[0]?.action).toBe('task_pipeline_suppressed');
    expect(second.historyEntries[0]?.suppressionReason).toBe('dedupe_window');
    expect(second.historyEntries[0]?.dedupeReason).toBe('recent_duplicate');
    expect(second.historyEntries[0]?.pipelineRunId).toBe(first.lastPipelineRunId);
    expect(pipelineStore.listRuns().filter((run) => run.definitionId === route.pipelineDefinitionId)).toHaveLength(1);
  });

  test('allows mirrored task dispatch dedupe identifiers from separate subscriptions', async () => {
    const pipelineStore = new PipelineStore(makeTempDb('agent-work-cross-subscription-dedupe-runs'));
    const primaryRouteStore = new DispatchRouteStore(makeTempDb('agent-work-cross-subscription-primary-routes'));
    const secondaryRouteStore = new DispatchRouteStore(makeTempDb('agent-work-cross-subscription-secondary-routes'));
    const primary = makeSubscription();
    const secondary = {
      ...makeSubscription(),
      subscriptionId: 'sub-2',
      backendBaseUrl: 'https://tower-secondary.example.com',
    };
    const routeInput = {
      routeId: 'mirrored-route',
      managedByNpub: primary.managedByNpub!,
      workspaceOwnerNpub: primary.workspaceOwnerNpub,
      botNpub: primary.botNpub,
      sourceAppNpub: primary.sourceAppNpub,
      triggerKind: 'task' as const,
      capability: 'task_dispatch' as const,
      pipelineDefinitionId: 'task-pipeline',
      dedupeWindowSeconds: 300,
    };
    const primaryRoute = primaryRouteStore.save({
      ...routeInput,
      subscriptionId: primary.subscriptionId,
    });
    const secondaryRoute = secondaryRouteStore.save({
      ...routeInput,
      subscriptionId: secondary.subscriptionId,
    });
    const createRuntime = (routeStore: DispatchRouteStore) => new DispatchPipelineRuntime({
      routeStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'task-pipeline',
        slug: 'task-pipeline',
        name: 'Task Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/task-pipeline.json',
        spec: { name: 'Task Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
    });
    const dispatchInput = {
      triggerKind: 'task' as const,
      capability: 'task_dispatch' as const,
      recordId: 'record-task-mirror-1',
      record: {},
      payload: {
        task_id: 'task-mirror-1',
        state: 'ready',
        assigned_to: primary.botNpub,
      },
      recordFamily: 'task',
      recordState: 'active',
      recordVersion: 7,
      updaterNpub: 'npub1user',
      bindingType: 'task' as const,
      bindingId: 'record-task-mirror-1',
      groupNpubs: ['npub1group'],
    };

    const first = await createRuntime(primaryRouteStore).dispatch({
      ...dispatchInput,
      subscription: primary,
    });
    const second = await createRuntime(secondaryRouteStore).dispatch({
      ...dispatchInput,
      subscription: secondary,
    });

    expect(first.historyEntries[0]?.action).toBe('task_pipeline_dispatch');
    expect(second.historyEntries[0]?.action).toBe('task_pipeline_dispatch');
    expect(first.historyEntries[0]?.dedupeKey).not.toBe(second.historyEntries[0]?.dedupeKey);
    expect(first.historyEntries[0]?.dedupeKey).toBe([
      primary.subscriptionId,
      primary.workspaceOwnerNpub,
      primary.sourceAppNpub,
      'record-task-mirror-1',
      7,
      'record-task-mirror-1',
      primaryRoute.routeId,
    ].join(':'));
    expect(second.historyEntries[0]?.dedupeKey).toBe([
      secondary.subscriptionId,
      secondary.workspaceOwnerNpub,
      secondary.sourceAppNpub,
      'record-task-mirror-1',
      7,
      'record-task-mirror-1',
      secondaryRoute.routeId,
    ].join(':'));
    expect(pipelineStore.listRuns().filter((run) => run.definitionId === 'task-pipeline')).toHaveLength(2);
  });

  test('suppresses concurrent duplicate dispatch admission before the first run is persisted', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('agent-work-inflight-dedupe-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-work-inflight-dedupe-runs'));
    const subscription = makeSubscription();
    const route = routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'task',
      capability: 'task_dispatch',
      pipelineDefinitionId: 'task-pipeline',
      activePolicy: 'queue',
      dedupeWindowSeconds: 300,
    });
    let releaseRun!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let runPipelineCalls = 0;
    const runPipeline = async () => {
      runPipelineCalls += 1;
      await runStarted;
      return {
        id: 'run-inflight-1',
        definitionId: 'task-pipeline',
        definitionPath: '/tmp/task-pipeline.json',
        name: 'Task Pipeline',
        status: 'ok',
        ownerNpub: subscription.managedByNpub,
        ownerAlias: 'manager',
        scope: 'user',
        input: {},
        current: {},
        cursorIndex: 0,
        activeStepId: null,
        result: {},
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    };
    const runtime = new DispatchPipelineRuntime({
      routeStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      runPipeline: runPipeline as never,
      loadDefinition: async () => ({
        id: 'task-pipeline',
        slug: 'task-pipeline',
        name: 'Task Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/task-pipeline.json',
        spec: { name: 'Task Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
    });
    const dispatchInput = {
      subscription,
      triggerKind: 'task' as const,
      capability: 'task_dispatch' as const,
      recordId: 'record-task-race-1',
      record: {},
      payload: {
        task_id: 'task-race-1',
        state: 'ready',
        assigned_to: subscription.botNpub,
      },
      recordFamily: 'task',
      recordState: 'active',
      recordVersion: 1,
      updaterNpub: 'npub1user',
      bindingType: 'task' as const,
      bindingId: 'record-task-race-1',
      groupNpubs: ['npub1group'],
    };

    const firstPromise = runtime.dispatch(dispatchInput);
    await Promise.resolve();
    const second = await runtime.dispatch(dispatchInput);
    releaseRun();
    const first = await firstPromise;

    expect(first.historyEntries[0]?.action).toBe('task_pipeline_dispatch');
    expect(second.historyEntries[0]?.action).toBe('task_pipeline_suppressed');
    expect(second.historyEntries[0]?.suppressionReason).toBe('dedupe_in_flight');
    expect(second.historyEntries[0]?.dedupeReason).toBe('in_flight_duplicate');
    expect(second.historyEntries[0]?.dedupeKey).toBe(first.historyEntries[0]?.dedupeKey);
    expect(runPipelineCalls).toBe(1);
    expect(route.activePolicy).toBe('queue');
  });

  test('starts a chat mention pipeline from profile runtime selection without a route row', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('agent-profile-policy-chat-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-profile-policy-chat-runs'));
    const subscription = makeSubscription();
    const runInputs: Record<string, unknown>[] = [];
    const runtime = new DispatchPipelineRuntime({
      routeStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      acknowledgeChatMessage: async () => ({
        acknowledged: true,
        status: 'ok',
        operation: 'chat.acknowledge-message',
      }),
      loadDefinition: async (definitionId) => ({
        id: definitionId,
        slug: definitionId,
        name: 'Profile Chat Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: `/tmp/${definitionId}.json`,
        spec: { name: 'Profile Chat Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('profile-chat-run-1', input.input);
      },
    });

    const result = await runtime.dispatch({
      subscription,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      recordId: 'chat-profile-1',
      record: {},
      payload: {
        record_id: 'chat-profile-1',
        body: '@agent can you inspect this?',
        channel_id: 'channel-profile',
        thread_id: 'thread-profile',
        sender_npub: 'npub1human',
      },
      recordFamily: 'chat',
      recordState: 'active',
      recordVersion: 1,
      updaterNpub: 'npub1human',
      bindingType: 'thread',
      bindingId: 'thread-profile',
      scopeId: 'scope-profile',
      channelId: 'channel-profile',
      threadId: 'thread-profile',
      groupNpubs: ['npub1group'],
      profileRuntime: {
        profileWorkspaceId: 'profile-workspace-1',
        eventType: 'chat_mention',
        enabled: true,
        defaultAction: 'respond',
        quietMode: false,
        pipeline: {
          pipelineDefinitionId: 'profile-chat-pipeline',
          pipelineVersionPolicy: 'latest',
          source: 'event_policy',
        },
        appendedContext: [
          {
            kind: 'workspace',
            targetId: null,
            eventType: null,
            contextText: 'Workspace chat context',
          },
        ],
      },
    });

    expect(routeStore.listForSubscription(subscription.subscriptionId)).toHaveLength(0);
    expect(result.handled).toBe(true);
    expect(runInputs).toHaveLength(1);
    expect((runInputs[0]?.dispatch as any)?.routeId).toContain('profile-policy');
    expect((runInputs[0]?.routing as any)?.scopeId).toBe('scope-profile');
    expect((runInputs[0]?.chat as any)?.threadId).toBe('thread-profile');
    expect((runInputs[0]?.profileRuntime as any)?.eventType).toBe('chat_mention');
    expect((runInputs[0]?.profileRuntime as any)?.appendedContext[0].contextText).toBe('Workspace chat context');
  });

  test('starts document invocation pipeline with document trigger kind', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('profile-document-invocation-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('profile-document-invocation-runs'));
    const subscription = makeSubscription();
    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'task',
      capability: 'task_dispatch',
      pipelineDefinitionId: 'fd-agent-dispatch-task-response',
    });
    const runInputs: Record<string, unknown>[] = [];
    const runDefinitionIds: string[] = [];
    const runtime = new DispatchPipelineRuntime({
      routeStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async (definitionId) => ({
        id: definitionId,
        slug: definitionId,
        name: definitionId,
        scope: 'shared',
        ownerAlias: 'shared',
        path: `/tmp/${definitionId}.json`,
        spec: { name: definitionId, input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        runDefinitionIds.push(input.definition.id);
        return {
          ...makePipelineRun('profile-document-invocation-run-1', input.input),
          definitionId: input.definition.id,
        };
      },
    });

    const result = await runtime.dispatch({
      subscription,
      triggerKind: 'document',
      capability: 'task_dispatch',
      recordId: 'invocation-1',
      record: {},
      payload: {
        invocation_id: 'invocation-1',
        prompt: 'clean up this document',
        target_type: 'document',
        target_id: 'doc-1',
        title: 'Document title',
        state: 'invoked',
      },
      recordFamily: 'invocation',
      recordState: 'active',
      recordVersion: 1,
      updaterNpub: 'npub1human',
      bindingType: 'document',
      bindingId: 'doc-1',
      scopeId: 'scope-1',
      channelId: 'channel-1',
      threadId: null,
      changedFields: ['invocation'],
      groupNpubs: ['npub1group'],
      profileRuntime: {
        profileWorkspaceId: 'profile-workspace-1',
        eventType: 'document_invocation',
        enabled: true,
        defaultAction: 'work',
        quietMode: false,
        pipeline: {
          pipelineDefinitionId: 'fd-document-invocation',
          pipelineVersionPolicy: 'latest',
          source: 'built_in_default',
        },
        appendedContext: [],
      },
    });

    expect(result.handled).toBe(true);
    expect(result.historyEntries[0]?.sourceLabel).toBe('Document title');
    expect(runDefinitionIds).toEqual(['fd-document-invocation']);
    expect((runInputs[0]?.dispatch as any)?.routeId).toContain('profile-policy');
    expect((runInputs[0]?.dispatch as any)?.triggerKind).toBe('document');
    expect((runInputs[0]?.profileRuntime as any)?.eventType).toBe('document_invocation');
    expect((runInputs[0]?.routing as any)?.bindingType).toBe('document');
    expect((runInputs[0]?.record as any)?.payload.task_id).toBeUndefined();
  });

  test('adds Flight Deck channel context to chat pipeline input', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('flightdeck-channel-context-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('flightdeck-channel-context-runs'));
    const subscription = {
      ...makeSubscription(),
      workspaceId: 'workspace-pg-1',
    };
    const route = routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      pipelineDefinitionId: 'chat-pipeline',
    });
    const runInputs: Record<string, unknown>[] = [];
    const runtime = new DispatchPipelineRuntime({
      routeStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      acknowledgeChatMessage: async () => ({
        acknowledged: true,
        status: 'ok',
        operation: 'chat.acknowledge-message',
      }),
      resolveFlightDeckChannelContext: async () => ({
        id: 'channel-features',
        scopeId: 'scope-flightdeck',
        name: 'Flight Deck Features',
        contextPrompt: 'This is the features channel.',
        hasSpecificContext: true,
      }),
      loadDefinition: async () => ({
        id: route.pipelineDefinitionId,
        slug: route.pipelineDefinitionId,
        name: 'Chat Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/chat-pipeline.json',
        spec: { name: 'Chat Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('pipeline-run-channel-context', input.input);
      },
    });

    const result = await runtime.dispatch({
      subscription,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      recordId: 'chat-channel-context-1',
      record: {},
      payload: {
        body: '@agent please review this',
        channel_id: 'channel-features',
        thread_id: 'thread-features',
        sender_npub: 'npub1human',
      },
      recordFamily: 'chat',
      recordState: 'active',
      recordVersion: 1,
      updaterNpub: 'npub1human',
      bindingType: 'thread',
      bindingId: 'thread-features',
      scopeId: 'scope-flightdeck',
      channelId: 'channel-features',
      threadId: 'thread-features',
      botIdentity: {
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      },
    });

    expect(result.handled).toBe(true);
    expect(result.historyEntries[0]?.status).toBe('ok');
    expect(runInputs).toHaveLength(1);
    expect((runInputs[0]?.flightDeckContext as any)?.channel).toEqual({
      id: 'channel-features',
      scopeId: 'scope-flightdeck',
      name: 'Flight Deck Features',
      contextPrompt: 'This is the features channel.',
      hasSpecificContext: true,
    });
  });

  test('fails Flight Deck dispatch when channel context cannot be resolved', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('flightdeck-channel-context-failed-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('flightdeck-channel-context-failed-runs'));
    const subscription = {
      ...makeSubscription(),
      workspaceId: 'workspace-pg-1',
    };
    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'task',
      capability: 'task_dispatch',
      pipelineDefinitionId: 'task-pipeline',
    });
    let runPipelineCalls = 0;
    const runtime = new DispatchPipelineRuntime({
      routeStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      resolveFlightDeckChannelContext: async () => {
        throw new Error('Flight Deck channel not found in Tower: channel-missing');
      },
      loadDefinition: async () => ({
        id: 'task-pipeline',
        slug: 'task-pipeline',
        name: 'Task Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/task-pipeline.json',
        spec: { name: 'Task Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runPipelineCalls += 1;
        return makePipelineRun('pipeline-run-should-not-start', input.input);
      },
    });

    const result = await runtime.dispatch({
      subscription,
      triggerKind: 'task',
      capability: 'task_dispatch',
      recordId: 'task-channel-context-1',
      record: {},
      payload: {
        task_id: 'task-channel-context-1',
        title: 'Check channel context failure',
        channel_id: 'channel-missing',
      },
      recordFamily: 'task',
      recordState: 'active',
      recordVersion: 1,
      updaterNpub: 'npub1human',
      bindingType: 'task',
      bindingId: 'task-channel-context-1',
      scopeId: 'scope-flightdeck',
      channelId: 'channel-missing',
      botIdentity: {
        botNpub: 'npub1bot',
        botPubkeyHex: 'ab'.repeat(32),
        botSecret: new Uint8Array(32),
      },
    });

    expect(result.handled).toBe(true);
    expect(result.lastPipelineRunId).toBeNull();
    expect(runPipelineCalls).toBe(0);
    expect(result.historyEntries[0]?.status).toBe('failed');
    expect(result.historyEntries[0]?.details?.diagnostic_summary).toContain('Flight Deck channel context could not be resolved');
    expect(result.historyEntries[0]?.details?.diagnostic_summary).toContain('channel-missing');
  });

  test('starts profile policy task pipeline with saved runtime context and no route row', async () => {
    const dbPath = makeTempDb('agent-profile-policy-task-runtime');
    const store = new WorkspaceSubscriptionStore(dbPath);
    const agentStore = new AgentDefinitionStore(dbPath);
    const profilePolicyStore = new AgentProfilePolicyStore(dbPath);
    const routeStore = new DispatchRouteStore(makeTempDb('agent-profile-policy-task-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-profile-policy-task-runs'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();
    agentStore.save({
      agentId: 'agent-task-profile',
      label: 'Task Profile Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-task-profile',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });
    const runInputs: Record<string, unknown>[] = [];
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async (definitionId) => ({
        id: definitionId,
        slug: definitionId,
        name: 'Profile Policy Task Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: `/tmp/${definitionId}.json`,
        spec: { name: 'Profile Policy Task Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('profile-policy-task-run-1', input.input);
      },
    });
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      profilePolicyStore,
      dispatchPipelineRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-profile-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1user',
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-profile-1',
        title: 'Use profile policy',
        state: 'ready',
        assigned_to: subscription.botNpub,
        scope_id: 'scope-autopilot',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => null,
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });
    seedRuntime(manager, subscription.subscriptionId);
    manager.saveProfileWorkspaceForManager({
      subscriptionId: subscription.subscriptionId,
      managedByNpub: subscription.managedByNpub!,
      profilePromptContext: 'Profile runtime context',
      workspaceDefaultPipelineDefinitionId: 'profile-task-pipeline',
      workspaceContext: 'Workspace runtime context',
      policies: [
        {
          eventType: 'task_assigned',
          enabled: true,
          defaultAction: 'work',
          pipelineDefinitionId: 'policy-task-pipeline',
          promptContext: 'Policy prompt context',
          quietMode: false,
        },
      ],
      appendedContexts: [
        {
          contextKind: 'scope',
          targetId: 'scope-autopilot',
          contextText: 'Scope runtime context',
        },
      ],
    });

    const result = await (manager as unknown as {
      handleTaskRecordChanged: (
        record: WorkspaceSubscriptionRecord,
        payload: Record<string, unknown>,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleTaskRecordChanged(subscription, { record_id: 'record-task-profile-1' });

    expect(routeStore.listForSubscription(subscription.subscriptionId)).toHaveLength(0);
    expect(runInputs).toHaveLength(1);
    expect((runInputs[0]?.dispatch as any)?.routeId).toContain('profile-policy');
    expect((runInputs[0]?.profileRuntime as any)?.eventType).toBe('task_assigned');
    expect((runInputs[0]?.profileRuntime as any)?.pipeline).toEqual({
      pipelineDefinitionId: 'policy-task-pipeline',
      pipelineVersionPolicy: 'latest',
      source: 'event_policy',
    });
    expect((runInputs[0]?.profileRuntime as any)?.appendedContext.map((entry: any) => entry.contextText)).toEqual([
      'Profile runtime context',
      'Workspace runtime context',
      'Scope runtime context',
      'Policy prompt context',
    ]);
    expect(result.recentDispatches[0]?.action).toBe('task_pipeline_dispatch');
  });

  test('suppresses profile policy task dispatch when the policy is quiet observe', async () => {
    const dbPath = makeTempDb('agent-profile-policy-task-suppress');
    const store = new WorkspaceSubscriptionStore(dbPath);
    const agentStore = new AgentDefinitionStore(dbPath);
    const profilePolicyStore = new AgentProfilePolicyStore(dbPath);
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore: new DispatchRouteStore(makeTempDb('agent-profile-policy-task-suppress-routes')),
      agentStore,
      pipelineStore: new PipelineStore(makeTempDb('agent-profile-policy-task-suppress-runs')),
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      runPipeline: async () => {
        throw new Error('quiet policy should not start a pipeline');
      },
    });
    const subscription = store.save(makeSubscription());
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      profilePolicyStore,
      dispatchPipelineRuntime,
      fetchRecordHistory: async () => [{ record_id: 'record-task-quiet-1', record_state: 'active', version: 1, signature_npub: 'npub1user' }],
      decryptRecordPayload: async () => ({
        task_id: 'task-quiet-1',
        title: 'Quiet task',
        state: 'ready',
        assigned_to: subscription.botNpub,
      }),
      botKeyStore: {
        getActiveKeyForUser: () => null,
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });
    seedRuntime(manager, subscription.subscriptionId);
    manager.saveProfileWorkspaceForManager({
      subscriptionId: subscription.subscriptionId,
      managedByNpub: subscription.managedByNpub!,
      policies: [
        {
          eventType: 'task_assigned',
          enabled: true,
          defaultAction: 'observe',
          quietMode: true,
        },
      ],
    });

    const result = await (manager as unknown as {
      handleTaskRecordChanged: (
        record: WorkspaceSubscriptionRecord,
        payload: Record<string, unknown>,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleTaskRecordChanged(subscription, { record_id: 'record-task-quiet-1' });

    expect(result.recentDispatches[0]).toMatchObject({
      action: 'task_assigned_profile_policy_suppressed',
      suppressionReason: 'quiet',
    });
    expect(result.recentDispatches[0]?.details).toMatchObject({
      default_action: 'observe',
      quiet_mode: true,
    });
  });

  test('suppresses duplicate route dispatches after a pipeline definition rename', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('agent-route-rename-dedupe-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-route-rename-dedupe-runs'));
    const subscription = makeSubscription();
    const route = routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      pipelineDefinitionId: 'renamed-chat-pipeline',
      activePolicy: 'queue',
    });
    const dedupeKey = [
      subscription.subscriptionId,
      subscription.workspaceOwnerNpub,
      subscription.sourceAppNpub,
      'chat-record-rename-1',
      2,
      'thread-rename-1',
      route.routeId,
    ].join(':');
    const concurrencyKey = `${subscription.subscriptionId}:thread-rename-1:${route.routeId}`;
    const previousRun = pipelineStore.createRun({
      definitionId: 'old-chat-pipeline',
      definitionPath: '/tmp/old-chat-pipeline.json',
      name: 'Old Chat Pipeline',
      ownerNpub: subscription.managedByNpub,
      ownerAlias: 'manager',
      scope: 'user',
      input: {
        dispatch: {
          routeId: route.routeId,
          dedupeKey,
          concurrencyKey,
        },
      },
    });
    pipelineStore.completeRun(
      previousRun.id,
      'error',
      {},
      'previous route run failed after creating a side effect',
    );
    const runtime = new DispatchPipelineRuntime({
      routeStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => {
        throw new Error('duplicate dispatch should not load a definition');
      },
    });

    const result = await runtime.dispatch({
      subscription,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      recordId: 'chat-record-rename-1',
      record: {},
      payload: { body: 'Please create work', channel_id: 'channel-rename-1' },
      recordFamily: 'chat',
      recordState: 'active',
      recordVersion: 2,
      updaterNpub: 'npub1user',
      bindingType: 'thread',
      bindingId: 'thread-rename-1',
      channelId: 'channel-rename-1',
      threadId: 'thread-rename-1',
      groupNpubs: ['npub1group'],
    });

    expect(result.historyEntries[0]?.action).toBe('chat_pipeline_suppressed');
    expect(result.historyEntries[0]?.suppressionReason).toBe('dedupe_window');
    expect(result.historyEntries[0]?.pipelineRunId).toBe(previousRun.id);
  });

  test('suppresses task dispatch when active policy skip has a running route instance', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('agent-work-active-policy-pipeline-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-work-active-policy-pipeline-runs'));
    const subscription = makeSubscription();
    const route = routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'task',
      capability: 'task_dispatch',
      pipelineDefinitionId: 'task-pipeline',
      activePolicy: 'skip',
    });
    const concurrencyKey = `${subscription.subscriptionId}:record-task-active-1:${route.routeId}`;
    const activeRun = pipelineStore.createRun({
      definitionId: route.pipelineDefinitionId,
      definitionPath: '/tmp/task-pipeline.json',
      name: 'Task Pipeline',
      ownerNpub: subscription.managedByNpub,
      ownerAlias: 'manager',
      scope: 'user',
      input: {
        dispatch: {
          routeId: route.routeId,
          concurrencyKey,
        },
      },
    });
    const runtime = new DispatchPipelineRuntime({
      routeStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => {
        throw new Error('active duplicate should not load a definition');
      },
    });

    const result = await runtime.dispatch({
      subscription,
      triggerKind: 'task',
      capability: 'task_dispatch',
      recordId: 'record-task-active-1',
      record: {},
      payload: {
        task_id: 'task-active-1',
        state: 'ready',
        assigned_to: subscription.botNpub,
      },
      recordFamily: 'task',
      recordState: 'active',
      recordVersion: 2,
      updaterNpub: 'npub1user',
      bindingType: 'task',
      bindingId: 'record-task-active-1',
      groupNpubs: ['npub1group'],
    });

    expect(result.historyEntries[0]?.action).toBe('task_pipeline_suppressed');
    expect(result.historyEntries[0]?.suppressionReason).toBe('active_run');
    expect(result.historyEntries[0]?.dedupeReason).toBe('active_policy_skip');
    expect(result.historyEntries[0]?.pipelineRunId).toBe(activeRun.id);
    expect(pipelineStore.listRuns().filter((run) => run.definitionId === route.pipelineDefinitionId)).toHaveLength(1);
  });

  test('starts configured task dispatch pipeline and records run history', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-pipeline-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-pipeline-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-work-pipeline-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-work-pipeline-runs'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const route = routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'task',
      capability: 'task_dispatch',
      pipelineDefinitionId: 'task-pipeline',
      matchJson: { assignedTo: 'bot' },
    });
    const runInputs: Record<string, unknown>[] = [];
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'task-pipeline',
        slug: 'task-pipeline',
        name: 'Task Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/task-pipeline.json',
        spec: { name: 'Task Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('pipeline-run-1', input.input);
      },
    });

    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('legacy task dispatch should not run when a pipeline route matches');
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-pipeline-1',
          record_state: 'active',
          version: 3,
          signature_npub: 'npub1user',
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-pipeline-1',
        title: 'Pipeline task',
        state: 'ready',
        assigned_to: 'npub1bot',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-pipeline-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-pipeline-1',
      }),
    );

    expect(runInputs).toHaveLength(1);
    expect((runInputs[0]?.dispatch as any)?.routeId).toBe(route.routeId);
    expect((runInputs[0]?.record as any)?.recordId).toBe('record-task-pipeline-1');
    expect(next.lastPipelineRunId).toBe('pipeline-run-1');
    expect(next.recentDispatches[0]?.routeId).toBe(route.routeId);
    expect(next.recentDispatches[0]?.pipelineRunId).toBe('pipeline-run-1');
    expect(next.recentDispatches[0]?.action).toBe('task_pipeline_dispatch');
  });

  test('task dispatch pipeline routes wait until a bot-assigned task is ready', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-pipeline-not-ready-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-pipeline-not-ready-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-work-pipeline-not-ready-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-work-pipeline-not-ready-runs'));
    const subscription = store.save(makeSubscription());

    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'task',
      capability: 'task_dispatch',
      pipelineDefinitionId: 'task-pipeline',
    });
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      runPipeline: async () => {
        throw new Error('pipeline route should not run until task is ready');
      },
    });

    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('legacy task dispatch should not run until task is ready');
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-pipeline-not-ready-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1user',
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-pipeline-not-ready-1',
        title: 'Pipeline task not ready',
        state: 'in_progress',
        assigned_to: subscription.botNpub,
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-pipeline-not-ready-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-pipeline-not-ready-1',
      }),
    );

    expect(next.recentDispatches[0]?.kind).toBe('task');
    expect(next.recentDispatches[0]?.action).toBe('skip_not_ready');
    expect(next.lastPipelineRunId).toBeNull();
  });

  test('task dispatch pipelines can start a longer child pipeline', async () => {
    const routeStore = new DispatchRouteStore(makeTempDb('agent-work-child-pipeline-routes'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-child-pipeline-agents'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-work-child-pipeline-runs'));
    const subscription = makeSubscription();
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });
    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'task',
      capability: 'task_dispatch',
      pipelineDefinitionId: 'parent-pipeline',
    });
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async (id) => id === 'parent-pipeline'
        ? {
            id: 'parent-pipeline',
            slug: 'parent-pipeline',
            name: 'Parent Pipeline',
            scope: 'user',
            ownerAlias: 'manager',
            path: '/tmp/parent-pipeline.json',
            spec: {
              name: 'Parent Pipeline',
              input: {},
              steps: [
                {
                  name: 'start-child',
                  type: 'code',
                  function: 'dispatch.startChildPipeline',
                  input: {
                    value: {
                      pipelineDefinitionId: 'child-pipeline',
                      workPlan: { childPipelineDefinitionId: 'child-pipeline', taskSummary: 'Do the child work' },
                      childInput: { source: 'parent' },
                    },
                  },
                  assign: '$.childPipeline',
                },
              ],
            },
          }
        : id === 'child-pipeline'
          ? {
              id: 'child-pipeline',
              slug: 'child-pipeline',
              name: 'Child Pipeline',
              scope: 'user',
              ownerAlias: 'manager',
              path: '/tmp/child-pipeline.json',
              spec: {
                name: 'Child Pipeline',
                input: {},
                steps: [{ name: 'finish', type: 'code', function: 'test.finish' }],
              },
            }
          : null,
      loadFunctions: async () => ({
        records: [],
        registry: {
          async 'test.finish'(input) {
            return { ...input, completed: true };
          },
        },
      }),
    });

    const result = await dispatchPipelineRuntime.dispatch({
      subscription,
      triggerKind: 'task',
      capability: 'task_dispatch',
      recordId: 'task-1',
      record: {},
      payload: { task_id: 'task-1', state: 'ready', assigned_to: subscription.botNpub },
      recordFamily: 'task',
      recordState: 'ready',
      recordVersion: 1,
      updaterNpub: 'npub1user',
      bindingType: 'task',
      bindingId: 'task-1',
      groupNpubs: ['npub1group'],
    });

    expect(result.handled).toBe(true);
    const definitions = await waitForRunDefinitions(pipelineStore, ['child-pipeline', 'parent-pipeline']);
    expect(definitions).toEqual(['child-pipeline', 'parent-pipeline']);
    const runs = pipelineStore.listRuns();
    expect(runs.find((run) => run.definitionId === 'child-pipeline')?.input.workPlan).toMatchObject({
      taskSummary: 'Do the child work',
    });
  });

  test('suppresses legacy dispatch when a configured task route is disabled', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-disabled-pipeline-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-disabled-pipeline-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-work-disabled-pipeline-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-work-disabled-pipeline-runs'));
    const subscription = store.save(makeSubscription());

    const route = routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'task',
      capability: 'task_dispatch',
      pipelineDefinitionId: 'task-pipeline',
      enabled: false,
    });
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      runPipeline: async () => {
        throw new Error('disabled route should not start a pipeline');
      },
    });
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('legacy task dispatch should not run when a route is disabled');
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [{ record_id: 'record-task-disabled-1', record_state: 'active', version: 1, signature_npub: 'npub1user' }],
      decryptRecordPayload: async () => ({
        task_id: 'task-disabled-1',
        title: 'Disabled task',
        state: 'ready',
        assigned_to: 'npub1bot',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-disabled-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-disabled-1',
      }),
    );

    expect(next.recentDispatches[0]?.routeId).toBe(route.routeId);
    expect(next.recentDispatches[0]?.status).toBe('suppressed');
    expect(next.recentDispatches[0]?.suppressionReason).toBe('route_disabled');
  });

  test('starts configured comment dispatch pipeline before the disabled comment stub', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-pipeline-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-pipeline-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-comment-pipeline-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-comment-pipeline-runs'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-comment',
      label: 'Comment Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-comment',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const route = routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'comment',
      capability: 'comment_dispatch',
      pipelineDefinitionId: 'comment-pipeline',
    });
    const runInputs: Record<string, unknown>[] = [];
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'comment-pipeline',
        slug: 'comment-pipeline',
        name: 'Comment Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/comment-pipeline.json',
        spec: { name: 'Comment Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('comment-pipeline-run-1', input.input);
      },
    });
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      commentDispatchRuntime: {
        handleDisabledDispatch: () => {
          throw new Error('disabled comment stub should not run when a pipeline route matches');
        },
      } as never,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-comment-pipeline-1',
          record_state: 'active',
          version: 2,
          group_npubs: ['npub1group'],
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-pipeline-1',
        target_record_id: 'task-pipeline-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:task`,
        sender_npub: 'npub1reviewer',
        body: `@[Comment Agent](mention:person:${subscription.botNpub}) can you clarify the current blocker?`,
        comment_status: 'open',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-comment-pipeline-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-comment-pipeline-1',
      }),
    );

    expect(runInputs).toHaveLength(1);
    expect((runInputs[0]?.dispatch as any)?.routeId).toBe(route.routeId);
    expect((runInputs[0]?.record as any)?.recordId).toBe('record-comment-pipeline-1');
    expect((runInputs[0]?.record as any)?.payload?.commentId).toBe('comment-pipeline-1');
    expect(next.lastPipelineRunId).toBe('comment-pipeline-run-1');
    expect(next.recentDispatches[0]?.routeId).toBe(route.routeId);
    expect(next.recentDispatches[0]?.action).toBe('comment_pipeline_dispatch');
  });

  test('skips task comments without an explicit agent mention before configured comment pipelines', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-pipeline-task-no-mention-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-pipeline-task-no-mention-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-comment-pipeline-task-no-mention-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-comment-pipeline-task-no-mention-runs'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-comment',
      label: 'Comment Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-comment',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });
    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'comment',
      capability: 'comment_dispatch',
      pipelineDefinitionId: 'comment-pipeline',
      enabled: true,
    });
    const runInputs: Record<string, unknown>[] = [];
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'comment-pipeline',
        slug: 'comment-pipeline',
        name: 'Comment Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/comment-pipeline.json',
        spec: { name: 'Comment Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('comment-pipeline-run-1', input.input);
      },
    });
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-comment-no-mention-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1humanwriter',
          group_npubs: ['npub1group'],
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-task-no-mention-1',
        target_record_id: 'task-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:task`,
        sender_npub: 'npub1humanwriter',
        body: 'Leaving a handoff note for the task.',
        comment_status: 'open',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-comment-no-mention-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-task-comment-no-mention-1',
      }),
    );

    expect(runInputs).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('task_comment_skip_no_agent_mention');
    expect(next.recentDispatches[0]?.bindingId).toBe('task-1');
    expect(next.recentDispatches[0]?.bindingType).toBe('task');
  });

  test('starts configured comment pipeline for manager-authored task comments without an agent mention', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-pipeline-task-manager-no-mention-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-pipeline-task-manager-no-mention-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-comment-pipeline-task-manager-no-mention-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-comment-pipeline-task-manager-no-mention-runs'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-comment',
      label: 'Comment Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-comment',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });
    const route = routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'comment',
      capability: 'comment_dispatch',
      pipelineDefinitionId: 'comment-pipeline',
      enabled: true,
    });
    const runInputs: Record<string, unknown>[] = [];
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'comment-pipeline',
        slug: 'comment-pipeline',
        name: 'Comment Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/comment-pipeline.json',
        spec: { name: 'Comment Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('comment-pipeline-run-1', input.input);
      },
    });
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-comment-manager-1',
          record_state: 'active',
          version: 1,
          signature_npub: subscription.managedByNpub,
          group_npubs: ['npub1group'],
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-task-manager-1',
        target_record_id: 'task-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:task`,
        sender_npub: subscription.managedByNpub,
        body: 'Please pick up this review note.',
        comment_status: 'open',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-comment-manager-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-task-comment-manager-1',
      }),
    );

    expect(runInputs).toHaveLength(1);
    expect((runInputs[0]?.dispatch as any)?.routeId).toBe(route.routeId);
    expect((runInputs[0]?.record as any)?.payload?.commentId).toBe('comment-task-manager-1');
    expect(next.recentDispatches[0]?.action).toBe('comment_pipeline_dispatch');
  });

  test('skips workspace-key-authored comments before configured comment pipelines', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-pipeline-self-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-pipeline-self-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-comment-pipeline-self-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-comment-pipeline-self-runs'));
    const subscription = store.save(makeSubscription());

    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'comment',
      capability: 'comment_dispatch',
      pipelineDefinitionId: 'comment-pipeline',
    });
    const runInputs: Record<string, unknown>[] = [];
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'comment-pipeline',
        slug: 'comment-pipeline',
        name: 'Comment Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/comment-pipeline.json',
        spec: { name: 'Comment Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('comment-pipeline-run-1', input.input);
      },
    });
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-comment-pipeline-self-1',
          record_state: 'active',
          version: 1,
          signature_npub: subscription.wsKeyNpub,
          group_npubs: ['npub1group'],
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-pipeline-self-1',
        target_record_id: 'task-pipeline-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:task`,
        sender_npub: 'npub1reviewer',
        body: 'Agent-created task comment.',
        comment_status: 'open',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-comment-pipeline-self-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-comment-pipeline-self-1',
      }),
    );

    expect(runInputs).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('task_comment_skip_self_update');
    expect(next.recentDispatches[0]?.details?.is_me).toBe(true);
  });

  test('skips bot-authored comments before configured comment pipelines', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-pipeline-bot-self-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-pipeline-bot-self-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-comment-pipeline-bot-self-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-comment-pipeline-bot-self-runs'));
    const subscription = store.save(makeSubscription());

    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'comment',
      capability: 'comment_dispatch',
      pipelineDefinitionId: 'comment-pipeline',
      enabled: true,
    });
    const runInputs: Record<string, unknown>[] = [];
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'comment-pipeline',
        slug: 'comment-pipeline',
        name: 'Comment Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/comment-pipeline.json',
        spec: { name: 'Comment Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('comment-pipeline-run-1', input.input);
      },
    });
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-comment-pipeline-bot-self-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1humanwriter',
          group_npubs: ['npub1group'],
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-pipeline-bot-self-1',
        target_record_id: 'task-pipeline-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:task`,
        sender_npub: subscription.botNpub,
        body: 'Agent-created task comment.',
        comment_status: 'open',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-comment-pipeline-bot-self-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-comment-pipeline-bot-self-1',
      }),
    );

    expect(runInputs).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('task_comment_skip_self_update');
    expect(next.recentDispatches[0]?.details?.is_me).toBe(true);
  });

  test('skips comments signed by a workspace key mapped to the bot before configured comment pipelines', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-pipeline-mapped-self-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-pipeline-mapped-self-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-comment-pipeline-mapped-self-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-comment-pipeline-mapped-self-runs'));
    const subscription = store.save(makeSubscription());
    const mappedWorkspaceKey = 'mapped-workspace-key';

    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'comment',
      capability: 'comment_dispatch',
      pipelineDefinitionId: 'comment-pipeline',
      enabled: true,
    });
    const runInputs: Record<string, unknown>[] = [];
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'comment-pipeline',
        slug: 'comment-pipeline',
        name: 'Comment Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/comment-pipeline.json',
        spec: { name: 'Comment Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('comment-pipeline-run-1', input.input);
      },
    });
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-comment-pipeline-mapped-self-1',
          record_state: 'active',
          version: 1,
          signature_npub: mappedWorkspaceKey,
          group_npubs: ['npub1group'],
        },
      ],
      fetchWorkspaceKeyMappings: async () => [
        {
          workspace_owner_npub: subscription.workspaceOwnerNpub,
          ws_key_npub: mappedWorkspaceKey,
          user_npub: subscription.botNpub,
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-pipeline-mapped-self-1',
        target_record_id: 'task-pipeline-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:task`,
        sender_npub: mappedWorkspaceKey,
        body: 'Agent-created task comment via a rotated workspace key.',
        comment_status: 'open',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-comment-pipeline-mapped-self-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-comment-pipeline-mapped-self-1',
      }),
    );

    expect(runInputs).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('task_comment_skip_self_update');
    expect(next.recentDispatches[0]?.details?.is_me).toBe(true);
  });

  test('skips document comments without an explicit agent mention before configured comment pipelines', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-pipeline-doc-no-mention-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-pipeline-doc-no-mention-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-comment-pipeline-doc-no-mention-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-comment-pipeline-doc-no-mention-runs'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-comment',
      label: 'Comment Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-comment',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });
    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'comment',
      capability: 'comment_dispatch',
      pipelineDefinitionId: 'comment-pipeline',
      enabled: true,
    });
    const runInputs: Record<string, unknown>[] = [];
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'comment-pipeline',
        slug: 'comment-pipeline',
        name: 'Comment Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/comment-pipeline.json',
        spec: { name: 'Comment Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('comment-pipeline-run-1', input.input);
      },
    });
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-doc-comment-no-mention-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1humanwriter',
          group_npubs: ['npub1group'],
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-doc-no-mention-1',
        target_record_id: 'doc-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:document`,
        sender_npub: 'npub1humanwriter',
        body: 'Leaving a note while I am still working through this section.',
        comment_status: 'open',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-doc-comment-no-mention-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-doc-comment-no-mention-1',
      }),
    );

    expect(runInputs).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('document_comment_skip_no_agent_mention');
    expect(next.recentDispatches[0]?.bindingId).toBe('doc-1');
    expect(next.recentDispatches[0]?.bindingType).toBe('document');
  });

  test('starts configured comment pipeline for manager-authored document comments without an agent mention', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-pipeline-doc-manager-no-mention-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-pipeline-doc-manager-no-mention-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-comment-pipeline-doc-manager-no-mention-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-comment-pipeline-doc-manager-no-mention-runs'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-comment',
      label: 'Comment Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-comment',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });
    const route = routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'comment',
      capability: 'comment_dispatch',
      pipelineDefinitionId: 'comment-pipeline',
      enabled: true,
    });
    const runInputs: Record<string, unknown>[] = [];
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'comment-pipeline',
        slug: 'comment-pipeline',
        name: 'Comment Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/comment-pipeline.json',
        spec: { name: 'Comment Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('comment-pipeline-run-1', input.input);
      },
    });
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-doc-comment-manager-1',
          record_state: 'active',
          version: 1,
          signature_npub: subscription.managedByNpub,
          group_npubs: ['npub1group'],
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-doc-manager-1',
        target_record_id: 'doc-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:document`,
        sender_npub: subscription.managedByNpub,
        body: 'This section needs a clearer answer.',
        comment_status: 'open',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-doc-comment-manager-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-doc-comment-manager-1',
      }),
    );

    expect(runInputs).toHaveLength(1);
    expect((runInputs[0]?.dispatch as any)?.routeId).toBe(route.routeId);
    expect((runInputs[0]?.record as any)?.payload?.commentId).toBe('comment-doc-manager-1');
    expect(next.recentDispatches[0]?.action).toBe('comment_pipeline_dispatch');
  });

  test('starts configured comment pipeline for document comments that mention the agent', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-pipeline-doc-mention-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-pipeline-doc-mention-agents'));
    const routeStore = new DispatchRouteStore(makeTempDb('agent-comment-pipeline-doc-mention-routes'));
    const pipelineStore = new PipelineStore(makeTempDb('agent-comment-pipeline-doc-mention-runs'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-comment',
      label: 'Comment Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-comment',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });
    routeStore.save({
      managedByNpub: subscription.managedByNpub!,
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'comment',
      capability: 'comment_dispatch',
      pipelineDefinitionId: 'comment-pipeline',
      enabled: true,
    });
    const runInputs: Record<string, unknown>[] = [];
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      agentStore,
      pipelineStore,
      getSessionApiContext: () => ({} as never),
      callbackOrigin: 'http://localhost',
      loadDefinition: async () => ({
        id: 'comment-pipeline',
        slug: 'comment-pipeline',
        name: 'Comment Pipeline',
        scope: 'user',
        ownerAlias: 'manager',
        path: '/tmp/comment-pipeline.json',
        spec: { name: 'Comment Pipeline', input: {}, steps: [] },
      }),
      loadFunctions: async () => ({ registry: {}, records: [] }),
      runPipeline: async (input: any) => {
        runInputs.push(input.input);
        return makePipelineRun('comment-pipeline-run-1', input.input);
      },
    });
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      dispatchPipelineRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-doc-comment-mention-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1humanwriter',
          group_npubs: ['npub1group'],
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-doc-mention-1',
        target_record_id: 'doc-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:document`,
        sender_npub: 'npub1humanwriter',
        body: `@[Comment Agent](mention:person:${subscription.botNpub}) please review this section.`,
        comment_status: 'open',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-doc-comment-mention-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-doc-comment-mention-1',
      }),
    );

    expect(runInputs).toHaveLength(1);
    expect((runInputs[0]?.record as any)?.recordId).toBe('record-doc-comment-mention-1');
    expect((runInputs[0]?.routing as any)?.bindingId).toBe('doc-1');
    expect((runInputs[0]?.routing as any)?.bindingType).toBe('document');
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('comment_pipeline_dispatch');
    expect(next.recentDispatches[0]?.bindingId).toBe('doc-1');
    expect(next.recentDispatches[0]?.bindingType).toBe('document');
  });

  test('routes task advisories into the agent-work runtime', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskDispatches: Array<{ recordId: string; taskId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async (input: any) => {
          taskDispatches.push({
            recordId: input.recordId,
            taskId: input.task.taskId,
            agentId: input.agent.agentId,
          });
          return null;
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-1',
          record_state: 'active',
          version: 2,
          signature_npub: 'npub1user',
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-1',
        flow_id: 'flow-1',
        flow_run_id: 'run-1',
        flow_step: 'step-1',
        title: 'Task one',
        description: 'Complete the task',
        state: 'ready',
        assigned_to: 'npub1bot',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-1',
      }),
    );

    expect(taskDispatches).toEqual([
      {
        recordId: 'record-task-1',
        taskId: 'task-1',
        agentId: 'agent-task',
      },
    ]);
    expect(next.lastSseEventId).toBe('evt-task-1');
  });

  test('does not route approval advisories into the agent-work runtime', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-approval-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-approval-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['approval_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskDispatches: Array<{ recordId: string; taskId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async (input: any) => {
          taskDispatches.push({
            recordId: input.recordId,
            taskId: input.task.taskId,
            agentId: input.agent.agentId,
          });
          return null;
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-approval-1',
          record_state: 'active',
          version: 1,
        },
      ],
      decryptRecordPayload: async () => ({
        approval_id: 'approval-1',
        flow_id: 'flow-1',
        flow_run_id: 'run-1',
        flow_step: 'step-2',
        state: 'approved',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-approval-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'approval'),
        record_id: 'record-approval-1',
      }),
    );

    expect(taskDispatches).toEqual([]);
  });

  test('does not route kickoff tasks into the agent-work runtime', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-kickoff-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-kickoff-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-flow',
      label: 'Flow Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['flow_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('handleTaskDispatch should not run for kickoff tasks');
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-kickoff-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1user',
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'kickoff-1',
        flow_id: 'flow-1',
        flow_run_id: null,
        flow_step: null,
        title: 'Kickoff',
        description: 'Start the flow',
        state: 'new',
        assigned_to: 'npub1bot',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-kickoff-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-kickoff-1',
      }),
    );

    expect(next.recentDispatches).toEqual([]);
  });

  test('does not route review tasks into the agent-work runtime', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-review-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-review-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-review',
      label: 'Review Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_review'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('handleTaskDispatch should not run for review tasks');
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-review-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1user',
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'review-1',
        flow_id: 'flow-1',
        flow_run_id: 'run-1',
        flow_step: 3,
        title: 'Review work',
        description: 'Continue review',
        state: 'review',
        assigned_to: 'npub1bot',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-review-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-review-1',
      }),
    );

    expect(next.recentDispatches).toEqual([]);
  });

  test('records task skip reasons when task advisories are not actionable', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-skip-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-skip-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('handleTaskDispatch should not run for skipped task');
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-skip-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1user',
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-skip-1',
        title: 'Skipped task',
        state: 'open',
        assigned_to: 'npub1someoneelse',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-skip-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-skip-1',
      }),
    );

    expect(next.recentDispatches).toHaveLength(1);
    expect(next.recentDispatches[0]?.kind).toBe('task');
    expect(next.recentDispatches[0]?.action).toBe('skip_assignment');
    expect(next.recentDispatches[0]?.details?.assigned_to).toBe('npub1someoneelse');
  });

  test('records skip_not_ready when an assigned task is not ready yet', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-not-ready-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-not-ready-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('handleTaskDispatch should not run until the task is ready');
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-not-ready-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1user',
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-not-ready-1',
        title: 'Not ready task',
        description: 'Assigned, but still in progress',
        state: 'in_progress',
        assigned_to_npub: 'npub1bot',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-not-ready-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-not-ready-1',
      }),
    );

    expect(next.recentDispatches).toHaveLength(1);
    expect(next.recentDispatches[0]?.action).toBe('skip_not_ready');
    expect(next.recentDispatches[0]?.details?.assigned_to).toBe('npub1bot');
    expect(next.recentDispatches[0]?.details?.state).toBe('in_progress');
  });

  test('skips task dispatch when the bot was the latest updater', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-self-update-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-self-update-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('handleTaskDispatch should not run for bot-authored task rewrites');
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-self-1',
          record_state: 'active',
          version: 2,
          signature_npub: 'npub1bot',
        },
        {
          record_id: 'record-task-self-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1human',
        },
      ],
      decryptRecordPayload: async (params) => ({
        task_id: 'task-self-1',
        title: 'Self updated task',
        description: 'Same task body',
        state: 'open',
        assigned_to_npub: 'npub1bot',
        predecessor_task_ids: [],
        ...(params.record.version === 1 ? {} : {}),
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-self-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-self-1',
      }),
    );

    expect(next.recentDispatches).toHaveLength(1);
    expect(next.recentDispatches[0]?.action).toBe('task_skip_self_update');
    expect(next.recentDispatches[0]?.details?.task_id).toBe('task-self-1');
    expect(next.recentDispatches[0]?.details?.updater_npub).toBe('npub1bot');
  });

  test('skips task dispatch when the workspace key was the latest updater', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-ws-self-update-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-ws-self-update-agents'));
    const subscription = store.save({
      ...makeSubscription(),
      wsKeyNpub: 'npub1wskey',
    });
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => {
          throw new Error('handleTaskDispatch should not run for workspace-key-authored task rewrites');
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-self-2',
          record_state: 'active',
          version: 2,
          signature_npub: 'npub1wskey',
        },
        {
          record_id: 'record-task-self-2',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1human',
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-self-2',
        title: 'Workspace self updated task',
        description: 'Same workspace-signed task body',
        state: 'open',
        assigned_to_npub: 'npub1bot',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-self-2',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-self-2',
      }),
    );

    expect(next.recentDispatches).toHaveLength(1);
    expect(next.recentDispatches[0]?.action).toBe('task_skip_self_update');
    expect(next.recentDispatches[0]?.details?.task_id).toBe('task-self-2');
    expect(next.recentDispatches[0]?.details?.updater_npub).toBe('npub1wskey');
  });

  test('dispatches a self-authored new task when there is no previous version', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-self-new-task-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-self-new-task-agents'));
    const subscription = store.save({
      ...makeSubscription(),
      wsKeyNpub: 'npub1wskey',
    });
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskDispatches: Array<{ recordId: string; taskId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async (input: any) => {
          taskDispatches.push({
            recordId: input.recordId,
            taskId: input.task.taskId,
            agentId: input.agent.agentId,
          });
          return null;
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-self-new-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1wskey',
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-self-new-1',
        title: 'New self-created task',
        description: 'Created by the agent for itself',
        state: 'ready',
        assigned_to_npub: 'npub1bot',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-self-new-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-self-new-1',
      }),
    );

    expect(taskDispatches).toEqual([
      {
        recordId: 'record-task-self-new-1',
        taskId: 'task-self-new-1',
        agentId: 'agent-task',
      },
    ]);
    expect(next.recentDispatches[0]?.action).toBe('task_skip_runtime_returned_null');
  });

  test('dispatches a self-authored task when meaningful dispatch fields change', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-self-changed-task-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-self-changed-task-agents'));
    const subscription = store.save({
      ...makeSubscription(),
      wsKeyNpub: 'npub1wskey',
    });
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskDispatches: Array<{ recordId: string; taskId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async (input: any) => {
          taskDispatches.push({
            recordId: input.recordId,
            taskId: input.task.taskId,
            agentId: input.agent.agentId,
          });
          return null;
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-self-changed-1',
          record_state: 'active',
          version: 2,
          signature_npub: 'npub1wskey',
        },
        {
          record_id: 'record-task-self-changed-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1human',
        },
      ],
      decryptRecordPayload: async (params) => ({
        task_id: 'task-self-changed-1',
        title: 'Self changed task',
        description: params.record.version === 2 ? 'Expanded task description' : 'Short task description',
        state: 'ready',
        assigned_to_npub: 'npub1bot',
        predecessor_task_ids: [],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-self-changed-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-self-changed-1',
      }),
    );

    expect(taskDispatches).toEqual([
      {
        recordId: 'record-task-self-changed-1',
        taskId: 'task-self-changed-1',
        agentId: 'agent-task',
      },
    ]);
  });

  test('keeps task comments off the task-dispatch runtime when only task dispatch is enabled', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-task-comment-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-task-comment-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskCommentDispatches: Array<{ recordId: string; taskId: string; commentId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => null,
        handleTaskCommentDispatch: async (input: any) => {
          taskCommentDispatches.push({
            recordId: input.recordId,
            taskId: input.comment.targetRecordId ?? '',
            commentId: input.comment.commentId,
            agentId: input.agent.agentId,
          });
          return null;
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-comment-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1reviewer',
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-task-1',
        target_record_id: 'task-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:task`,
        body: 'Please check the task again.',
        comment_status: 'open',
        sender_npub: 'npub1reviewer',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-comment-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-task-comment-1',
      }),
    );

    expect(taskCommentDispatches).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('task_comment_skip_no_comment_dispatch_agent');
  });

  test('skips self-authored task comments instead of routing them back into the agent-work runtime', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-task-comment-self-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-task-comment-self-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskCommentDispatches: Array<{ recordId: string; taskId: string; commentId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => null,
        handleTaskCommentDispatch: async (input: any) => {
          taskCommentDispatches.push({
            recordId: input.recordId,
            taskId: input.comment.targetRecordId ?? '',
            commentId: input.comment.commentId,
            agentId: input.agent.agentId,
          });
          return null;
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-comment-self-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1servicewriter',
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-task-self-1',
        target_record_id: 'task-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:task`,
        body: 'No change to the required next action.',
        comment_status: 'open',
        sender_npub: subscription.botNpub,
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-comment-self-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-task-comment-self-1',
      }),
    );

    expect(taskCommentDispatches).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('task_comment_skip_self_update');
  });

  test('records task comment dispatch as disabled when comment dispatch is enabled', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-task-comment-disabled-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-task-comment-disabled-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-comment',
      label: 'Comment Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-comment',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskCommentDispatches: string[] = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async () => null,
        handleTaskCommentDispatch: async (input: any) => {
          taskCommentDispatches.push(input.recordId);
          return null;
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-comment-disabled-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1reviewer',
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-task-disabled-1',
        target_record_id: 'task-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:task`,
        body: `@[Comment Agent](mention:person:${subscription.botNpub}) please check the task again.`,
        comment_status: 'open',
        sender_npub: 'npub1reviewer',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-comment-disabled-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-task-comment-disabled-1',
      }),
    );

    expect(taskCommentDispatches).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('task_comment_dispatch_disabled');
    expect(next.recentDispatches[0]?.sessionId).toBeNull();
    expect(next.recentDispatches[0]?.details?.disabled_reason).toBe('comment_dispatch_stubbed');
  });

  test('records document comment dispatch as disabled when comment dispatch is enabled', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-document-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-document-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-comment',
      label: 'Comment Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-comment',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
      chatPromptTemplate: '',
      taskPromptTemplate: '',
    });

    const documentCommentDispatches: Array<{ recordId: string; documentId: string; commentId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentCommentRuntime: {
        handleDocumentCommentDispatch: async (input: any) => {
          documentCommentDispatches.push({
            recordId: input.recordId,
            documentId: input.comment.targetRecordId ?? '',
            commentId: input.comment.commentId,
            agentId: input.agent.agentId,
          });
          return makeSession('doc-comment-session');
        },
      } as unknown as AgentCommentSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-doc-comment-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1reviewer',
          group_npubs: ['npub1group'],
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-doc-1',
        target_record_id: 'doc-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:document`,
        body: `@[Comment Agent](mention:person:${subscription.botNpub}) please respond in the document thread.`,
        comment_status: 'open',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-doc-comment-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-doc-comment-1',
      }),
    );

    expect(documentCommentDispatches).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('document_comment_dispatch_disabled');
    expect(next.recentDispatches[0]?.sessionId).toBeNull();
  });

  test('skips existing comment advisories from startup or reconnect replay', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-existing-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-existing-agents'));
    const subscription = store.save({
      ...makeSubscription(),
      lastSuccessfulStartupReloadAt: '2026-04-24T08:00:00.000Z',
    });
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-comment',
      label: 'Comment Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-comment',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
      chatPromptTemplate: '',
      taskPromptTemplate: '',
    });

    const documentCommentDispatches: string[] = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentCommentRuntime: {
        handleDocumentCommentDispatch: async (input: any) => {
          documentCommentDispatches.push(input.recordId);
          return makeSession('doc-comment-session');
        },
      } as unknown as AgentCommentSessionRuntime,
      fetchRecordHistory: async () => {
        throw new Error('existing comment advisories should be skipped before record fetch');
      },
      decryptRecordPayload: async () => {
        throw new Error('existing comment advisories should be skipped before decrypt');
      },
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-existing-comment-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-existing-comment-1',
        updated_at: '2026-04-24T07:27:59.631Z',
      }),
    );

    expect(documentCommentDispatches).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('comment_skip_existing_record');
    expect(next.recentDispatches[0]?.sessionId).toBeNull();
  });

  test('skips self-authored document comments instead of routing them back into the agent-comment runtime', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-comment-document-self-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-comment-document-self-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-comment',
      label: 'Comment Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-comment',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
      chatPromptTemplate: '',
      taskPromptTemplate: '',
    });

    const documentCommentDispatches: string[] = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentCommentRuntime: {
        handleDocumentCommentDispatch: async (input: any) => {
          documentCommentDispatches.push(input.recordId);
          return makeSession('doc-comment-session');
        },
      } as unknown as AgentCommentSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-doc-comment-self-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1reviewer',
          group_npubs: ['npub1group'],
        },
      ],
      decryptRecordPayload: async () => ({
        comment_id: 'comment-doc-self-1',
        target_record_id: 'doc-1',
        target_record_family_hash: `${subscription.sourceAppNpub}:document`,
        sender_npub: subscription.botNpub,
        body: 'Self-authored reply.',
        comment_status: 'open',
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-doc-comment-self-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'comment'),
        record_id: 'record-doc-comment-self-1',
      }),
    );

    expect(documentCommentDispatches).toEqual([]);
    expect(next.recentDispatches[0]?.kind).toBe('comment');
    expect(next.recentDispatches[0]?.action).toBe('document_comment_skip_self_update');
  });

  test('dispatches tasks even when predecessor links are present', async () => {
    const store = new WorkspaceSubscriptionStore(makeTempDb('agent-work-predecessor-dispatch-subscriptions'));
    const agentStore = new AgentDefinitionStore(makeTempDb('agent-work-predecessor-dispatch-agents'));
    const subscription = store.save(makeSubscription());
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent-task',
      label: 'Task Agent',
      botNpub: subscription.botNpub,
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/agent-work',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: subscription.managedByNpub,
    });

    const taskDispatches: Array<{ recordId: string; taskId: string; agentId: string }> = [];
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      agentWorkRuntime: {
        handleTaskDispatch: async (input: any) => {
          taskDispatches.push({
            recordId: input.recordId,
            taskId: input.task.taskId,
            agentId: input.agent.agentId,
          });
          return null;
        },
      } as unknown as AgentWorkSessionRuntime,
      fetchRecordHistory: async () => [
        {
          record_id: 'record-task-pred-1',
          record_state: 'active',
          version: 1,
          signature_npub: 'npub1human',
        },
      ],
      decryptRecordPayload: async () => ({
        task_id: 'task-pred-1',
        title: 'Task with predecessor',
        description: 'Should still dispatch to the agent',
        state: 'ready',
        assigned_to_npub: 'npub1bot',
        predecessor_task_ids: ['pred-1'],
      }),
      botKeyStore: {
        getActiveKeyForUser: () => makeBotKeyRecord(),
        getActiveKeyForBotNpub: () => makeBotKeyRecord(),
      },
    });

    seedRuntime(manager, subscription.subscriptionId);

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(
      subscription,
      'evt-task-pred-1',
      'record-changed',
      JSON.stringify({
        family_hash: buildRecordFamilyHash(subscription.sourceAppNpub, 'task'),
        record_id: 'record-task-pred-1',
      }),
    );

    expect(taskDispatches).toEqual([
      {
        recordId: 'record-task-pred-1',
        taskId: 'task-pred-1',
        agentId: 'agent-task',
      },
    ]);
    expect(next.recentDispatches[0]?.action).toBe('task_skip_runtime_returned_null');
  });
});
