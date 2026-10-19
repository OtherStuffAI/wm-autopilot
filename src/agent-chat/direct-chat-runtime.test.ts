import { AgentDirectLifecycleController, AgentSessionHealthPublicationStore } from "./agent-direct-lifecycle-controller.ts";
import { DirectChatEnrichmentStore } from "./direct-chat-enrichment-store.ts";
import type { EnrichDirectChat } from "./direct-chat-enrichment-service.ts";
import type { AgentDefinitionRecord } from "./types.ts";
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { AgentDefinitionStore } from './agent-definition-store';
import { ChatInterceptStateStore } from './chat-intercept-state-store';
import { AgentDirectChatRuntime } from './direct-chat-runtime';
import { AgentDirectDeliveryReconciler } from './direct-chat-delivery-reconciler';
import { AgentActivityPublisher } from './agent-activity-publisher';
import { AgentActivityPublicationStore } from './agent-activity-publication-store';
import { DirectChatTurnStore } from './direct-chat-turn-store';
import { buildDirectChatClientRequestId, buildDirectChatRoutingKey, buildDirectChatTurnId } from './direct-chat-contract';
import { PromptBoundaryNotObservedError, sendPromptAndAwaitFinalResponse } from './session-runtime-session-ops';
import { FlightDeckDispatchOutcomeStore } from './flightdeck-dispatch-outcome-store';
import type { FlightDeckPgMessage } from './tower-client';
import {
  DuplicateCallbackPublicationDecisionStore,
  DuplicateCallbackPublicationFilter,
} from './duplicate-callback-publication-filter';

const ATHENA_BOT_NPUB = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzqunz0d4';

function fixture(options: {
  sdkTransport?: "claude-sdk" | "codex-sdk";
  sendError?: Error;
  publish?: (input: any, attempt: number) => Promise<any>;
  directChat?: AgentDefinitionRecord['directChat'] | null;
  enrichDirectChat?: EnrichDirectChat;
  replyRole?: 'assistant' | 'agent';
  includeWorkingMessage?: boolean;
  finalContent?: string;
  finalCreatedAt?: string;
  channel?: Record<string, unknown>;
  failNativeResume?: boolean;
  nativeResumeFinal?: string;
  failReusedPromptBoundary?: boolean;
  failCreate?: boolean;
  failCreateErrorCode?: string;
  timeoutFirstResponse?: boolean;
  timeoutWithoutReceipt?: boolean;
  promptReadinessTimeouts?: number;
  createGate?: Promise<void>;
  botNpub?: string;
  addBuilder?: boolean;
  useDeliveryReconciler?: boolean;
  reconcileNow?: () => number;
  routePipeline?: (input: any) => Promise<void>;
  observeReply?: (reply: { content: string; createdAt: string }) => Promise<{ content: string; createdAt: string }>;
} = {}) {
  const db = join(tmpdir(), `agent-direct-${randomUUID()}.sqlite`);
  const agentStore = new AgentDefinitionStore(db);
  const interceptStore = new ChatInterceptStateStore(db);
  const turnStore = new DirectChatTurnStore(db);
  const lifecycleStore = new AgentSessionHealthPublicationStore(db);
  const enrichmentStore = new DirectChatEnrichmentStore(db);
  const dispatchOutcomeStore = new FlightDeckDispatchOutcomeStore(db);
  const publicationDecisionStore = new DuplicateCallbackPublicationDecisionStore(db);
  const activityPublicationStore = new AgentActivityPublicationStore(db);
  const publicationFilter = new DuplicateCallbackPublicationFilter(() => ({ marker: 'duplicate callback:', windowSeconds: 180 }),
    publicationDecisionStore, { warn: () => {} });
  const sessions = new Map<string, any>();
  const archivedSessions = new Map<string, any>();
  const prompts: string[] = [];
  const captures: string[] = [];
  const creates: any[] = [];
  const stops: string[] = [];
  const manager = {
    getSession: (id: string) => sessions.get(id) ?? null,
    updateSessionMetadata: (id: string, patch: Record<string, unknown>) => {
      const session = sessions.get(id);
      if (!session) return null;
      session.metadata = { ...session.metadata, ...patch };
      return session;
    },
    getAdapter: (id: string) => ({
      waitForReady: async () => {}, fetchStatus: async () => 'stable', deliversPromptsDirectly: () => true, fetchMessages: async () => [...(sessions.get(id).messages ?? [])],
      sendMessage: async (prompt: string) => {
        prompts.push(prompt);
        sessions.get(id).messages.push({ role: 'user', content: prompt, createdAt: new Date().toISOString() });
        if (options.sendError) throw options.sendError;
        if (options.includeWorkingMessage) sessions.get(id).messages.push({ role: 'agent-working', content: 'Thinking and tool progress', createdAt: new Date().toISOString() });
        sessions.get(id).messages.push({ role: options.replyRole ?? 'assistant', content: options.finalContent ?? '## Answer\n\nFinal **Markdown**.', createdAt: options.finalCreatedAt ?? new Date().toISOString() });
      },
    }),
    createSession: async (...args: any[]) => {
      creates.push(args);
      await options.createGate;
      if (options.failCreate) {
        const error = new Error(options.failCreateErrorCode
          ? `${options.failCreateErrorCode}: complete the authenticated browser unlock once`
          : 'session create failed') as Error & { code?: string };
        error.code = options.failCreateErrorCode;
        throw error;
      }
      if (options.failNativeResume && args[3]?.type === 'native-resume') throw new Error('native session no longer resumable');
      const metadata = { ...(args[6] ?? {}), ...(options.sdkTransport ? { agentTransport: options.sdkTransport } : {}), nativeAgentSession: args[6]?.nativeAgentSession ?? { agent: args[0], sessionId: `native-${creates.length}`, workingDirectory: args[1], capturedAt: new Date().toISOString(), source: 'manual' } };
      const messages = args[3]?.type === 'native-resume' && options.nativeResumeFinal
        ? [{ role: 'user', content: 'accepted source message m2', createdAt: new Date().toISOString() },
            { role: 'assistant', content: options.nativeResumeFinal, createdAt: new Date().toISOString() }]
        : [];
      const session = { id: `session-${creates.length}`, agent: args[0], workingDirectory: args[1], name: args[2], status: 'running', startedAt: new Date().toISOString(), port: 1, command: [], logs: [], metadata, model: args[7], messages };
      sessions.set(session.id, session); return session;
    },
    captureAgentapiCodexSessionIdFromPrompt: async (_id: string, prompt: string) => { captures.push(prompt); return false; },
    stopSession: async (id: string) => { stops.push(id); const session = sessions.get(id); if (session) session.status = 'stopped'; return session ?? null; },
  } as never;
  const published: any[] = [];
  const publish = async (input: any) => { published.push(input); return options.publish ? options.publish(input, published.length) : { message: { id: `agent-message-${published.length}` } }; };
  const activities: any[] = [];
  let finalResponseCalls = 0;
  const sendFinalResponse = async (...args: Parameters<typeof sendPromptAndAwaitFinalResponse>) => {
    finalResponseCalls += 1;
    if ((options.promptReadinessTimeouts ?? 0) >= finalResponseCalls) {
      throw new Error(`Timed out waiting for session ${args[1]} to become prompt-ready. last readiness: busy (agentapi-status-running)`);
    }
    if (options.timeoutWithoutReceipt) {
      throw new Error(`Timed out waiting for session ${args[1]} to produce a final response.`);
    }
    if (options.timeoutFirstResponse && finalResponseCalls === 1) {
      await args[3]?.onAccepted?.();
      throw new Error(`Timed out waiting for session ${args[1]} to produce a final response.`);
    }
    if (options.failReusedPromptBoundary && args[1] === 'session-1' && finalResponseCalls === 2) {
      await args[3]?.onAccepted?.();
      throw new PromptBoundaryNotObservedError(args[1]);
    }
    const reply = await sendPromptAndAwaitFinalResponse(...args);
    return options.observeReply ? await options.observeReply(reply) : reply;
  };
  const deliveryReconciler = options.useDeliveryReconciler
    ? new AgentDirectDeliveryReconciler({ manager, store: turnStore, interceptStore, instanceId: 'runtime-test', now: options.reconcileNow,
        resolveTransport: (record) => ({ backendBaseUrl: record.backendBaseUrl!, workspaceId: record.workspaceId!, appNpub: record.sourceAppNpub! }),
        withProfileIdentity: async (record, operation) => operation({ botNpub: record.agentNpub!, botPubkeyHex: '00', botSecret: new Uint8Array([1]) }),
        publish: publish as never, dispatchOutcomeStore, activeIntervalMs: 10, unavailableIntervalMs: 10 })
    : undefined;
  const makeRuntime = () => new AgentDirectChatRuntime({ defaultAgent: 'codex', processManager: manager, agentStore, interceptStore, turnStore, publish,
    dispatchOutcomeStore,
    enrichmentStore, enrichDirectChat: options.enrichDirectChat,
    deliveryReconciler,
    publicationFilter,
    routePipeline: options.routePipeline,
    withBotIdentity: async (agent, operation) => operation({
      botNpub: agent.botNpub,
      botPubkeyHex: `${agent.agentId}-pubkey`,
      botSecret: new Uint8Array([agent.agentId === 'Builder' ? 2 : 1]),
    }),
    getArchivedSession: (sessionId) => archivedSessions.get(sessionId) ?? null,
    sendFinalResponse,
    createLifecycleController: (context, publisher) => new AgentDirectLifecycleController(context, manager, publisher, async () => ({}), lifecycleStore),
    createActivityPublisher: (context) => new AgentActivityPublisher(context,
      async (activity) => { activities.push(activity); return {}; },
      undefined, async () => [], undefined, activityPublicationStore) });
  const runtime = makeRuntime();
  const now = new Date().toISOString();
  const defaultDirectChat = { enabled: true, sessionAgent: 'codex', directory: '/Users/example/wingmen/agent-workspace', model: null, idleRetentionMinutes: 60 };
  const botNpub = options.botNpub ?? 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg';
  agentStore.save({ agentId: 'exampleAgent', label: 'Example Agent', botNpub, workspaceOwnerNpub: 'npub1workspace', groupNpubs: [], workingDirectory: '/legacy', capabilities: ['chat_intercept'],
    directChat: options.directChat === null ? undefined : options.directChat ?? defaultDirectChat, enabled: true, createdAt: now, updatedAt: now, managedByNpub: 'npub1manager',
    instructorNpubs: ['npub1human', 'npub1mapped', 'npub1other', 'npub1outsider', botNpub] });
  if (options.addBuilder) agentStore.save({ agentId: 'Builder', label: 'Builder', botNpub: 'npub1Builder', workspaceOwnerNpub: 'npub1manager',
    groupNpubs: [], workingDirectory: '/Users/example/wingmen/Builder21', harness: 'goose', model: 'deepseek/deepseek-v4-flash-0731',
    capabilities: ['chat_intercept'], directChat: { enabled: true, sessionAgent: 'goose', directory: '/Users/example/wingmen/Builder21',
      model: 'deepseek/deepseek-v4-flash-0731', idleRetentionMinutes: 60 }, enabled: true, createdAt: now, updatedAt: now,
    managedByNpub: 'npub1manager', instructorNpubs: ['npub1human', 'npub1mapped', 'npub1Builder'] });
  const subscription: any = { subscriptionId: 'sub1', workspaceOwnerNpub: 'npub1owner', workspaceServiceNpub: 'npub1workspace', workspaceId: 'workspace-1', towerServiceNpub: 'npub1tower', backendBaseUrl: 'https://tower', sourceAppNpub: 'npub1app', botNpub, wsKeyNpub: 'npub1mapped', managedByNpub: 'npub1manager' };
  const channel: any = { id: 'channel-1', scope_id: 'scope-1', kind: 'channel', participant_npubs: [], metadata: { agent_chat: { enabled: true, activation: 'mention_then_continue', context_prompt: 'Context' } }, ...(options.channel ?? {}) };
  const botIdentity: any = { botNpub, botPubkeyHex: '00', botSecret: new Uint8Array([1]) };
  const message = (id: string, body: string, mention: false | { type?: string; npub?: string } | true = false, authorNpub = 'npub1human'): FlightDeckPgMessage => ({ id, workspace_id: 'workspace-1', channel_id: 'channel-1', thread_id: 'thread-1', body, created_at: `2026-01-01T00:00:0${id.slice(-1)}Z`, created_by_actor_id: `actor-${id}`, created_by_actor_npub: authorNpub, metadata: mention ? { mentions: [{ type: mention === true ? 'agent' : mention.type ?? '', npub: mention === true ? botNpub : mention.npub ?? botNpub, label: 'Example Agent' }] } : {} });
  const handle = (messages: FlightDeckPgMessage[], entityId: string, event: Record<string, unknown> = {}, audienceAgentNpubs?: string[]) => runtime.handle({
    subscription,
    botIdentity,
    channel,
    messages,
    event: { entity_id: entityId, channel_id: 'channel-1', cursor: `cursor-${entityId}`, ...event },
    audienceAgentNpubs,
    instructionAuthorization: {
      verified: true,
      authorNpub: messages.find((entry) => entry.id === entityId)?.created_by_actor_npub ?? null,
      reason: 'verified',
    },
  });
  return { manager, runtime, makeRuntime, handle, message, prompts, captures, creates, stops, published, activities, agentStore, interceptStore,
    turnStore, enrichmentStore, dispatchOutcomeStore, publicationDecisionStore, sessions, archivedSessions, subscription, channel, botIdentity,
    deliveryReconciler };
}

