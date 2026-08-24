import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentAdapter } from '../agents/agent-adapter';
import type { ProcessManager, SessionSnapshot } from '../agents/process-manager';
import { FlightDeckSessionTurnBridge } from './flightdeck-session-turn-bridge';
import { FlightDeckSessionTurnStore } from './flightdeck-session-turn-store';
import { createFlightDeckTriggerResolver } from './flightdeck-trigger-resolver';
import type { ChatInterceptStateRecord } from './types';
import {
  DuplicateCallbackPublicationDecisionStore,
  DuplicateCallbackPublicationFilter,
} from './duplicate-callback-publication-filter';
import { buildDirectChatRoutingKey } from './direct-chat-contract';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(options: { bound?: boolean; missing?: boolean; triggerMessageId?: string | null;
  rejectActivity?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fd-turn-bridge-'));
  roots.push(root);
  const metadata = options.bound === false
    ? { AGENT: true, billingMode: 'subscription' as const }
    : { AGENT: true, billingMode: 'subscription' as const, sessionClass: 'flightdeck_chat' as const,
        flightdeckTowerServiceNpub: 'npub1tower', flightdeckWorkspaceId: 'workspace-1',
        flightdeckChannelId: 'channel-1', flightdeckThreadId: options.missing ? undefined : 'thread-1',
        flightdeckAgentNpub: 'npub1agent' };
  const session: SessionSnapshot = { id: 'session-1', agent: 'codex', status: 'running', npub: 'npub1owner',
    port: 3700, pid: 1, name: 'bound', startedAt: new Date().toISOString(), command: [],
    workingDirectory: root, logs: [], metadata };
  let messages = [{ role: 'user', content: 'internal callback envelope', createdAt: '2026-07-25T00:00:00.000Z' },
    { role: 'assistant', content: 'Authoritative callback result', createdAt: '2026-07-25T00:00:01.000Z' }];
  const adapter = { fetchMessages: mock(async () => messages), fetchStatus: mock(async () => 'stable' as const),
    deliversPromptsDirectly: () => true, waitForReady: mock(async () => {}), sendMessage: mock(async () => {}),
    interruptCurrentTurn: mock(async () => false), getEventsUrl: () => null, dispose: mock(async () => {}) } satisfies AgentAdapter;
  const manager = { getSession: (id: string) => id === session.id ? session : undefined,
    getAdapter: () => adapter, captureAgentapiCodexSessionIdFromPrompt: mock(async () => false) } as unknown as ProcessManager;
  const publish = mock(async (input: { body: string; clientRequestId?: string | null;
    metadata?: Record<string, unknown> }) => ({ message: { id: 'tower-message-1' }, input }));
  const activityStates: string[] = [];
  const activityBodies: string[] = [];
  const activityTriggers: string[] = [];
  const errors: unknown[] = [];
  const store = new FlightDeckSessionTurnStore(join(root, 'turns.sqlite'));
  const publicationDecisionStore = new DuplicateCallbackPublicationDecisionStore(join(root, 'turns.sqlite'));
  const publicationFilter = new DuplicateCallbackPublicationFilter(() => ({ marker: 'duplicate callback:', windowSeconds: 180 }),
    publicationDecisionStore, { warn: () => {} });
  const bridge = new FlightDeckSessionTurnBridge({ manager,
    store,
    resolveDelivery: () => ({ subscriptionId: 'subscription-1', backendBaseUrl: 'https://tower.test', appNpub: 'npub1app',
      botIdentity: { botNpub: 'npub1agent', botPubkeyHex: '00'.repeat(32), botSecret: new Uint8Array(32) } }),
    resolveTriggerMessageId: () => options.triggerMessageId === undefined ? 'thread-root-message-1' : options.triggerMessageId,
    publish: publish as never,
    publicationFilter,
    createActivity: (context) => { activityTriggers.push(context.triggerMessageId); return ({
      publish: async (state: string, body?: string) => {
        activityStates.push(state);
        if (options.rejectActivity) throw Object.assign(new Error('Tower rejected trigger_message_id'), { status: 422 });
        if (body) activityBodies.push(body);
      },
      publishLatestCommentary: async () => { activityStates.push('working'); activityBodies.push('Visible commentary'); } }) as never;
    },
    log: { error: mock((...args: unknown[]) => { errors.push(args); }) } });
  return { bridge, session, manager, store, publicationDecisionStore, publicationFilter, publish,
    activityStates, activityBodies, activityTriggers, errors,
    setMessages: (next: typeof messages) => { messages = next; } };
}

describe('Flight Deck-bound session turn bridge', () => {
  test('publishes an inbox-wake response once while keeping its internal prompt hidden and surfacing commentary', async () => {
    const f = fixture();
    const turn = f.bridge.accept({ session: f.session, prompt: 'internal callback envelope', promptType: 'dispatch_inbox_wake', boundaryIdentity: 'callback-1' });
    expect(turn).not.toBeNull();
    f.bridge.observe(turn!);
    await f.bridge.waitForIdle();
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish.mock.calls[0]?.[0].body).toBe('Authoritative callback result');
    expect(f.publish.mock.calls[0]?.[0].body).not.toContain('internal callback envelope');
    expect(f.publish.mock.calls[0]?.[0].metadata.prompt_type).toBe('dispatch_inbox_wake');
    expect(f.activityStates).toEqual(['accepted', 'working', 'completed']);
    expect(f.activityBodies).toContain('Visible commentary');
    expect(f.activityTriggers).toEqual(['thread-root-message-1']);
  });

  test('enforces the default inclusive window for Flight Deck-bound session turns', async () => {
    const candidateAt = '2026-07-25T00:03:00.000Z';
    for (const seconds of [179, 180, 181]) {
      const f = fixture();
      const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1',
        channelId: 'channel-1', threadId: 'thread-1', agentNpub: 'npub1agent' });
      const priorAt = new Date(Date.parse(candidateAt) - seconds * 1_000).toISOString();
      f.publicationDecisionStore.recordPublished({ decisionId: `prior-bridge-${seconds}`, routingKey,
        candidateAt: priorAt, publishedAt: priorAt, publishedMessageId: `prior-message-${seconds}` });
      f.setMessages([
        { role: 'user', content: 'internal callback envelope', createdAt: '2026-07-25T00:02:59.000Z' },
        { role: 'assistant', content: '  Duplicate Callback: already handled.', createdAt: candidateAt },
      ]);
      const turn = f.bridge.accept({ session: f.session, prompt: 'internal callback envelope',
        promptType: 'dispatch_callback', boundaryIdentity: `duplicate-callback-${seconds}` })!;
      f.bridge.observe(turn);
      await f.bridge.waitForIdle();
      expect(f.publish).toHaveBeenCalledTimes(seconds <= 180 ? 0 : 1);
      expect(f.store.get(turn.turnId)).toMatchObject(seconds <= 180
        ? { state: 'suppressed', publishedMessageId: null, lastError: 'duplicate_callback_within_window' }
        : { state: 'completed', publishedMessageId: 'tower-message-1', lastError: null });
      expect(f.activityStates).toEqual(['accepted', 'working', 'completed']);
      expect(f.activityBodies).toContain('Visible commentary');
    }
  });

  test('captures and durably publishes the final when Tower rejects transient activity', async () => {
    const f = fixture({ rejectActivity: true });
    const turn = f.bridge.accept({ session: f.session, prompt: 'internal callback envelope',
      promptType: 'dispatch_callback', boundaryIdentity: 'callback-invalid-activity' })!;
    f.bridge.observe(turn);
    await f.bridge.waitForIdle();
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish.mock.calls[0]?.[0].body).toBe('Authoritative callback result');
    expect(f.store.get(turn.turnId)?.state).toBe('completed');
    expect(f.errors.length).toBeGreaterThan(0);
  });

  test('persists a resolved callback trigger for restart recovery of an existing bound session', async () => {
    const f = fixture({ triggerMessageId: 'existing-thread-message-9' });
    const turn = f.bridge.accept({ session: f.session, prompt: 'internal callback envelope',
      promptType: 'queued_prompt', boundaryIdentity: 'existing-session-callback' })!;
    expect(turn.triggerMessageId).toBe('existing-thread-message-9');
    const recoveredTriggers: string[] = [];
    const recovered = new FlightDeckSessionTurnBridge({ manager: f.manager, store: f.store,
      resolveDelivery: () => ({ subscriptionId: 'subscription-1', backendBaseUrl: 'https://tower.test', appNpub: 'npub1app',
        botIdentity: { botNpub: 'npub1agent', botPubkeyHex: '00'.repeat(32), botSecret: new Uint8Array(32) } }),
      resolveTriggerMessageId: () => null,
      publish: f.publish as never,
      publicationFilter: f.publicationFilter,
      createActivity: (context) => { recoveredTriggers.push(context.triggerMessageId); return ({
        publish: async () => {}, publishLatestCommentary: async () => {},
      }) as never; },
    });
    recovered.recover();
    await recovered.waitForIdle();
    expect(recoveredTriggers).toEqual(['existing-thread-message-9']);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  test('recovers the latest valid trigger for an existing session without routing metadata', () => {
    const f = fixture();
    delete f.session.metadata?.flightdeckRoutingKey;
    const binding = {
      sessionId: f.session.id, previousSessionIds: [], workspaceId: 'workspace-1', channelId: 'channel-1',
      threadId: 'thread-1', botNpub: 'npub1agent', lastAgentMessageIdPublished: 'latest-agent-message',
      lastHumanMessageIdDelivered: 'human-message', lastMessageIdSeen: 'seen-message',
    } as unknown as ChatInterceptStateRecord;
    const resolve = createFlightDeckTriggerResolver({ getByRoutingKey: () => null, listAll: () => [binding] });
    expect(resolve(f.session)).toBe('latest-agent-message');
  });

  test('deduplicates direct-chat final publication and restart recovery by stable turn identity', async () => {
    const f = fixture();
    const first = f.bridge.accept({ session: f.session, prompt: '', promptType: 'direct_chat', boundaryIdentity: 'direct-turn-1' })!;
    await f.bridge.publishKnownFinal(first, 'One direct response', '2026-07-25T01:00:00.000Z');
    const replay = f.bridge.accept({ session: f.session, prompt: '', promptType: 'direct_chat', boundaryIdentity: 'direct-turn-1' })!;
    await f.bridge.publishKnownFinal(replay, 'One direct response', '2026-07-25T01:00:00.000Z');
    f.bridge.recover();
    await f.bridge.waitForIdle();
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish.mock.calls[0]?.[0].clientRequestId).toBe(`flightdeck-session-turn:${first.turnId}`);
  });

  test('preserves the owning Agent Direct turn and client request identities', async () => {
    const f = fixture();
    const record = f.bridge.accept({ session: f.session, prompt: '', promptType: 'direct_chat',
      boundaryIdentity: 'direct-boundary', turnId: 'agentdirect-turn-2', clientRequestId: 'agentdirect:route:turn-2',
      sourceMessageIds: ['human-message-2'] })!;
    await f.bridge.publishKnownFinal(record, 'Answer for the second human turn.', '2026-07-26T07:10:00.000Z');

    expect(record.turnId).toBe('agentdirect-turn-2');
    expect(record.clientRequestId).toBe('agentdirect:route:turn-2');
    expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
      body: 'Answer for the second human turn.',
      clientRequestId: 'agentdirect:route:turn-2',
      metadata: { turn_id: 'agentdirect-turn-2', prompt_type: 'direct_chat', source_message_ids: ['human-message-2'] },
    });
  });

  test('does not publish unbound workers even when they have other reporting metadata', async () => {
    const f = fixture({ bound: false });
    f.session.metadata = { AGENT: true, billingMode: 'subscription', bindingType: 'thread', bindingId: 'thread-elsewhere' };
    expect(f.bridge.accept({ session: f.session, prompt: 'worker callback', promptType: 'queued_prompt', boundaryIdentity: 'worker-1' })).toBeNull();
    expect(f.publish).not.toHaveBeenCalled();
  });

  test('fails visibly for an explicit binding with missing routing metadata', () => {
    const f = fixture({ missing: true });
    expect(() => f.bridge.accept({ session: f.session, prompt: 'callback', promptType: 'queued_prompt', boundaryIdentity: 'broken-1' }))
      .toThrow('flightdeckThreadId');
    expect(f.publish).not.toHaveBeenCalled();
  });
});
