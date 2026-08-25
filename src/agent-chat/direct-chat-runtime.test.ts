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
  publish?: (input: any, attempt: number) => Promise<any>;
  directChat?: { enabled: boolean; sessionAgent: string | null; directory: string; model: string | null; idleRetentionMinutes: number } | null;
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
  createGate?: Promise<void>;
  botNpub?: string;
  addBuilder?: boolean;
  useDeliveryReconciler?: boolean;
} = {}) {
  const db = join(tmpdir(), `agent-direct-${randomUUID()}.sqlite`);
  const agentStore = new AgentDefinitionStore(db);
  const interceptStore = new ChatInterceptStateStore(db);
  const turnStore = new DirectChatTurnStore(db);
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
    getAdapter: (id: string) => ({
      waitForReady: async () => {}, fetchStatus: async () => 'stable', deliversPromptsDirectly: () => true, fetchMessages: async () => [...(sessions.get(id).messages ?? [])],
      sendMessage: async (prompt: string) => {
        prompts.push(prompt);
        sessions.get(id).messages.push({ role: 'user', content: prompt, createdAt: new Date().toISOString() });
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
      const metadata = { ...(args[6] ?? {}), nativeAgentSession: args[6]?.nativeAgentSession ?? { agent: args[0], sessionId: `native-${creates.length}`, workingDirectory: args[1], capturedAt: new Date().toISOString(), source: 'manual' } };
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
    if (options.timeoutFirstResponse && finalResponseCalls === 1) {
      await args[3]?.onAccepted?.();
      throw new Error(`Timed out waiting for session ${args[1]} to produce a final response.`);
    }
    if (options.failReusedPromptBoundary && args[1] === 'session-1' && finalResponseCalls === 2) {
      await args[3]?.onAccepted?.();
      throw new PromptBoundaryNotObservedError(args[1]);
    }
    return await sendPromptAndAwaitFinalResponse(...args);
  };
  const deliveryReconciler = options.useDeliveryReconciler
    ? new AgentDirectDeliveryReconciler({ manager, store: turnStore, interceptStore, instanceId: 'runtime-test',
        resolveTransport: (record) => ({ backendBaseUrl: record.backendBaseUrl!, workspaceId: record.workspaceId!, appNpub: record.sourceAppNpub! }),
        withProfileIdentity: async (record, operation) => operation({ botNpub: record.agentNpub!, botPubkeyHex: '00', botSecret: new Uint8Array([1]) }),
        publish: publish as never, dispatchOutcomeStore, activeIntervalMs: 10, unavailableIntervalMs: 10 })
    : undefined;
  const makeRuntime = () => new AgentDirectChatRuntime({ defaultAgent: 'codex', processManager: manager, agentStore, interceptStore, turnStore, publish,
    dispatchOutcomeStore,
    deliveryReconciler,
    publicationFilter,
    withBotIdentity: async (agent, operation) => operation({
      botNpub: agent.botNpub,
      botPubkeyHex: `${agent.agentId}-pubkey`,
      botSecret: new Uint8Array([agent.agentId === 'Builder' ? 2 : 1]),
    }),
    getArchivedSession: (sessionId) => archivedSessions.get(sessionId) ?? null,
    sendFinalResponse,
    createActivityPublisher: (context) => new AgentActivityPublisher(context,
      async (activity) => { activities.push(activity); return {}; },
      undefined, undefined, undefined, activityPublicationStore) });
  const runtime = makeRuntime();
  const now = new Date().toISOString();
  const defaultDirectChat = { enabled: true, sessionAgent: 'codex', directory: '/Users/example/wingmen/agent-workspace', model: null, idleRetentionMinutes: 60 };
  const botNpub = options.botNpub ?? 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg';
  agentStore.save({ agentId: 'exampleAgent', label: 'Example Agent', botNpub, workspaceOwnerNpub: 'npub1workspace', groupNpubs: [], workingDirectory: '/legacy', capabilities: ['chat_intercept'],
    directChat: options.directChat === null ? undefined : options.directChat ?? defaultDirectChat, enabled: true, createdAt: now, updatedAt: now, managedByNpub: 'npub1manager' });
  if (options.addBuilder) agentStore.save({ agentId: 'Builder', label: 'Builder', botNpub: 'npub1Builder', workspaceOwnerNpub: 'npub1manager',
    groupNpubs: [], workingDirectory: '/Users/example/wingmen/Builder21', harness: 'goose', model: 'deepseek/deepseek-v4-flash-0731',
    capabilities: ['chat_intercept'], directChat: { enabled: true, sessionAgent: 'goose', directory: '/Users/example/wingmen/Builder21',
      model: 'deepseek/deepseek-v4-flash-0731', idleRetentionMinutes: 60 }, enabled: true, createdAt: now, updatedAt: now,
    managedByNpub: 'npub1manager' });
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
  });
  return { runtime, makeRuntime, handle, message, prompts, captures, creates, stops, published, activities, interceptStore,
    turnStore, dispatchOutcomeStore, publicationDecisionStore, sessions, archivedSessions, subscription, channel, botIdentity,
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
    expect(f.prompts[0]).toContain('AGENT DIRECT CHAT'); expect(f.published).toHaveLength(1);
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
    expect(state.lastHumanMessageIdDelivered).toBe('m1'); expect(state.lastAgentMessageIdPublished).toBe('agent-message-1'); expect(state.lastCompletedTurnId).toBeTruthy();
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
    const a2 = f.message('a2', 'Prior agent reply', false, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg');
    const m3 = f.message('m3', '@Example Agent follow up', true); await f.handle([m1, a2, m2, m3], 'm3'); await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.prompts).toHaveLength(2); expect(f.prompts[1]).toContain('flightdeck_agent_direct_follow_up_v1');
    const followUp = JSON.parse(f.prompts[1]!);
    expect(followUp.thread_history.map((message: any) => message.message_id)).toEqual(['m1', 'a2', 'm2', 'm3']);
    expect(followUp.actionable_messages.map((message: any) => message.message_id)).toEqual(['m3']);
    expect(f.interceptStore.listAll()[0]?.lastHumanMessageIdDelivered).toBe('m3');
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
    expect(f.prompts[0]).toContain('CHANNEL CONTEXT\nYou are Example Agent in Example Operator’s direct Flight Deck chat.');
  });

  test('routes a canonical mention when a shared channel has legacy persisted false', async () => {
    const f = fixture({ channel: { kind: 'channel', participant_npubs: ['npub1human', 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg'], metadata: { agent_chat: { enabled: false }, basePrompt: 'Legacy context' } } });
    const m1 = f.message('m1', '@Example Agent hello', true);
    expect(await f.handle([m1], 'm1')).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1);
    expect(f.prompts[0]).toContain('CHANNEL CONTEXT\nLegacy context');
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

  test('creates a generation-two continuity replacement when the session is missing', async () => {
    const f = fixture(); const m1 = f.message('m1', 'hello', true); await f.handle([m1], 'm1'); await f.runtime.waitForIdle();
    f.sessions.delete('session-1'); const m2 = f.message('m2', 'recover', true); await f.handle([m1, m2], 'm2'); await f.runtime.waitForIdle();
    const state = f.interceptStore.listAll()[0]!; expect(state.sessionGeneration).toBe(2); expect(state.previousSessionIds).toEqual(['session-1']);
    expect(f.prompts[1]).toContain('CONTINUITY RECOVERY');
  });

  test('falls back to a generation-two continuity replacement when native resume fails', async () => {
    const f = fixture({ failNativeResume: true });
    const m1 = f.message('m1', 'hello', true); await f.handle([m1], 'm1'); await f.runtime.waitForIdle();
    f.sessions.get('session-1').status = 'stopped';
    const m2 = f.message('m2', 'recover', true); await f.handle([m1, m2], 'm2'); await f.runtime.waitForIdle();
    const state = f.interceptStore.listAll()[0]!;
    expect(f.creates).toHaveLength(3); expect(f.creates[1][3].type).toBe('native-resume'); expect(f.creates[2][3].type).toBe('agent-chat');
    expect(state.sessionId).toBe('session-3'); expect(state.sessionGeneration).toBe(2); expect(state.previousSessionIds).toEqual(['session-1']);
    expect(f.prompts[1]).toContain('CONTINUITY RECOVERY');
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
    expect(f.prompts[1]).toContain('CONTINUITY RECOVERY');
    expect(f.prompts[1]).toContain('update please?');
    expect(f.published).toHaveLength(2);
    expect(f.published[1].metadata.session_id).toBe('session-2');
    expect(f.published[1].metadata.source_message_ids).toEqual(['m2']);
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
    expect(f.prompts[0]).toContain('CONTINUITY RECOVERY');
    expect(f.published[0].metadata.source_message_ids).toEqual([firstPending.id, secondPending.id]);
    expect(state.lastHumanMessageIdDelivered).toBe(secondPending.id); expect(state.pendingMessageCount).toBe(0);
  });

  test('restart recovery terminalizes a missing old session and replays durable newer input into a replacement', async () => {
    const f = fixture({ useDeliveryReconciler: true });
    const seeded = seedPendingOrphan(f, 'missing');
    const restarted = f.makeRuntime();
    const input = { subscription: f.subscription, botIdentity: f.botIdentity, channel: f.channel,
      messages: [seeded.oldMessage, seeded.newerMessage],
      event: { entity_id: 'm2', channel_id: 'channel-1', cursor: 'cursor-m2' } };

    expect(restarted.recover(input, seeded.routingKey)).toEqual({
      handled: true,
      reason: 'direct_chat_delivery_reconciliation_queued',
    });
    await restarted.waitForIdle();

    expect(f.turnStore.get(seeded.turnId)).toMatchObject({ state: 'failed', lastErrorClass: 'session_missing' });
    expect(f.creates).toHaveLength(1);
    expect(f.creates[0][3].type).toBe('agent-chat');
    expect(f.published).toHaveLength(1);
    expect(f.published[0].metadata.source_message_ids).toEqual(['m2']);
    expect(f.interceptStore.getByRoutingKey(seeded.routingKey)).toMatchObject({
      sessionId: 'session-1',
      sessionGeneration: 2,
      previousSessionIds: ['dead-session'],
      pendingMessageCount: 0,
    });
  });

  test('a stopped unrecoverable old session is terminalized before the newer message gets a replacement', async () => {
    const f = fixture({ useDeliveryReconciler: true });
    const seeded = seedPendingOrphan(f, 'stopped');
    const input = { subscription: f.subscription, botIdentity: f.botIdentity, channel: f.channel,
      messages: [seeded.oldMessage, seeded.newerMessage],
      event: { entity_id: 'm2', channel_id: 'channel-1', cursor: 'cursor-m2' } };

    expect(await f.runtime.handle(input)).toEqual({ handled: true, reason: 'direct_chat_queued' });
    await f.runtime.waitForIdle();

    expect(f.turnStore.get(seeded.turnId)).toMatchObject({ state: 'failed', lastErrorClass: 'session_stopped' });
    expect(f.creates).toHaveLength(1);
    expect(f.creates[0][3].type).toBe('agent-chat');
    expect(f.published).toHaveLength(1);
    expect(f.published[0].metadata.source_message_ids).toEqual(['m2']);
    expect(f.interceptStore.getByRoutingKey(seeded.routingKey)).toMatchObject({
      sessionGeneration: 2,
      previousSessionIds: ['dead-session'],
    });
  });

  test('queues quick replies without overlapping turns and preserves order', async () => {
    const f = fixture(); const m1 = f.message('m1', 'one', true); const m2 = f.message('m2', 'two', true);
    await Promise.all([f.handle([m1], 'm1'), f.handle([m1, m2], 'm2')]); await f.runtime.waitForIdle();
    expect(f.creates).toHaveLength(1); expect(f.prompts).toHaveLength(2);
    expect(f.prompts[0]).toContain('message_id: m1'); expect(f.prompts[1]).toContain('"message_id": "m2"');
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

  test('recovers a provisional wait timeout after the accepted session produces its late final', async () => {
    const f = fixture({
      timeoutFirstResponse: true,
      useDeliveryReconciler: true,
      directChat: {
        enabled: true,
        sessionAgent: 'goose',
        directory: '/Users/example/wingmen/agent-workspace',
        model: null,
        idleRetentionMinutes: 60,
      },
    });
    const m1 = f.message('m1', '@Example Agent finish this after the supervisor wait', true);
    await f.handle([m1], 'm1');
    await f.runtime.waitForIdle();
    expect(f.dispatchOutcomeStore.listPage(['sub1'], { limit: 25, offset: 0 }).rows[0]).toMatchObject({
      outcome: 'launched', actionId: 'session-1', status: 'waiting', reasonCode: 'provisional_timeout',
    });

    const lateAt = new Date(Date.now() + 10).toISOString();
    f.sessions.get('session-1').messages.push(
      { role: 'user', content: 'accepted source message m1', createdAt: lateAt },
      { role: 'assistant', content: 'Late authoritative final.', createdAt: lateAt },
    );
    const routingKey = f.interceptStore.listAll()[0]!.routingKey;
    const pendingTurn = f.turnStore.getPending(routingKey)!;
    for (let attempt = 0; attempt < 20 && f.published.length === 0; attempt += 1) {
      await f.deliveryReconciler.processTurnNow(pendingTurn.turnId);
      await Bun.sleep(10);
    }
    expect(f.turnStore.get(pendingTurn.turnId)).toMatchObject({ state: 'published' });
    await waitUntil(() => f.published.length === 1);

    expect(f.published.at(-1)?.body).toBe('Late authoritative final.');
    expect(f.dispatchOutcomeStore.listPage(['sub1'], { limit: 25, offset: 0 }).rows[0]).toMatchObject({
      outcome: 'launched', action: 'session', actionId: 'session-1', status: 'recovered',
      reasonCode: 'recovered_success', details: { recovery: { evidence: 'flightdeck_delivery' } },
    });
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
    expect(f.prompts[0]).toContain('"message_id": "m2"');
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
    expect(prompt).toContain('THREAD HISTORY JSON');
    expect(['m1', 'a1', 'm2', 'm3'].every((id) => prompt.includes(`"messageId": "${id}"`))).toBe(true);
    const undeliveredSection = prompt.split('UNDELIVERED MESSAGES JSON\n')[1]!.split('\n\nNEXT MESSAGE')[0]!;
    expect(JSON.parse(undeliveredSection).map((message: any) => message.messageId)).toEqual(['m3']);
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