function seedPendingOrphan(f: any, sessionState: 'missing' | 'stopped') {
  const oldMessage = f.message('m1', '@Example Agent old request', true);
  const newerMessage = f.message('m2', '@Example Agent newer request', true);
  const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1',
    channelId: 'channel-1', threadId: 'thread-1', agentNpub: f.subscription.botNpub });
  const turnId = buildDirectChatTurnId(routingKey, ['m1']);
  const now = new Date().toISOString();
  const intercept = f.interceptStore.upsertMessage({ routingKey, subscriptionId: 'sub1', agentId: 'exampleAgent',
    workspaceOwnerNpub: 'npub1workspace', sourceAppNpub: 'npub1app', towerServiceNpub: 'npub1tower',
    workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1', botNpub: f.subscription.botNpub,
    messageId: 'm2', eventCursor: 'cursor-m2', at: now }).record;
  f.interceptStore.save({ ...intercept, sessionId: null, state: 'pending', lastHumanMessageIdDelivered: 'm1',
    pendingMessageCount: 1 });
  f.turnStore.save({ turnId, routingKey, sourceMessageIds: ['m1'], clientRequestId: buildDirectChatClientRequestId(routingKey, turnId),
    replyBody: null, publishedMessageId: null, state: 'awaiting_reply', createdAt: now, updatedAt: now,
    subscriptionId: 'sub1', backendBaseUrl: 'https://tower', towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1',
    sourceAppNpub: 'npub1app', channelId: 'channel-1', threadId: 'thread-1', agentId: 'exampleAgent',
    agentNpub: f.subscription.botNpub, sessionId: 'dead-session', prompt: 'accepted source message m1',
    promptType: 'direct_chat', acceptedAt: now, nextAttemptAt: now });
  if (sessionState === 'stopped') {
    f.sessions.set('dead-session', { id: 'dead-session', agent: 'codex', workingDirectory: '/Users/example/wingmen/agent-workspace',
      name: 'Example Agent Direct Chat', status: 'stopped', startedAt: now, port: 1, command: [], logs: [], messages: [],
      metadata: { agentChatAgentId: 'exampleAgent', flightdeckAgentNpub: f.subscription.botNpub,
        flightdeckRoutingKey: routingKey, flightdeckWorkspaceId: 'workspace-1', flightdeckChannelId: 'channel-1',
        flightdeckThreadId: 'thread-1' } });
  }
  return { oldMessage, newerMessage, routingKey, turnId };
}

function directSessionMetadata(routingKey: string, overrides: Record<string, unknown> = {}) {
  return {
    agentChatAgentId: 'exampleAgent',
    flightdeckAgentNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg',
    flightdeckRoutingKey: routingKey,
    flightdeckWorkspaceId: 'workspace-1',
    flightdeckChannelId: 'channel-1',
    flightdeckThreadId: 'thread-1',
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

describe('Agent Direct Chat runtime', () => {
  test('requires an instructor grant for a verified explicit self-mention', async () => {
    const f = fixture();
    const agent = f.agentStore.getByAgentId('exampleAgent')!;
    f.agentStore.save({ ...agent, instructorNpubs: ['npub1human'] });
    const selfMention = f.message('m1', '@Example Agent start a tracked task', true, f.subscription.botNpub);

    expect(await f.handle([selfMention], 'm1')).toEqual({ handled: false, reason: 'not_activated' });
    expect(f.creates).toHaveLength(0);
    f.agentStore.save({ ...agent, instructorNpubs: ['npub1human', f.subscription.botNpub] });
    expect(await f.handle([selfMention], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1);

    const unmentioned = f.message('m2', 'Progress update', false, f.subscription.botNpub);
    expect(await f.handle([selfMention, unmentioned], 'm2')).toEqual({ handled: false, reason: 'not_activated' });
    expect(f.creates).toHaveLength(1);
  });

  test('denies invalid signatures and removed or wrong-agent grants before dispatch', async () => {
    const f = fixture({ addBuilder: true });
    const message = f.message('m1', '@Builder do this', { npub: 'npub1Builder' });
    const input = {
      subscription: f.subscription, botIdentity: f.botIdentity, channel: f.channel, messages: [message],
      event: { entity_id: 'm1', channel_id: 'channel-1', cursor: 'cursor-m1' },
      audienceAgentNpubs: ['npub1Builder'],
    };

    expect(await f.runtime.handle({ ...input,
      instructionAuthorization: { verified: false, authorNpub: null, reason: 'missing_instruction_signature' },
    })).toEqual({ handled: false, reason: 'not_activated' });
    expect(f.creates).toHaveLength(0);

    const builder = f.agentStore.getByAgentId('Builder')!;
    f.agentStore.save({ ...builder, instructorNpubs: ['npub1other'] });
    expect(await f.runtime.handle({ ...input,
      instructionAuthorization: { verified: true, authorNpub: 'npub1human', reason: 'verified' },
    })).toEqual({ handled: false, reason: 'not_activated' });
    expect(f.creates).toHaveLength(0);
    expect(f.agentStore.canInstruct('exampleAgent', 'npub1human')).toBe(true);
    expect(f.agentStore.canInstruct('Builder', 'npub1human')).toBe(false);
  });

  test('dispatches Example Agent and Builder mentions as isolated profiles and signing identities', async () => {
    const f = fixture({ addBuilder: true });
    const exampleAgent = f.message('m1', '@Example Agent', { type: 'agent', npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' });
    const Builder = f.message('m2', '@Builder', { type: 'agent', npub: 'npub1Builder' });
    expect(await f.handle([exampleAgent, Builder], 'm2')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1);
    expect(f.creates[0][0]).toBe('goose');
    expect(f.creates[0][1]).toBe('/Users/example/wingmen/Builder21');
    expect(f.creates[0][7]).toBe('deepseek/deepseek-v4-flash-0731');
    expect(f.published[0].botIdentity).toMatchObject({ botNpub: 'npub1Builder', botPubkeyHex: 'Builder-pubkey' });
    expect(f.interceptStore.listAll()[0]).toMatchObject({ agentId: 'Builder', botNpub: 'npub1Builder' });
  });

  test('dispatches Example Agent and Builder independently when both are mentioned', async () => {
    const f = fixture({ addBuilder: true });
    const message = f.message('m1', '@Example Agent @Builder');
    message.metadata = { mentions: [
      { type: 'agent', npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', label: 'Example Agent' },
      { type: 'agent', npub: 'npub1Builder', label: 'Builder' },
    ] };
    expect(await f.handle([message], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates.map((entry) => entry[0]).sort()).toEqual(['codex', 'goose']);
    expect(new Set(f.interceptStore.listAll().map((entry) => entry.routingKey)).size).toBe(2);
    expect(f.published.map((entry) => entry.botIdentity.botNpub).sort()).toEqual(['npub1Builder', 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg']);
  });

  test('routes a shared event only to profiles evidenced by Tower audience', async () => {
    const f = fixture({ addBuilder: true });
    const message = f.message('m1', '@Example Agent @Builder');
    message.metadata = { mentions: [
      { type: 'agent', npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', label: 'Example Agent' },
      { type: 'agent', npub: 'npub1Builder', label: 'Builder' },
    ] };
    expect(await f.handle([message], 'm1', {}, ['npub1Builder'])).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1);
    expect(f.published[0].botIdentity.botNpub).toBe('npub1Builder');
    expect(f.interceptStore.listAll()).toHaveLength(1);
    expect(f.interceptStore.listAll()[0]?.agentId).toBe('Builder');
  });

  test('uses only the selected profile on a profile-bound Flight Deck subscription', async () => {
    const f = fixture({ addBuilder: true });
    f.subscription.agentProfileId = 'Builder';
    const exampleAgent = f.message('m1', '@Example Agent', { type: 'agent', npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' });
    const Builder = f.message('m2', '@Builder', { type: 'agent', npub: 'npub1Builder' });
    expect(await f.handle([exampleAgent, Builder], 'm2')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1);
    expect(f.published[0].botIdentity.botNpub).toBe('npub1Builder');
  });

  test('creates one normal Example Agent session in the configured directory and publishes once', async () => {
    const f = fixture(); const m1 = f.message('m1', '@Example Agent hello', true);
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.creates[0][1]).toBe('/Users/example/wingmen/agent-workspace');
    expect(f.prompts[0]).toContain('"type": "flightdeck_agent_direct_bootstrap_v1"'); expect(f.published).toHaveLength(1);
    expect(f.published[0].clientRequestId).toMatch(/^agentdirect:/);
    expect(f.published[0].metadata.prompt_type).toBe('direct_chat');
    expect(f.published[0].metadata.source_message_ids).toEqual(['m1']);
    expect(f.published[0].metadata.turn_id).toBe(f.interceptStore.listAll()[0]!.lastCompletedTurnId);
    expect(f.dispatchOutcomeStore.listPage(['sub1'], { limit: 25, offset: 0 }).rows[0]).toMatchObject({
      receivedAt: m1.created_at,
      trigger: 'chat',
      outcome: 'launched',
      action: 'session',
      actionId: 'session-1',
      recordId: 'm1',
    });
    const state = f.interceptStore.listAll()[0]!;
    expect(state.lastHumanMessageIdDelivered).toBe('m1'); expect(state.nativeHistoryCheckpointMessageId).toBe('m1');
    expect(state.lastAgentMessageIdPublished).toBe('agent-message-1'); expect(state.lastCompletedTurnId).toBeTruthy();
  });

  test('freezes the observed human final before post-turn reporting can yield', async () => {
    const f = fixture({ finalContent: 'Human answer frozen at its turn boundary.' });
    const originalRecord = f.dispatchOutcomeStore.recordSessionRecovered.bind(f.dispatchOutcomeStore);
    let frozenBeforeReporting: ReturnType<DirectChatTurnStore['get']> = null;
    f.dispatchOutcomeStore.recordSessionRecovered = ((input: Parameters<typeof originalRecord>[0]) => {
      if (input.evidence === 'final_turn') {
        frozenBeforeReporting = f.turnStore.listRecoverable().find((record) => record.promptType === 'direct_chat') ?? null;
      }
      return originalRecord(input);
    }) as typeof f.dispatchOutcomeStore.recordSessionRecovered;
    const human = f.message('m1', '@Example Agent answer this', true);

    await f.handle([human], 'm1');
    await f.runtime.waitForIdle();

    expect(frozenBeforeReporting).toMatchObject({ state: 'reply_ready', replyBody: 'Human answer frozen at its turn boundary.',
      publicationPayload: { body: 'Human answer frozen at its turn boundary.',
        metadata: { prompt_type: 'direct_chat', source_message_ids: ['m1'] } } });
    expect(f.published).toHaveLength(1);
    expect(f.published[0].body).toBe('Human answer frozen at its turn boundary.');
  });

  test('routes a pipeline with the addressed profile identity without creating a session', async () => {
    const routed: any[] = [];
    const f = fixture({
      directChat: { enabled: true, handlerMode: 'pipeline_router', sessionAgent: null,
        directory: '/Users/example/wingmen/agent-workspace', model: null, idleRetentionMinutes: 60 },
      routePipeline: async (input) => { routed.push(input); } });
    f.botIdentity.botNpub = 'npub1listener';
    const addressedNpub = f.agentStore.getByAgentId('exampleAgent')!.botNpub;
    const message = f.message('m1', '@Example Agent route this', { type: 'agent', npub: addressedNpub });

    expect(await f.handle([message], 'm1', {}, [addressedNpub])).toEqual({ handled: true, reason: 'direct_chat_queued' });
    expect(f.creates).toHaveLength(0);
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ agent: { agentId: 'exampleAgent', botNpub: addressedNpub },
      botIdentity: { botNpub: addressedNpub } });
    expect(routed[0].sourceLabel).toBeTruthy();
  });

  test('does not dispatch branch creation and gives child and nested-child threads fresh sessions', async () => {
    const f = fixture();
    const inherited = f.message('m1', '@Example Agent old instruction', true);
    inherited.thread_id = 'parent-thread';
    inherited.owning_thread_id = 'parent-thread';
    inherited.inherited = true;

    expect(await f.handle([inherited], 'child-thread', {
      entity_type: 'thread',
      event_type: 'flightdeck_pg.thread.created',
    })).toEqual({ handled: false, reason: 'not_activated' });
    expect(f.creates).toHaveLength(0);

    const childMessage = f.message('m2', '@Example Agent new child instruction', true);
    childMessage.thread_id = 'child-thread';
    childMessage.owning_thread_id = 'child-thread';
    expect(await f.handle([inherited, childMessage], 'm2', { entity_type: 'message' }))
      .toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();

    const childPrompt = f.prompts[0]!;
    expect(childPrompt).toContain('"thread_id": "child-thread"');
    expect(childPrompt).toContain(' · m1');
    expect(childPrompt).toContain('# Prompt\n\n@Example Agent new child instruction');
    expect(f.published[0].metadata.source_message_ids).toEqual(['m2']);
    expect(f.published[0].threadId).toBe('child-thread');

    const inheritedChild = { ...childMessage, inherited: true };
    const nestedMessage = f.message('m3', '@Example Agent nested instruction', true);
    nestedMessage.thread_id = 'nested-thread';
    nestedMessage.owning_thread_id = 'nested-thread';
    expect(await f.handle([inherited, inheritedChild, nestedMessage], 'm3', { entity_type: 'message' }))
      .toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();

    expect(f.creates).toHaveLength(2);
    expect(new Set(f.interceptStore.listAll().map((entry) => entry.threadId))).toEqual(new Set(['child-thread', 'nested-thread']));
    expect(f.prompts[1]).toContain('# Prompt\n\n@Example Agent nested instruction');
    expect(f.published[1].threadId).toBe('nested-thread');
  });

  test('dispatches an explicit canonical self-mention but ignores ordinary agent-authored output', async () => {
    const f = fixture();
    const ordinaryOutput = f.message('a1', 'Normal agent reply', false, f.subscription.botNpub);
    expect(await f.handle([ordinaryOutput], 'a1')).toEqual({ handled: false, reason: 'not_activated' });

    const selfMention = f.message('a2', '@Example Agent start a new turn', true, f.subscription.botNpub);
    expect(await f.handle([ordinaryOutput, selfMention], 'a2')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();

    expect(f.creates).toHaveLength(1);
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain('@Example Agent start a new turn');
    expect(f.published).toHaveLength(1);
  });

  test('enforces the default inclusive window at the normal publication boundary', async () => {
    const candidateAt = '2026-08-01T00:03:00.000Z';
    for (const seconds of [179, 180, 181]) {
      const f = fixture({ finalContent: 'DuPlIcAtE CaLlBaCk: already handled.', finalCreatedAt: candidateAt });
      const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1',
        channelId: 'channel-1', threadId: 'thread-1', agentNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' });
      const priorAt = new Date(Date.parse(candidateAt) - seconds * 1_000).toISOString();
      f.publicationDecisionStore.recordPublished({ decisionId: `prior-normal-${seconds}`, routingKey,
        candidateAt: priorAt, publishedAt: priorAt, publishedMessageId: `prior-message-${seconds}` });
      const m1 = f.message('m1', '@Example Agent hello', true);
      expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
      await f.runtime.waitForIdle();
      expect(f.published).toHaveLength(seconds <= 180 ? 0 : 1);
      if (seconds <= 180) {
        expect(f.turnStore.get(f.interceptStore.listAll()[0]!.lastCompletedTurnId!)).toMatchObject({
          state: 'suppressed', lastErrorClass: 'duplicate_callback_within_window',
        });
        expect(f.interceptStore.listAll()[0]).toMatchObject({ state: 'idle', lastDecision: 'ignore',
          lastAgentMessageIdPublished: null });
      }
    }
  }, 10_000);

  test('publishes receipt before session creation completes, then advances the same activity to thinking', async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const f = fixture({ createGate });
    const m1 = f.message('m1', '@Example Agent hello', true);
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await Bun.sleep(0);
    expect(f.activities.map((activity) => activity.label)).toEqual(['Message received']);
    releaseCreate();
    await f.runtime.waitForIdle();
    expect(f.activities.slice(0, 2).map((activity) => activity.label)).toEqual(['Message received', 'Agent started']);
    expect(new Set(f.activities.map((activity) => activity.activityId)).size).toBe(1);
  });

  test('stale live reply cannot fail or duplicate a reconciler publication in flight', async () => {
    let started!: () => void;
    let release!: () => void;
    const publishing = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let recovery!: Promise<unknown>;
    const f = fixture({ useDeliveryReconciler: true,
      publish: async () => { started(); await gate; return { message: { id: 'confirmed-final' } }; },
      observeReply: async (reply) => {
        const turn = f.turnStore.listRecoverable()[0]!;
        f.turnStore.releaseAwaiting(turn.turnId, f.deliveryReconciler!.runtimeLeaseOwner, new Date().toISOString());
        f.turnStore.freezeReply(turn.turnId, reply.content, reply.createdAt);
        recovery = f.deliveryReconciler!.processTurnNow(turn.turnId);
        await publishing;
        return { ...reply, content: 'An older competing observation.' };
      },
    });
    const message = f.message('m1', '@Example Agent answer', true);
    await f.handle([message], message.id);
    await f.runtime.waitForIdle();
    const turnId = f.published[0].metadata.turn_id;
    expect(f.turnStore.get(turnId)?.state).toBe('publishing');
    expect(f.activities.some((activity) => activity.state === 'failed')).toBe(false);
    release();
    await recovery;
    expect(f.turnStore.get(turnId)).toMatchObject({ state: 'published', publishedMessageId: 'confirmed-final' });
    await f.handle([message], message.id);
    await f.runtime.waitForIdle();
    expect(f.published).toHaveLength(1);
    expect(f.prompts).toHaveLength(1);
    expect(f.dispatchOutcomeStore.listPage(['sub1'], { limit: 10, offset: 0 }).rows[0]?.outcome).toBe('launched');
  });

  test('keeps a real Tower payload conflict failed and does not retry it', async () => {
    const f = fixture({ useDeliveryReconciler: true, publish: async () => {
      throw Object.assign(new Error('Tower payload conflict'), { status: 409, detailCode: 'idempotency_conflict' });
    } });
    const message = f.message('m1', '@Example Agent answer', true);
    await f.handle([message], message.id);
    await f.runtime.waitForIdle();
    const turn = f.turnStore.get(f.published[0].metadata.turn_id)!;
    expect(turn).toMatchObject({ state: 'integrity_halt', lastErrorClass: 'idempotency_payload_conflict' });
    expect(f.activities.at(-1)).toMatchObject({ state: 'failed' });
    expect(f.dispatchOutcomeStore.listPage(['sub1'], { limit: 10, offset: 0 }).rows[0]?.outcome).toBe('failed');
    await f.deliveryReconciler!.processTurnNow(turn.turnId);
    expect(f.published).toHaveLength(1);
  });

  test('a saved reply retry stays pending until Tower confirms delivery', async () => {
    let clockOffset = 0;
    const f = fixture({ useDeliveryReconciler: true, reconcileNow: () => Date.now() + clockOffset,
      publish: async (_input, attempt) => {
        if (attempt === 1) throw Object.assign(new Error('Tower unavailable'), { status: 503 });
        return { message: { id: 'recovered-final' } };
      },
    });
    const message = f.message('m1', '@Example Agent answer', true);
    await f.handle([message], message.id);
    await f.runtime.waitForIdle();
    const turnId = f.published[0].metadata.turn_id;
    const waiting = f.turnStore.get(turnId)!;
    await f.handle([message], message.id);
    await f.runtime.waitForIdle();
    expect(f.turnStore.get(turnId)).toMatchObject({ state: 'retry_wait', nextAttemptAt: waiting.nextAttemptAt, attemptCount: 1 });
    expect(f.activities.some((activity) => ['failed', 'completed'].includes(activity.state))).toBe(false);
    clockOffset = 10_000;
    await f.deliveryReconciler!.processTurnNow(turnId);
    expect(f.turnStore.get(turnId)).toMatchObject({ state: 'published', publishedMessageId: 'recovered-final' });
    expect(f.published[1]).toEqual(f.published[0]);
    expect(f.prompts).toHaveLength(1);
  });

  test('replay stays on one activity row and session-create failure clears receipt with failed state', async () => {
    const f = fixture({ failCreate: true });
    const m1 = f.message('m1', '@Example Agent hello', true);
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.activities.map((activity) => activity.state)).toEqual(['accepted', 'failed']);
    expect(new Set(f.activities.map((activity) => activity.activityId)).size).toBe(1);
    expect(await f.handle([m1], 'm1')).toEqual({ handled: false, reason: 'not_activated' });
    await f.runtime.waitForIdle();
    expect(f.activities).toHaveLength(2);
  });

  test('persists broker provisioning diagnostics in the Agent Direct turn and dispatch outcome', async () => {
    const f = fixture({ failCreate: true, failCreateErrorCode: 'broker_key_not_provisioned' });
    const m1 = f.message('m1', '@Example Agent please test', true);
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    const turn = f.turnStore.get(buildDirectChatTurnId(
      buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1', agentNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' }),
      ['m1'],
    ));
    expect(turn).toMatchObject({ state: 'failed', lastErrorClass: 'broker_key_not_provisioned' });
    expect(turn?.lastError).toContain('authenticated browser unlock once');
    const outcome = f.dispatchOutcomeStore.listPage(['sub1'], { limit: 10, offset: 0 }).rows[0];
    expect(outcome).toMatchObject({ outcome: 'failed', reasonCode: 'broker_key_not_provisioned' });
    expect(outcome?.details?.error).toContain('authenticated browser unlock once');
  });

  test('does not hand an unreceived prompt timeout to reply reconciliation', async () => {
    const f = fixture({ timeoutWithoutReceipt: true, useDeliveryReconciler: true });
    const message = f.message('m1', '@Example Agent answer this', true);
    await f.handle([message], 'm1');
    await f.runtime.waitForIdle();
    const intercept = f.interceptStore.listAll()[0]!;
    expect(intercept.lastHumanMessageIdDelivered).toBeNull();
    expect(intercept.pendingMessageCount).toBe(1);
    expect(intercept.state).toBe('pending');
    expect(f.turnStore.getPending(intercept.routingKey)).toBeNull();
    expect(f.turnStore.get(buildDirectChatTurnId(intercept.routingKey, ['m1']))?.state).toBe('failed');
    expect(f.published).toHaveLength(0);
    expect(f.dispatchOutcomeStore.listPage(['sub1'], { limit: 10, offset: 0 }).rows[0]).toMatchObject({
      recordId: 'm1', outcome: 'failed',
    });
  });

  test('recreates an orphaned pre-session turn after broker provisioning succeeds', async () => {
    const options = { failCreate: true, failCreateErrorCode: 'broker_key_not_provisioned' };
    const f = fixture(options);
    const m1 = f.message('m1', '@Example Agent first attempt', true);
    await f.handle([m1], 'm1');
    await f.runtime.waitForIdle();
    const failed = f.turnStore.get(buildDirectChatTurnId(
      buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1', agentNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' }),
      ['m1'],
    ))!;
    // Reproduce the upgrade bug where the delivery reconciler changed a
    // pre-session failure into an unrecoverable awaiting_reply row.
    f.turnStore.save({ ...failed, state: 'awaiting_reply', lastErrorClass: 'session_evidence_missing' });

    options.failCreate = false;
    const m2 = f.message('m2', '@Example Agent retry now', true);
    await f.handle([m1, m2], 'm2');
    await f.runtime.waitForIdle();

    expect(f.creates).toHaveLength(2);
    expect(f.published).toHaveLength(1);
    expect(f.published[0].metadata.source_message_ids).toEqual(['m1', 'm2']);
    expect(f.turnStore.get(failed.turnId)?.state).toBe('failed');
    expect(f.interceptStore.listAll()[0]).toMatchObject({ sessionId: 'session-2', pendingMessageCount: 0 });
  });

  test('publishes only the completed final card returned with the sessions API agent role', async () => {
    const richMarkdown = [
      '# Release notes',
      '',
      'A paragraph with [a link](https://example.com) and `inline code`.',
      '',
      '- First item',
      '- **Second item**',
      '',
      '```ts',
      'const ready = true;',
      '```',
    ].join('\n');
    const f = fixture({ replyRole: 'agent', includeWorkingMessage: true, finalContent: richMarkdown }); const m1 = f.message('m1', '@Example Agent hello', true);
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.published).toHaveLength(1); expect(f.published[0].body).toBe(richMarkdown);
    expect(f.published[0].body.startsWith('```\n')).toBe(false);
    expect(f.published[0].body).not.toContain('Thinking and tool progress');
    expect(f.interceptStore.listAll()[0]?.state).toBe('idle');
  });

  test('defaults a legacy null-config chat agent to Direct Chat in its working directory', async () => {
    const f = fixture({ directChat: null }); const m1 = f.message('m1', '@Example Agent hello', { type: 'person' });
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.creates[0][0]).toBe('codex'); expect(f.creates[0][1]).toBe('/legacy');
  });

  test('preserves an explicit Direct Chat opt-out', async () => {
    const f = fixture({ directChat: { enabled: false, sessionAgent: null, directory: '/legacy', model: null, idleRetentionMinutes: 60 } });
    const m1 = f.message('m1', '@Example Agent hello', { type: 'person' });
    expect(await f.handle([m1], 'm1')).toEqual({ handled: false, reason: 'no_direct_chat_agent' });
    expect(f.creates).toHaveLength(0);
  });

  test('literal mention text does not activate an unbound thread', async () => {
    const f = fixture(); const m1 = f.message('m1', '@Example Agent hello');
    expect(await f.handle([m1], 'm1')).toEqual({ handled: false, reason: 'not_activated' });
    expect(f.creates).toHaveLength(0);
  });

  test('activates by matching mention npub even when Tower classifies the actor as a person', async () => {
    const f = fixture({ botNpub: ATHENA_BOT_NPUB });
    const m1 = f.message('m1', '@Athena Lumia hello', { type: 'person', npub: ATHENA_BOT_NPUB });
    m1.mentions = [{ type: 'person', npub: ATHENA_BOT_NPUB, label: 'Athena Lumia' }];
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.published).toHaveLength(1);
  });

  test('does not activate for a canonical mention of another npub', async () => {
    const f = fixture(); const m1 = f.message('m1', '@Other hello', { type: 'agent', npub: 'npub1other' });
    expect(await f.handle([m1], 'm1')).toEqual({ handled: false, reason: 'not_activated' });
    expect(f.creates).toHaveLength(0);
  });

  test('dispatches a newly added agent mention once for each saved message revision', async () => {
    const f = fixture();
    const original = f.message('m1', 'Initial text');
    expect(await f.handle([original], 'm1', { event_type: 'message.created' }))
      .toEqual({ handled: false, reason: 'not_activated' });

    const revised = f.message('m1', 'Initial text @Example Agent', true);
    revised.row_version = 2;
    const revisionEvent = {
      event_type: 'flightdeck_pg.message.revised',
      entity_row_version: 2,
      payload: {
        event_type: 'message.revised',
        message_id: 'm1',
        revision: 2,
        revision_idempotency_key: 'message:m1:revision:2',
        newly_added_mentions: [{ type: 'agent', npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', label: 'Example Agent' }],
      },
    };
    expect(await f.handle([revised], 'm1', revisionEvent)).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.prompts).toHaveLength(1);
    expect(f.published).toHaveLength(1);

    expect(await f.handle([revised], 'm1', revisionEvent)).toEqual({ handled: false, reason: 'not_activated' });
    await f.runtime.waitForIdle();
    expect(f.prompts).toHaveLength(1);
    expect(f.published).toHaveLength(1);

    const revisionThree = { ...revisionEvent, entity_row_version: 3, payload: { ...revisionEvent.payload, revision: 3,
      revision_idempotency_key: 'message:m1:revision:3' } };
    expect(await f.handle([revised], 'm1', revisionThree)).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.prompts).toHaveLength(2);
    expect(f.published).toHaveLength(2);
    expect(f.published[1].clientRequestId).not.toBe(f.published[0].clientRequestId);
  });

  test('dispatches a newly added person mention when its npub is the agent identity', async () => {
    const f = fixture();
    const revised = f.message('m1', 'Initial text @Athena Lumia', { type: 'person', npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' });
    expect(await f.handle([revised], 'm1', {
      event_type: 'flightdeck_pg.message.revised',
      entity_row_version: 2,
      payload: {
        event_type: 'message.revised',
        message_id: 'm1',
        revision: 2,
        revision_idempotency_key: 'message:m1:revision:2',
        newly_added_mentions: [{ type: 'person', npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', label: 'Athena Lumia' }],
      },
    })).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1);
    expect(f.published).toHaveLength(1);
  });

  test('does not dispatch text-only revisions or newly mentioned people with another npub', async () => {
    const f = fixture();
    const revised = f.message('m1', 'Edited wording @Example Agent', true);
    const baseEvent = { event_type: 'flightdeck_pg.message.revised', entity_row_version: 2, payload: { event_type: 'message.revised',
      message_id: 'm1', revision: 2, revision_idempotency_key: 'message:m1:revision:2', newly_added_mentions: [] } };
    expect(await f.handle([revised], 'm1', baseEvent)).toEqual({ handled: false, reason: 'no_new_agent_mentions' });
    expect(await f.handle([revised], 'm1', { event_type: 'flightdeck_pg.message.revised', entity_row_version: 3, payload: { revision: 3,
      event_type: 'message.revised', message_id: 'm1', revision_idempotency_key: 'message:m1:revision:3',
      newly_added_mentions: [{ type: 'person', npub: 'npub1human', label: 'Example Operator' }] } }))
      .toEqual({ handled: false, reason: 'not_activated' });
    expect(f.creates).toHaveLength(0);
    expect(f.prompts).toHaveLength(0);
  });

  test('rejects a revision event whose stable identity fields disagree', async () => {
    const f = fixture();
    const revised = f.message('m1', '@Example Agent edited', true);
    expect(await f.handle([revised], 'm1', {
      event_type: 'flightdeck_pg.message.revised',
      entity_row_version: 2,
      payload: {
        event_type: 'message.revised',
        message_id: 'm1',
        revision: 2,
        revision_idempotency_key: 'message:m1:revision:3',
        newly_added_mentions: [{ type: 'agent', npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' }],
      },
    })).toEqual({ handled: false, reason: 'invalid_message_revision_event' });
    expect(f.creates).toHaveLength(0);
  });

  test('skips an unmentioned shared-thread follow-up without disturbing the binding, then reuses it when mentioned', async () => {
    const f = fixture(); const m1 = f.message('m1', 'hello', true); await f.handle([m1], 'm1'); await f.runtime.waitForIdle();
    const m2 = f.message('m2', 'follow up'); await f.handle([m1, m2], 'm2'); await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.prompts).toHaveLength(1); expect(f.published).toHaveLength(1);
    expect(f.interceptStore.listAll()[0]?.lastHumanMessageIdDelivered).toBe('m1');
    const a2 = f.message('agent-message-1', 'Prior agent reply', false, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg');
    const m3 = f.message('m3', '@Example Agent follow up', true); await f.handle([m1, a2, m2, m3], 'm3'); await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.prompts).toHaveLength(2); expect(f.prompts[1]).not.toContain('# Metadata');
    const followUp = f.prompts[1]!;
    expect(followUp).not.toContain(' · m1');
    expect(followUp).not.toContain(' · agent-message-1');
    expect(followUp).not.toContain('Prior agent reply');
    expect(followUp).toContain(' · m2');
    expect(followUp).toContain('Message: m3 · ');
    expect(followUp).toContain('# Prompt\n\n@Example Agent follow up');
    expect(f.interceptStore.listAll()[0]?.lastHumanMessageIdDelivered).toBe('m3');
    expect(f.interceptStore.listAll()[0]?.nativeHistoryCheckpointMessageId).toBe('m3');
  });

  test('starts a fresh child session for an unmentioned internally routed branch message', async () => {
    const f = fixture();
    const childMessage = {
      ...f.message('m1', 'Try a different approach'),
      thread_id: 'child-thread',
      metadata: { agent_direct_recipient_npub: f.subscription.botNpub },
    };

    expect(await f.handle([childMessage], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();

    expect(f.creates).toHaveLength(1);
    expect(f.prompts).toHaveLength(1);
    const prompt = f.prompts[0]!;
    expect(prompt).toContain('"thread_id": "child-thread"');
    expect(prompt).toContain('"trigger_message_id": "m1"');
    expect(prompt).toContain('# Prompt\n\nTry a different approach');
  });

  test('routes unmentioned messages only in a strict two-party DM and reuses its session', async () => {
    const f = fixture({ channel: { kind: 'dm', participant_npubs: ['npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', 'npub1human'] } });
    const m1 = f.message('m1', 'hello'); expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    expect(f.dispatchOutcomeStore.listPage(['sub1'], { limit: 25, offset: 0 }).rows[0]).toMatchObject({
      recordId: 'm1', agentId: 'exampleAgent', status: 'queued', action: null,
      details: { channel_id: 'channel-1', thread_id: 'thread-1', agent_npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' },
    });
    await f.runtime.waitForIdle();
    expect(f.dispatchOutcomeStore.listPage(['sub1'], { limit: 25, offset: 0 }).rows[0]).toMatchObject({
      recordId: 'm1', agentId: 'exampleAgent', status: 'running', action: 'session', actionId: 'session-1',
    });
    const m2 = f.message('m2', 'follow up'); expect(await f.handle([m1, m2], 'm2')).toEqual({ handled: true, reason: 'direct_chat_queued' }); await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.prompts).toHaveLength(2); expect(f.published).toHaveLength(2);
  });

  test('starts a replacement session when the configured direct chat model changes', async () => {
    const f = fixture({
      directChat: {
        enabled: true,
        sessionAgent: 'codex',
        directory: '/Users/example/wingmen/agent-workspace',
        model: 'gpt-old',
        idleRetentionMinutes: 60,
      },
    });
    const m1 = f.message('m1', '@Example Agent first', true);
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1);
    expect(f.creates[0][7]).toBe('gpt-old');

    const profile = f.agentStore.getByAgentId('exampleAgent')!;
    f.agentStore.save({
      ...profile,
      directChat: { ...profile.directChat!, model: 'gpt-new' },
      updatedAt: new Date().toISOString(),
    });
    const m2 = f.message('m2', '@Example Agent second', true);
    expect(await f.handle([m1, m2], 'm2')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();

    expect(f.creates).toHaveLength(2);
    expect(f.creates[1][7]).toBe('gpt-new');
    expect(f.prompts).toHaveLength(2);
  });

  test('intrinsically enables a live-shape strict DM and falls back to its legacy basePrompt', async () => {
    const f = fixture({ channel: {
      kind: 'dm',
      participant_npubs: ['npub1human', 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg'],
      metadata: { basePrompt: 'You are Example Agent in Example Operator’s direct Flight Deck chat.' },
    } });
    const m1 = f.message('m1', 'Can you track this?');
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain('"channel_context": "You are Example Agent in Example Operator’s direct Flight Deck chat."');
  });

  test('routes a canonical mention when a shared channel has legacy persisted false', async () => {
    const f = fixture({ channel: { kind: 'channel', participant_npubs: ['npub1human', 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg'], metadata: { agent_chat: { enabled: false }, basePrompt: 'Legacy context' } } });
    const m1 = f.message('m1', '@Example Agent hello', true);
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1);
    expect(f.prompts[0]).toContain('"channel_context": "Legacy context"');
  });

  test('requires a mention for malformed, multi-party, or outsider-authored DMs', async () => {
    const cases = [
      { participants: ['npub1human', 'npub1other'], author: 'npub1human' },
      { participants: ['npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', 'npub1human', 'npub1other'], author: 'npub1human' },
      { participants: ['npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', 'npub1human'], author: 'npub1outsider' },
    ];
    for (const [index, item] of cases.entries()) {
      const f = fixture({ channel: { kind: 'dm', participant_npubs: item.participants } });
      const unmentioned = f.message(`m${index + 1}`, 'hello', false, item.author);
      expect(await f.handle([unmentioned], unmentioned.id)).toEqual({ handled: false, reason: 'not_activated' });
      const mentioned = f.message(`m${index + 4}`, '@Example Agent hello', true, item.author);
      expect(await f.handle([mentioned], mentioned.id)).toEqual({ handled: true, reason: 'direct_chat_queued' });
      await f.runtime.waitForIdle(); expect(f.creates).toHaveLength(1);
    }
  }, 10_000);

  test('natively resumes a stopped session without increasing generation', async () => {
    const f = fixture(); const m1 = f.message('m1', 'hello', true); await f.handle([m1], 'm1'); await f.runtime.waitForIdle();
    f.sessions.get('session-1').status = 'stopped'; const m2 = f.message('m2', 'again', true); await f.handle([m1, m2], 'm2'); await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(2); expect(f.creates[1][3].type).toBe('native-resume');
    expect(f.interceptStore.listAll()[0]!.sessionGeneration).toBe(1);
  });

  test('refreshes stale resumed-session binding and terminal next action before accepting the prompt', async () => {
    const f = fixture();
    const m1 = f.message('m1', 'hello', true);
    await f.handle([m1], 'm1');
    await f.runtime.waitForIdle();
    const stale = f.sessions.get('session-1');
    stale.status = 'stopped';
    stale.metadata = {
      ...stale.metadata,
      flightdeckScopeId: 'old-scope',
      flightdeckChannelId: 'old-channel',
      flightdeckThreadId: 'old-thread',
      bindingId: 'old-thread',
      goal: 'Complete an old task',
      nextAction: 'stop',
    };

    const m2 = f.message('m2', 'Handle the newly resumed request', true);
    await f.handle([m1, m2], 'm2');
    await f.runtime.waitForIdle();

    const resumed = f.sessions.get('session-2');
    expect(resumed.metadata).toMatchObject({
      flightdeckWorkspaceId: 'workspace-1',
      flightdeckScopeId: 'scope-1',
      flightdeckChannelId: 'channel-1',
      flightdeckThreadId: 'thread-1',
      bindingType: 'thread',
      bindingId: 'thread-1',
      sessionGeneration: 1,
      nextAction: 'reflect',
    });
    expect(resumed.metadata.goal).toContain('Handle the newly resumed request');
    expect(f.prompts.at(-1)).toContain('Handle the newly resumed request');
    expect(f.dispatchOutcomeStore.listPage(['sub1'], { limit: 25, offset: 0 }).rows[0]).toMatchObject({
      recordId: 'm2', status: 'running', actionId: 'session-2',
    });
  });

  test('rebinds a running reused session before delivering the next message', async () => {
    const f = fixture();
    const m1 = f.message('m1', 'first request', true);
    await f.handle([m1], 'm1');
    await f.runtime.waitForIdle();
    const reused = f.sessions.get('session-1');
    reused.metadata = { ...reused.metadata, flightdeckScopeId: 'stale-scope',
      flightdeckChannelId: 'stale-channel', flightdeckThreadId: 'stale-thread',
      bindingId: 'stale-thread', goal: 'Old completed goal', nextAction: 'stop' };

    const m2 = f.message('m2', 'new request for the running session', true);
    await f.handle([m1, m2], 'm2');
    await f.runtime.waitForIdle();

    expect(f.creates).toHaveLength(1);
    expect(reused.metadata).toMatchObject({ flightdeckScopeId: 'scope-1', flightdeckChannelId: 'channel-1',
      flightdeckThreadId: 'thread-1', bindingId: 'thread-1', nextAction: 'reflect', sessionGeneration: 1 });
    expect(reused.metadata.goal).toContain('new request for the running session');
    expect(f.prompts.at(-1)).toContain('new request for the running session');
  });

  test('creates a generation-two continuity replacement when the session is missing', async () => {
    const f = fixture(); const m1 = f.message('m1', 'hello', true); await f.handle([m1], 'm1'); await f.runtime.waitForIdle();
    f.sessions.delete('session-1'); const m2 = f.message('m2', 'recover', true); await f.handle([m1, m2], 'm2'); await f.runtime.waitForIdle();
    const state = f.interceptStore.listAll()[0]!; expect(state.sessionGeneration).toBe(2); expect(state.previousSessionIds).toEqual(['session-1']);
    expect(f.prompts[1]).toContain('"recovery": {');
  });

  test('falls back to a generation-two continuity replacement when native resume fails', async () => {
    const f = fixture({ failNativeResume: true });
    const m1 = f.message('m1', 'hello', true); await f.handle([m1], 'm1'); await f.runtime.waitForIdle();
    f.sessions.get('session-1').status = 'stopped';
    const m2 = f.message('m2', 'recover', true); await f.handle([m1, m2], 'm2'); await f.runtime.waitForIdle();
    const state = f.interceptStore.listAll()[0]!;
    expect(f.creates).toHaveLength(3); expect(f.creates[1][3].type).toBe('native-resume'); expect(f.creates[2][3].type).toBe('agent-chat');
    expect(state.sessionId).toBe('session-3'); expect(state.sessionGeneration).toBe(2); expect(state.previousSessionIds).toEqual(['session-1']);
    expect(f.prompts[1]).toContain('"recovery": {');
  });

  test('replaces a running wrapper when its underlying agent does not accept the follow-up prompt', async () => {
    const f = fixture({ failReusedPromptBoundary: true });
    const m1 = f.message('m1', 'hello', true);
    await f.handle([m1], 'm1');
    await f.runtime.waitForIdle();

    const m2 = f.message('m2', 'update please?', true);
    await f.handle([m1, m2], 'm2');
    await f.runtime.waitForIdle();

    const state = f.interceptStore.listAll()[0]!;
    expect(f.creates).toHaveLength(2);
    expect(f.creates[1][3].type).toBe('agent-chat');
    expect(state.sessionId).toBe('session-2');
    expect(state.sessionGeneration).toBe(2);
    expect(state.previousSessionIds).toEqual(['session-1']);
    expect(f.stops).toEqual(['session-1']);
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain('"recovery": {');
    expect(f.prompts[1]).toContain('update please?');
    expect(f.published).toHaveLength(2);
    expect(f.published[1].metadata.session_id).toBe('session-2');
    expect(f.published[1].metadata.source_message_ids).toEqual(['m2']);
  });

  test('retires a busy direct chat session and continues dispatch on a replacement', async () => {
    const options = { promptReadinessTimeouts: 0 };
    const f = fixture(options);
    const m1 = f.message('m1', '@Example Agent start', true);
    await f.handle([m1], 'm1');
    await f.runtime.waitForIdle();

    options.promptReadinessTimeouts = 2;
    const m2 = f.message('m2', '@Example Agent update please', true);
    await f.handle([m1, m2], 'm2');
    await f.runtime.waitForIdle();

    const state = f.interceptStore.listAll()[0]!;
    expect(f.stops).toEqual(['session-1']);
    expect(f.creates).toHaveLength(2);
    expect(state.sessionId).toBe('session-2');
    expect(state.sessionGeneration).toBe(2);
    expect(state.previousSessionIds).toEqual(['session-1']);
    expect(f.published).toHaveLength(2);
    expect(f.published[1].metadata.source_message_ids).toEqual(['m2']);
    expect(f.dispatchOutcomeStore.listPage(['sub1'], { limit: 25, offset: 0 }).rows[0]).toMatchObject({
      outcome: 'launched',
      action: 'session',
      actionId: 'session-2',
      recordId: 'm2',
    });
    expect(f.activities.map((activity) => activity.state)).toContain('working');
    expect(f.activities.map((activity) => activity.body).filter(Boolean).join('\n'))
      .toContain('Retired session-1: Timed out waiting for session session-1 to become prompt-ready');
  });

  test('replays multiple pending messages once from an archived production-shaped binding', async () => {
    const f = fixture();
    const original = f.message('original-message', '@Example Agent original', true);
    const firstPending = f.message('c67ebcc9-865d-49b7-b915-fed9bc704079', 'first pending message', true);
    const secondPending = f.message('cd044f5b-d935-487e-ba78-006d9400e5a1', 'second pending message', true);
    original.created_at = '2026-07-24T00:00:00.000Z';
    firstPending.created_at = '2026-07-24T00:01:00.000Z';
    secondPending.created_at = '2026-07-24T00:02:00.000Z';
    const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1',
      channelId: 'channel-1', threadId: 'thread-1', agentNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' });
    const now = new Date().toISOString();
    let seeded = f.interceptStore.upsertMessage({ routingKey, subscriptionId: 'sub1', agentId: 'exampleAgent', workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app', towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1',
      botNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', messageId: firstPending.id, eventCursor: 'cursor-first', at: now }).record;
    seeded = f.interceptStore.upsertMessage({ routingKey, subscriptionId: 'sub1', agentId: 'exampleAgent', workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app', towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1',
      botNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', messageId: secondPending.id, eventCursor: 'cursor-second', at: now }).record;
    f.interceptStore.save({ ...seeded, sessionId: '27d5c647-9312-4a16-a0e4-74cffb6837b6', sessionGeneration: 1,
      state: 'archived', lastDecision: 'failed', lastHumanMessageIdDelivered: original.id, pendingMessageCount: 2 });

    const replayInput = { subscription: f.subscription, botIdentity: f.botIdentity, channel: f.channel,
      messages: [original, firstPending, secondPending], event: { entity_id: secondPending.id, channel_id: 'channel-1', cursor: 'cursor-second' } };
    expect(f.runtime.recover(replayInput, routingKey)).toEqual({ handled: true, reason: 'direct_chat_pending_replay_queued' });
    expect(f.runtime.recover(replayInput, routingKey)).toEqual({ handled: true, reason: 'direct_chat_pending_replay_queued' });
    await f.runtime.waitForIdle();

    const state = f.interceptStore.getByRoutingKey(routingKey)!;
    expect(f.creates).toHaveLength(1); expect(state.sessionGeneration).toBe(2);
    expect(state.previousSessionIds).toEqual(['27d5c647-9312-4a16-a0e4-74cffb6837b6']);
    expect(f.prompts).toHaveLength(1); expect(f.published).toHaveLength(1);
    expect(f.prompts[0]).toContain('"recovery": {');
    expect(f.published[0].metadata.source_message_ids).toEqual([firstPending.id, secondPending.id]);
    expect(state.lastHumanMessageIdDelivered).toBe(secondPending.id); expect(state.pendingMessageCount).toBe(0);
  });

  test('restart recovery terminalizes a missing old session and replays durable newer input into a replacement', async () => {
    const f = fixture({ useDeliveryReconciler: true });
    const seeded = seedPendingOrphan(f, 'missing');
    const restarted = f.makeRuntime();
    const input = { subscription: f.subscription, botIdentity: f.botIdentity, channel: f.channel,
      messages: [seeded.oldMessage, seeded.newerMessage],
      event: { entity_id: 'm2', channel_id: 'channel-1', cursor: 'cursor-m2' },
      instructionAuthorization: { verified: true, authorNpub: 'npub1human', reason: 'verified' } };

    expect(restarted.recover(input, seeded.routingKey)).toEqual({
      handled: true,
      reason: 'direct_chat_delivery_reconciliation_queued',
    });
    await restarted.waitForIdle();

    expect(f.turnStore.get(seeded.turnId)).toMatchObject({ state: 'failed', lastErrorClass: 'session_missing' });
    expect(f.creates).toHaveLength(1);
    expect(f.creates[0][3].type).toBe('agent-chat');
    expect(f.published).toHaveLength(2);
    expect(f.published[0].body).toContain('Work was interrupted');
    expect(f.published[1].metadata.source_message_ids).toEqual(['m2']);
    expect(f.interceptStore.getByRoutingKey(seeded.routingKey)).toMatchObject({
      sessionId: 'session-1',
      sessionGeneration: 2,
      previousSessionIds: ['dead-session'],
      pendingMessageCount: 0,
    });
  });

  test('replays a missing resumed prompt and later chat together without replacing the live session', async () => {
    const f = fixture({ useDeliveryReconciler: true, reconcileNow: () => Date.now() + 600_000 });
    const seeded = seedPendingOrphan(f, 'stopped');
    const session = f.sessions.get('dead-session');
    session.status = 'running';
    session.messages = [{ role: 'user', content: 'Continue the existing goal', createdAt: new Date().toISOString() }];
    const intercept = f.interceptStore.getByRoutingKey(seeded.routingKey)!;
    f.interceptStore.save({ ...intercept, sessionId: session.id });

    await f.handle([seeded.oldMessage, seeded.newerMessage], 'm2');
    await f.runtime.waitForIdle();

    expect(f.turnStore.get(seeded.turnId)).toMatchObject({ state: 'failed', lastErrorClass: 'prompt_not_received' });
    expect(f.creates).toHaveLength(0);
    expect(f.stops).toHaveLength(0);
    expect(f.published).toHaveLength(1);
    expect(f.published[0].metadata.source_message_ids).toEqual(['m1', 'm2']);
    expect(f.interceptStore.getByRoutingKey(seeded.routingKey)).toMatchObject({
      sessionId: 'dead-session', lastHumanMessageIdDelivered: 'm2', pendingMessageCount: 0,
    });
  });

  test('a stopped unrecoverable old session is terminalized before the newer message gets a replacement', async () => {
    const f = fixture({ useDeliveryReconciler: true });
    const seeded = seedPendingOrphan(f, 'stopped');
    const input = { subscription: f.subscription, botIdentity: f.botIdentity, channel: f.channel,
      messages: [seeded.oldMessage, seeded.newerMessage],
      event: { entity_id: 'm2', channel_id: 'channel-1', cursor: 'cursor-m2' },
      instructionAuthorization: { verified: true, authorNpub: 'npub1human', reason: 'verified' } };

    expect(await f.runtime.handle(input)).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();

    expect(f.turnStore.get(seeded.turnId)).toMatchObject({ state: 'failed', lastErrorClass: 'session_stopped' });
    expect(f.creates).toHaveLength(1);
    expect(f.creates[0][3].type).toBe('agent-chat');
    expect(f.published).toHaveLength(2);
    expect(f.published[0].body).toContain('Work was interrupted');
    expect(f.published[1].metadata.source_message_ids).toEqual(['m2']);
    expect(f.interceptStore.getByRoutingKey(seeded.routingKey)).toMatchObject({
      sessionGeneration: 2,
      previousSessionIds: ['dead-session'],
    });
  });

  test('queues quick replies without overlapping turns and preserves order', async () => {
    const f = fixture(); const m1 = f.message('m1', 'one', true); const m2 = f.message('m2', 'two', true);
    await Promise.all([f.handle([m1], 'm1'), f.handle([m1, m2], 'm2')]); await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.prompts).toHaveLength(2);
    expect(f.prompts[0]).toContain('# Prompt\n\none');
    expect(f.prompts[1]).toContain('# Prompt\n\ntwo');
  });

  test('retries publication with the same client request id after restart-style replay', async () => {
    const f = fixture({ useDeliveryReconciler: true, publish: async (_input, attempt) => {
      if (attempt === 1) throw Object.assign(new Error('temporary'), { status: 503 });
      return { message: { id: 'agent-message-replayed' } };
    } });
    const m1 = f.message('m1', 'hello', true); await f.handle([m1], 'm1'); await f.runtime.waitForIdle();
    expect(f.published).toHaveLength(1);
    await Bun.sleep(1_300);
    await f.deliveryReconciler.processTurnNow(f.turnStore.listRecoverable()[0].turnId);
    expect(f.published).toHaveLength(2); expect(f.published[1].clientRequestId).toBe(f.published[0].clientRequestId);
    expect(f.prompts).toHaveLength(1); expect(f.interceptStore.listAll()[0]!.lastAgentMessageIdPublished).toBe('agent-message-replayed');
  });

  test('retains an accepted manager awaiting a worker after observation timeout', async () => {
    const f = fixture({ timeoutFirstResponse: true, useDeliveryReconciler: true });
    const m1 = f.message('m1', '@Example Agent finish this after the supervisor wait', true);
    await f.handle([m1], 'm1');
    await f.runtime.waitForIdle();
    expect(f.stops).toHaveLength(0);
    expect(f.creates).toHaveLength(1);
    expect(f.published).toHaveLength(0);
    expect(f.interceptStore.listAll()[0]).toMatchObject({ sessionId: 'session-1', state: 'active' });
    expect(f.turnStore.listRecoverable()[0]).toMatchObject({ sessionId: 'session-1', state: 'awaiting_reply' });
  });

  test('recovers an accepted turn after restart from the existing clean final without resending its prompt', async () => {
    const f = fixture({ useDeliveryReconciler: true });
    const m1 = f.message('m1', '@Example Agent previous turn', true);
    const a2 = f.message('a2', 'Previous answer', false, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg');
    const m2 = f.message('m2', '@Example Agent survive restart', true);
    const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1', agentNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' });
    const turnId = buildDirectChatTurnId(routingKey, ['m2']);
    const now = new Date().toISOString();
    const seeded = f.interceptStore.upsertMessage({ routingKey, subscriptionId: 'sub1', agentId: 'exampleAgent', workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app', towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1',
      botNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', messageId: 'm2', eventCursor: 'cursor-m2', at: now }).record;
    f.interceptStore.save({ ...seeded, sessionId: 'surviving-session', state: 'active', lastHumanMessageIdDelivered: 'm2',
      lastCompletedTurnId: 'previous-turn', pendingMessageCount: 0 });
    f.turnStore.save({ turnId, routingKey, sourceMessageIds: ['m2'], clientRequestId: buildDirectChatClientRequestId(routingKey, turnId),
      replyBody: null, publishedMessageId: null, state: 'awaiting_reply', createdAt: now, updatedAt: now,
      subscriptionId: 'sub1', backendBaseUrl: 'https://tower', towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1',
      sourceAppNpub: 'npub1app', channelId: 'channel-1', threadId: 'thread-1', agentId: 'exampleAgent',
      agentNpub: f.subscription.botNpub, sessionId: 'surviving-session', prompt: 'follow-up source message m2',
      promptType: 'direct_chat', acceptedAt: now, nextAttemptAt: now });
    f.sessions.set('surviving-session', { id: 'surviving-session', agent: 'codex', workingDirectory: '/Users/example/wingmen/agent-workspace', name: 'Example Agent Direct Chat',
      status: 'running', startedAt: now, port: 1, command: [], logs: [], metadata: directSessionMetadata(routingKey), messages: [
        { role: 'user', content: 'follow-up source message m2', createdAt: now },
        { role: 'assistant', content: '## Recovered final\n\nPublished once.', createdAt: now },
      ] });

    const restarted = f.makeRuntime();
    expect(restarted.recover({ subscription: f.subscription, botIdentity: f.botIdentity, channel: f.channel, messages: [m1, a2, m2],
      event: { entity_id: 'm2', channel_id: 'channel-1', cursor: 'cursor-m2' } }, routingKey))
      .toEqual({ handled: true, reason: 'direct_chat_delivery_reconciliation_queued' });
    await waitUntil(() => f.published.length === 1);
    expect(f.prompts).toHaveLength(0); expect(f.published).toHaveLength(1);
    expect(f.captures).toHaveLength(0);
    expect(f.published[0].body).toBe('## Recovered final\n\nPublished once.');
    expect(f.published[0].clientRequestId).toBe(buildDirectChatClientRequestId(routingKey, turnId));
    expect(f.turnStore.getPending(routingKey)).toBeNull();
    expect(f.interceptStore.getByRoutingKey(routingKey)?.lastCompletedTurnId).toBe(turnId);
  });

  test('starts a distinct turn when a new human message arrives after an accepted turn timed out', async () => {
    const f = fixture();
    const original = f.message('m1', '@Example Agent original request', true);
    const followUp = f.message('m2', '@Example Agent change the current viewed scope only', true);
    const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1',
      channelId: 'channel-1', threadId: 'thread-1', agentNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' });
    const staleTurnId = buildDirectChatTurnId(routingKey, ['m1']);
    const now = new Date().toISOString();
    const seeded = f.interceptStore.upsertMessage({ routingKey, subscriptionId: 'sub1', agentId: 'exampleAgent', workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app', towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1',
      botNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', messageId: 'm2', eventCursor: 'cursor-m2', at: now }).record;
    f.interceptStore.save({ ...seeded, sessionId: 'surviving-session', state: 'pending', lastHumanMessageIdDelivered: 'm1',
      pendingMessageCount: 1 });
    f.turnStore.save({ turnId: staleTurnId, routingKey, sourceMessageIds: ['m1'],
      clientRequestId: buildDirectChatClientRequestId(routingKey, staleTurnId), replyBody: null,
      publishedMessageId: null, state: 'accepted', createdAt: now, updatedAt: now });
    f.sessions.set('surviving-session', { id: 'surviving-session', agent: 'codex', workingDirectory: '/Users/example/wingmen/agent-workspace',
      name: 'Example Agent Direct Chat', status: 'running', startedAt: now, port: 1, command: [], logs: [], metadata: directSessionMetadata(routingKey), messages: [
        { role: 'user', content: 'old prompt containing m1', createdAt: now },
        { role: 'assistant', content: 'Duplicate callback verified and skipped.', createdAt: now },
      ] });

    expect(f.runtime.recover({ subscription: f.subscription, botIdentity: f.botIdentity, channel: f.channel,
      messages: [original, followUp], event: { entity_id: 'm2', channel_id: 'channel-1', cursor: 'cursor-m2' } }, routingKey).handled).toBe(true);
    await f.runtime.waitForIdle();

    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain('Message: m2 · ');
    expect(f.published).toHaveLength(1);
    expect(f.published[0].body).not.toContain('Duplicate callback');
    expect(f.published[0].metadata.source_message_ids).toEqual(['m2']);
    expect(f.published[0].metadata.turn_id).not.toBe(staleTurnId);
  });

  test('native-resumes a production-shaped accepted turn whose bound session was archived', async () => {
    const f = fixture({ nativeResumeFinal: 'Recovered archived final.' });
    const m1 = f.message('m1', '@Example Agent original', true);
    const m2 = f.message('m2', '@Example Agent accepted before cleanup', true);
    const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1', agentNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' });
    const turnId = buildDirectChatTurnId(routingKey, ['m2']);
    const now = new Date().toISOString();
    const seeded = f.interceptStore.upsertMessage({ routingKey, subscriptionId: 'sub1', agentId: 'exampleAgent', workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app', towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1',
      botNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', messageId: 'm2', eventCursor: 'cursor-m2', at: now }).record;
    f.interceptStore.save({ ...seeded, sessionId: '27d5c647-9312-4a16-a0e4-74cffb6837b6', state: 'active',
      lastHumanMessageIdDelivered: 'm2', lastCompletedTurnId: 'turn-one', pendingMessageCount: 0 });
    f.turnStore.save({ turnId, routingKey, sourceMessageIds: ['m2'], clientRequestId: buildDirectChatClientRequestId(routingKey, turnId),
      replyBody: null, publishedMessageId: null, state: 'accepted', createdAt: now, updatedAt: now });
    f.archivedSessions.set('27d5c647-9312-4a16-a0e4-74cffb6837b6', { id: '27d5c647-9312-4a16-a0e4-74cffb6837b6', agent: 'opencode',
      name: 'Example Agent Direct Chat', npub: 'npub1manager', workingDirectory: '/Users/example/wingmen/agent-workspace', metadata: {
        nativeAgentSession: { agent: 'opencode', sessionId: 'native-production-thread', workingDirectory: '/Users/example/wingmen/agent-workspace', capturedAt: now, source: 'manual' },
      } });

    const input = { subscription: f.subscription, botIdentity: f.botIdentity, channel: f.channel, messages: [m1, m2],
      event: { entity_id: 'm2', channel_id: 'channel-1', cursor: 'cursor-m2' } };
    expect(f.runtime.recover(input, routingKey).handled).toBe(true);
    await f.runtime.waitForIdle();

    expect(f.creates).toHaveLength(1); expect(f.creates[0][3].type).toBe('native-resume');
    expect(f.prompts).toHaveLength(0); expect(f.published).toHaveLength(1);
    expect(f.interceptStore.getByRoutingKey(routingKey)?.sessionId).toBe('session-1');
  });

  test('supersedes an accepted turn when replaying a newer message into a generation-two replacement', async () => {
    const f = fixture({ failNativeResume: true });
    const m1 = f.message('m1', '@Example Agent original', true);
    const a1 = f.message('a1', 'First answer', false, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg');
    const m2 = f.message('m2', '@Example Agent accepted message', true);
    const m3 = f.message('m3', '@Example Agent queued while stopped', true);
    const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1', agentNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' });
    const turnId = buildDirectChatTurnId(routingKey, ['m2']);
    const now = new Date().toISOString();
    let seeded = f.interceptStore.upsertMessage({ routingKey, subscriptionId: 'sub1', agentId: 'exampleAgent', workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app', towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1',
      botNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', messageId: 'm2', eventCursor: 'cursor-m2', at: now }).record;
    seeded = f.interceptStore.upsertMessage({ routingKey, subscriptionId: 'sub1', agentId: 'exampleAgent', workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1app', towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1',
      botNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', messageId: 'm3', eventCursor: 'cursor-m3', at: now }).record;
    f.interceptStore.save({ ...seeded, sessionId: 'archived-session', state: 'pending', lastHumanMessageIdDelivered: 'm2',
      lastCompletedTurnId: 'turn-one', pendingMessageCount: 1 });
    f.turnStore.save({ turnId, routingKey, sourceMessageIds: ['m2'], clientRequestId: buildDirectChatClientRequestId(routingKey, turnId),
      replyBody: null, publishedMessageId: null, state: 'accepted', createdAt: now, updatedAt: now });
    f.archivedSessions.set('archived-session', { id: 'archived-session', agent: 'codex', name: 'Example Agent Direct Chat', npub: 'npub1manager',
      workingDirectory: '/Users/example/wingmen/agent-workspace', metadata: { nativeAgentSession: { agent: 'codex', sessionId: 'native-old',
        workingDirectory: '/Users/example/wingmen/agent-workspace', capturedAt: now, source: 'manual' } } });
    const input = { subscription: f.subscription, botIdentity: f.botIdentity, channel: f.channel, messages: [m1, a1, m2, m3],
      event: { entity_id: 'm3', channel_id: 'channel-1', cursor: 'cursor-m3' } };
    f.runtime.recover(input, routingKey); f.runtime.recover(input, routingKey);
    await f.runtime.waitForIdle();

    expect(f.creates).toHaveLength(2); expect(f.creates[0][3].type).toBe('native-resume'); expect(f.creates[1][3].type).toBe('agent-chat');
    expect(f.prompts).toHaveLength(1); expect(f.published).toHaveLength(1);
    const prompt = f.prompts[0]!;
    expect(prompt).toContain('# Metadata');
    expect(prompt).toContain(' · a1');
    expect(prompt).toContain(' · m1');
    expect(prompt).toContain(' · m2');
    expect(prompt).toContain('# Prompt\n\n@Example Agent queued while stopped');
    const state = f.interceptStore.getByRoutingKey(routingKey)!;
    expect(state.sessionGeneration).toBe(2); expect(state.previousSessionIds).toEqual(['archived-session']);
    expect(f.published[0].metadata.source_message_ids).toEqual(['m3']);
  });

  test('blocks on Tower auth failure without publishing speculative output', async () => {
    const f = fixture({ publish: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); } });
    const m1 = f.message('m1', 'hello', true); await f.handle([m1], 'm1'); await f.runtime.waitForIdle();
    expect(f.interceptStore.listAll()[0]!.state).toBe('blocked_auth'); expect(f.published).toHaveLength(1);
    expect(f.interceptStore.listAll()[0]!.lastAgentMessageIdPublished).toBeNull();
  });
});

const enrichmentConfig = { pipeline: "agent-direct-context", version: 1, memory: null,
  recommendPipelines: true, toolNames: [], threshold: .9, maxContextChars: 6000, timeoutMs: 1000 };
const enrichedProfile = { enabled: true, handlerMode: "pipeline_enrichment" as const, sessionAgent: "codex",
  directory: "/Users/example/wingmen/agent-workspace", model: null, idleRetentionMinutes: 60,
  enrichmentByWorkspace: { "workspace-1": enrichmentConfig } };

describe("Agent Direct enrichment integration", () => {
  test("persists bootstrap enrichment before acceptance and reuses delivered context on followup", async () => {
    const requests: any[] = [];
    let f: ReturnType<typeof fixture>;
    f = fixture({ directChat: enrichedProfile, enrichDirectChat: async request => {
      requests.push(request);
      expect(f.enrichmentStore.manifest(request.sessionId)).toHaveLength(requests.length === 1 ? 0 : 1);
      request.onRunStarted(`enrich-${requests.length}`);
      return { status: "ok", context: requests.length === 1 ? [{ key: "memory:synthetic", excerpt: "Synthetic project context.", source: "fixture", freshness: null }] : [] };
    } });
    const m1 = f.message("m1", "@Example Agent initial question", true);
    await f.handle([m1], "m1"); await f.runtime.waitForIdle();
    expect(f.prompts[0]).toContain("Synthetic project context.");
    expect(f.enrichmentStore.manifest("session-1")).toHaveLength(1);
    const m2 = f.message("m2", "@Example Agent follow up", true);
    await f.handle([m1, m2], "m2"); await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.published).toHaveLength(2);
    expect(f.prompts[1]).not.toContain("Synthetic project context.");
    expect(requests[1].manifest).toHaveLength(1);
    const page = f.dispatchOutcomeStore.listPage(["sub1"], { limit: 25, offset: 0 });
    expect(page.rows.find(r => r.recordId === "m2")?.details?.enrichment).toMatchObject({ status: "ok", runId: "enrich-2" });
  });

  test("queues concurrent comments in order, captures mode, and rejects duplicate intake", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const requests: any[] = [];
    const f = fixture({ directChat: enrichedProfile, enrichDirectChat: async request => {
      requests.push(request); if (requests.length === 1) await gate;
      return { status: "ok", context: [] };
    } });
    const m1 = f.message("m1", "@Example Agent first", true);
    await f.handle([m1], "m1");
    while (!requests.length) await Bun.sleep(5);
    const m2 = f.message("m2", "@Example Agent second", true);
    const m3 = f.message("m3", "@Example Agent third", true);
    await f.handle([m1, m2], "m2");
    await f.handle([m1, m2, m3], "m3");
    const agent = f.agentStore.getByAgentId("exampleAgent")!;
    f.agentStore.save({ ...agent, directChat: { ...agent.directChat!, handlerMode: "session" } });
    release(); await f.runtime.waitForIdle();
    expect(requests).toHaveLength(3);
    expect(requests.map(r => r.sourceMessageIds)).toEqual([["m1"], ["m2"], ["m3"]]);
    expect(f.creates).toHaveLength(1); expect(f.published).toHaveLength(3);
    await f.handle([m1, m2, m3], "m3"); await f.runtime.waitForIdle();
    expect(f.published).toHaveLength(3);
    const m4 = f.message("m4", "@Example Agent fourth", true);
    await f.handle([m1, m2, m3, m4], "m4"); await f.runtime.waitForIdle();
    expect(requests).toHaveLength(3); expect(f.prompts).toHaveLength(4);
  });

  test("bounds timeout, ignores late enrichment, and continues one Direct turn", async () => {
    let complete!: (v: any) => void;
    const late = new Promise<any>(resolve => { complete = resolve; });
    const f = fixture({ directChat: { ...enrichedProfile, enrichmentByWorkspace: { "workspace-1": { ...enrichmentConfig, timeoutMs: 100 } } },
      enrichDirectChat: async request => { request.onRunStarted("late-run"); return await late; } });
    const m1 = f.message("m1", "@Example Agent question", true);
    await f.handle([m1], "m1"); await f.runtime.waitForIdle();
    expect(f.published).toHaveLength(1); expect(f.creates).toHaveLength(1);
    complete({ status: "ok", context: [{ key: "late", excerpt: "Must not arrive." }] });
    await Bun.sleep(5);
    expect(f.prompts[0]).not.toContain("Must not arrive.");
    expect(f.enrichmentStore.manifest("session-1")).toHaveLength(0);
    expect(f.dispatchOutcomeStore.listPage(["sub1"], { limit: 25, offset: 0 }).rows[0]?.details?.enrichment).toMatchObject({ status: "timeout", runId: "late-run" });
  });

  test("session replacement re-enriches against a fresh manifest", async () => {
    const requests: any[] = [];
    const f = fixture({ directChat: enrichedProfile, failReusedPromptBoundary: true, enrichDirectChat: async request => {
      requests.push(request); return { status: "ok", context: [{ key: `context:${request.sessionId}`, excerpt: "Synthetic replacement context." }] };
    } });
    const m1 = f.message("m1", "@Example Agent first", true);
    await f.handle([m1], "m1"); await f.runtime.waitForIdle();
    const m2 = f.message("m2", "@Example Agent next", true);
    await f.handle([m1, m2], "m2"); await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(2); expect(f.published).toHaveLength(2);
    expect(requests.at(-1).sessionId).toBe("session-2"); expect(requests.at(-1).manifest).toHaveLength(0);
    expect(f.enrichmentStore.manifest("session-2")).toHaveLength(1);
    const key = buildDirectChatRoutingKey({ towerServiceNpub: "npub1tower", workspaceId: "workspace-1", channelId: "channel-1", threadId: "thread-1", agentNpub: f.subscription.botNpub });
    expect(f.turnStore.get(buildDirectChatTurnId(key, ["m2"]))?.prompt).toBe(f.prompts.at(-1));
  });

  test("recovery uses saved enriched prompt and publishes once without recalling again", async () => {
    let calls = 0;
    const f = fixture({ directChat: enrichedProfile, observeReply: async () => { throw new Error("Timed out waiting for accepted Direct Chat session session-1 to produce a final response."); }, enrichDirectChat: async () => {
      calls++; return { status: "ok", context: [{ key: "persisted", excerpt: "Synthetic recovery context." }] };
    } });
    const m1 = f.message("m1", "@Example Agent first", true);
    await f.handle([m1], "m1"); await f.runtime.waitForIdle();
    const key = buildDirectChatRoutingKey({ towerServiceNpub: "npub1tower", workspaceId: "workspace-1", channelId: "channel-1", threadId: "thread-1", agentNpub: f.subscription.botNpub });
    const turn = f.turnStore.get(buildDirectChatTurnId(key, ["m1"]))!;
    f.sessions.get("session-1").messages.push({ role: "user", content: turn.prompt, createdAt: new Date().toISOString() },
      { role: "assistant", content: "Recovered final.", createdAt: new Date().toISOString() });
    delete f.sessions.get("session-1").metadata.nativeAgentSession;
    const restarted = f.makeRuntime();
    restarted.recover({ subscription: f.subscription, botIdentity: f.botIdentity, channel: f.channel, messages: [m1],
      event: { entity_id: "m1", channel_id: "channel-1", cursor: "restart" } } as any, key);
    await restarted.waitForIdle();
    expect(calls).toBe(1); expect(f.creates).toHaveLength(1); expect(f.published).toHaveLength(1);
    expect(f.published[0].body).toBe("Recovered final.");
  });
  test("restart replacement persists fresh enriched bootstrap before acceptance", async () => {
    let calls = 0;
    const f = fixture({ directChat: enrichedProfile,
      observeReply: async reply => {
        if (calls === 1) throw new Error("Timed out waiting for accepted Direct Chat session session-1 to produce a final response.");
        expect(f.turnStore.getPending(key)?.prompt).toContain("fresh:session-2");
        return reply;
      }, enrichDirectChat: async request => {
        calls++; return { status: "ok", context: [{ key: `fresh:${request.sessionId}`, excerpt: "Synthetic context." }] };
      } });
    const key = buildDirectChatRoutingKey({ towerServiceNpub: "npub1tower", workspaceId: "workspace-1", channelId: "channel-1", threadId: "thread-1", agentNpub: f.subscription.botNpub });
    const m1 = f.message("m1", "@Example Agent first", true);
    await f.handle([m1], "m1"); await f.runtime.waitForIdle();
    f.sessions.get("session-1").status = "stopped";
    delete f.sessions.get("session-1").metadata.nativeAgentSession;
    const restarted = f.makeRuntime();
    restarted.recover({ subscription: f.subscription, botIdentity: f.botIdentity, channel: f.channel, messages: [m1],
      event: { entity_id: "m1", channel_id: "channel-1", cursor: "replacement-restart" } } as any, key);
    await restarted.waitForIdle();
    expect(calls).toBe(2); expect(f.creates).toHaveLength(2); expect(f.published).toHaveLength(1);
    expect(f.enrichmentStore.manifest("session-2")).toHaveLength(1);
  });

});


describe("Claude SDK Flight Deck publication", () => {
  const directChat = { enabled: true, sessionAgent: "claude" as const, directory: "/tmp/claude-project", model: null, idleRetentionMinutes: 60 };
  test("replayed intake publishes the successful final exactly once", async () => {
    const f = fixture({ directChat, sdkTransport: "claude-sdk", includeWorkingMessage: true });
    const message = f.message("m1", "@Example Agent inspect", true);
    await f.handle([message], "m1"); await f.runtime.waitForIdle();
    await f.handle([message], "m1"); await f.runtime.waitForIdle();
    expect(f.published).toHaveLength(1);
    expect(f.published[0].body).toContain("Final **Markdown**");
    expect(f.prompts).toHaveLength(1);
    expect(f.creates[0][0]).toBe("claude");
  });
  test.each(["Agent turn interrupted.", "Claude SDK turn failed"])("%s produces no final publication", async (message) => {
    const f = fixture({ directChat, sdkTransport: "claude-sdk", sendError: new Error(message) });
    const source = f.message("m1", "@Example Agent inspect", true);
    await f.handle([source], "m1"); await f.runtime.waitForIdle();
    expect(f.published).toHaveLength(0);
    expect(f.activities.some((activity) => activity.state === "failed" || activity.state === "cancelled")).toBe(true);
  });
});


test("Codex SDK overload retains its received request and Continue publishes the real final once", async () => {
  const f = fixture({ sdkTransport: "codex-sdk", sendError: new Error("server_overloaded"), useDeliveryReconciler: true });
  const message = f.message("m1", "@Example Agent do the accepted work", true);
  await f.handle([message], "m1");
  await f.runtime.waitForIdle();
  await f.deliveryReconciler!.runOnce();
  const turn = f.turnStore.getPending(f.interceptStore.listAll()[0]!.routingKey)!;
  expect(turn).toMatchObject({ state: "awaiting_reply", sessionId: "session-1", replyBody: null });
  expect(f.creates).toHaveLength(1);
  expect(f.stops).toHaveLength(0);
  expect(f.published).toHaveLength(1);
  expect(f.published[0].body).toContain("Work was interrupted");
  const manager = f.sessions.get("session-1");
  manager.messages.push({ role: "user", content: "Continue", createdAt: new Date().toISOString() },
    { role: "agent-tools", content: "Reviewing surviving worker", createdAt: new Date().toISOString() },
    { role: "assistant", content: "Verified terminal handoff", createdAt: new Date().toISOString() });
  await Bun.sleep(20);
  await f.deliveryReconciler!.runOnce();
  await f.deliveryReconciler!.runOnce();
  expect(f.prompts).toHaveLength(1);
  expect(f.published).toHaveLength(2);
  expect(f.published[1].body).toBe("Verified terminal handoff");
  expect(f.turnStore.get(turn.turnId)?.state).toBe("published");
});

test('fresh human intake discards stopped accepted work and answers only the new question with history preserved', async () => {
  const f = fixture({ useDeliveryReconciler: true, finalContent: 'Here is the substantive answer to your new question.' });
  const old = f.message('m1', 'Old interrupted instruction', true);
  await f.handle([old], 'm1');
  await f.runtime.waitForIdle();
  const intercept = f.interceptStore.listAll()[0]!;
  const originalTurn = f.turnStore.get(buildDirectChatTurnId(intercept.routingKey, ['m1']))!;
  // A distinct old accepted item must not block the fresh human intake.
  f.turnStore.save({ ...originalTurn, turnId: 'interrupted', clientRequestId: 'interrupted-client',
    state: 'awaiting_reply', publicationPayload: null, payloadHash: null, replyBody: null, publishedMessageId: null });
  f.sessions.get(intercept.sessionId).status = 'stopped';
  const fresh = f.message('m2', 'Why are notifications missing now?', true);
  await f.handle([old, fresh], 'm2');
  await f.runtime.waitForIdle();
  expect(f.turnStore.get('interrupted')).toMatchObject({ state: 'suppressed', lastErrorClass: 'fresh_human_supersession' });
  expect(f.prompts).toHaveLength(2);
  expect(f.prompts[1]?.split('# Prompt')[1]).toContain('Why are notifications missing now?');
  expect(f.prompts[1]?.split('# Prompt')[1]).not.toContain('Old interrupted instruction');
  expect(f.sessions.get(intercept.sessionId).messages[0].content).toContain('Old interrupted instruction');
  expect(f.published.at(-1).metadata.source_message_ids).toEqual(['m2']);
  expect(f.published.at(-1).body).toBe('Here is the substantive answer to your new question.');
});

test('fresh human reactivates a live idle native session without replaying an old accepted turn', async () => {
  const f = fixture({ useDeliveryReconciler: true });
  const old = f.message('m1', 'Old request', true);
  await f.handle([old], 'm1');
  await f.runtime.waitForIdle();
  const intercept = f.interceptStore.listAll()[0]!;
  const previous = f.turnStore.get(buildDirectChatTurnId(intercept.routingKey, ['m1']))!;
  f.turnStore.save({ ...previous, turnId: 'old-idle', clientRequestId: 'old-idle-client',
    state: 'awaiting_reply', publicationPayload: null, payloadHash: null, replyBody: null, publishedMessageId: null });
  const manager = f.manager as any;
  const adapter = manager.getAdapter(intercept.sessionId);
  manager.getAdapter = () => adapter;
  const fresh = f.message('m2', 'A new question for the idle session', true);
  await f.handle([old, fresh], 'm2');
  await f.runtime.waitForIdle();
  expect(f.creates).toHaveLength(1);
  expect(f.turnStore.get('old-idle')).toMatchObject({ state: 'suppressed', lastErrorClass: 'fresh_human_supersession' });
  expect(f.published.at(-1).metadata.source_message_ids).toEqual(['m2']);
});
