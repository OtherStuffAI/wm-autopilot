import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import type { ProcessManager } from '../agents/process-manager';
import { AgentDirectDeliveryReconciler } from './direct-chat-delivery-reconciler';
import { DirectChatTurnStore } from './direct-chat-turn-store';
import { ChatInterceptStateStore } from './chat-intercept-state-store';
import { buildDirectChatRoutingKey } from './direct-chat-contract';
import { BrokerKeyNotProvisionedError } from '../signing/broker-key-vault';
import {
  DuplicateCallbackPublicationDecisionStore,
  DuplicateCallbackPublicationFilter,
} from './duplicate-callback-publication-filter';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(options: { publish?: (input: any, attempt: number) => Promise<any>; auth?: boolean;
  resolvedNpub?: string; identityError?: Error } = {}) {
  const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1',
    channelId: 'channel-1', threadId: 'thread-1', agentNpub: 'npub1agent' });
  const root = mkdtempSync(join(tmpdir(), 'agent-direct-delivery-'));
  roots.push(root);
  const storePath = join(root, 'turns.sqlite');
  const store = new DirectChatTurnStore(storePath);
  const interceptStore = new ChatInterceptStateStore(storePath);
  const publicationDecisionStore = new DuplicateCallbackPublicationDecisionStore(storePath);
  const publicationFilter = new DuplicateCallbackPublicationFilter(() => ({ marker: 'duplicate callback:', windowSeconds: 180 }),
    publicationDecisionStore, { warn: () => {} });
  let now = Date.parse('2026-07-29T00:00:00.000Z');
  let authAvailable = options.auth !== false;
  const session = { id: 'session-1', agent: 'codex', status: 'running', metadata: {
    agentChatAgentId: 'exampleAgent', flightdeckAgentNpub: 'npub1agent', flightdeckRoutingKey: routingKey,
    flightdeckWorkspaceId: 'workspace-1', flightdeckChannelId: 'channel-1', flightdeckThreadId: 'thread-1',
  }, messages: [
    { role: 'user', content: 'accepted prompt with source m1', createdAt: new Date(now).toISOString() },
  ] } as any;
  const sessions = new Map([[session.id, session]]);
  const manager = { getSession: (id: string) => sessions.get(id), getAdapter: (id: string) => sessions.has(id) ? ({
    deliversPromptsDirectly: () => true, fetchMessages: async () => [...sessions.get(id)!.messages], fetchStatus: async () => 'stable',
  }) : undefined, captureAgentapiCodexSessionIdFromPrompt: mock(async () => false) } as unknown as ProcessManager;
  const calls: any[] = [];
  const publish = mock(async (input: any) => {
    calls.push(input);
    return options.publish ? options.publish(input, calls.length) : { message: { id: 'tower-message-1' }, replayed: false };
  });
  const make = (instanceId: string) => new AgentDirectDeliveryReconciler({ manager, store, interceptStore, instanceId,
    now: () => now, random: () => 0, activeIntervalMs: 2_000, unavailableIntervalMs: 10_000, leaseMs: 5_000,
    resolveTransport: (record) => authAvailable ? { backendBaseUrl: record.backendBaseUrl!, workspaceId: record.workspaceId!, appNpub: record.sourceAppNpub! } : null,
    withProfileIdentity: async (record, operation) => {
      if (options.identityError) throw options.identityError;
      return operation({ botNpub: options.resolvedNpub ?? record.agentNpub!, botPubkeyHex: '00'.repeat(32), botSecret: new Uint8Array(32) });
    },
    publish: publish as never, publicationFilter });
  const seed = (patch: Record<string, unknown> = {}) => store.save({ turnId: 'turn-1', routingKey, sourceMessageIds: ['m1'],
    clientRequestId: 'agentdirect:route:turn-1', replyBody: null, publishedMessageId: null, state: 'awaiting_reply',
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), subscriptionId: 'sub-1',
    backendBaseUrl: 'https://tower.test', towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1', sourceAppNpub: 'npub1app',
    channelId: 'channel-1', threadId: 'thread-1', agentId: 'exampleAgent', agentNpub: 'npub1agent', sessionId: 'session-1',
    prompt: 'accepted prompt with source m1', promptType: 'direct_chat', acceptedAt: new Date(now).toISOString(),
    nextAttemptAt: new Date(now).toISOString(), ...patch });
  return { store, interceptStore, storePath, publicationDecisionStore, session, sessions, calls, publish, make, seed, routingKey, advance: (ms: number) => { now += ms; },
    setAuth: (value: boolean) => { authAvailable = value; } };
}

describe('Agent Direct durable delivery reconciler', () => {
  test('terminalizes missing and stopped sessions without publishing speculative responses', async () => {
    for (const sessionState of ['missing', 'stopped'] as const) {
      const f = fixture();
      f.seed();
      if (sessionState === 'missing') f.sessions.clear();
      else f.session.status = 'stopped';

      await f.make(`boot-${sessionState}`).processTurnNow('turn-1');

      expect(f.store.get('turn-1')).toMatchObject({ state: 'failed', lastErrorClass: `session_${sessionState}` });
      expect(f.calls).toHaveLength(0);
    }
  });

  test('keeps an active prior turn recoverable and isolates another routing key', async () => {
    const f = fixture();
    f.seed();
    const otherRoutingKey = buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1',
      channelId: 'channel-1', threadId: 'thread-2', agentNpub: 'npub1agent' });
    f.store.save({ ...f.store.get('turn-1')!, turnId: 'turn-2', routingKey: otherRoutingKey,
      clientRequestId: 'agentdirect:route:turn-2', threadId: 'thread-2', sessionId: 'missing-session' });

    await f.make('boot-isolation').processTurnNow('turn-2');

    expect(f.store.get('turn-2')).toMatchObject({ state: 'failed', lastErrorClass: 'session_missing' });
    expect(f.store.get('turn-1')).toMatchObject({ state: 'awaiting_reply', lastErrorClass: null });
    expect(f.store.getPending(f.routingKey)?.turnId).toBe('turn-1');
    expect(f.calls).toHaveLength(0);
  });

  test('publishes a late final after the initial observation owner releases the turn', async () => {
    const f = fixture(); const reconciler = f.make('boot-1');
    f.seed({ leaseOwner: reconciler.runtimeLeaseOwner, leaseExpiresAt: '2026-07-29T00:05:10.000Z' });
    f.store.releaseAwaiting('turn-1', reconciler.runtimeLeaseOwner, '2026-07-29T00:00:00.000Z');
    await reconciler.processTurnNow('turn-1');
    expect(f.store.get('turn-1')?.state).toBe('awaiting_reply');
    f.advance(2_000);
    f.session.messages.push({ role: 'assistant', content: 'Late durable final.', createdAt: '2026-07-29T00:00:02.000Z' });
    await reconciler.processTurnNow('turn-1');
    expect(f.store.get('turn-1')).toMatchObject({ state: 'published', publishedMessageId: 'tower-message-1' });
    expect(f.calls).toHaveLength(1);
  });

  test('publishes a late final after steering input inside the accepted turn', async () => {
    const f = fixture();
    f.seed();
    f.session.messages.push(
      { role: 'user', content: 'Use the CapRover CLI directly.', createdAt: '2026-07-29T00:00:01.000Z' },
      { role: 'assistant', content: 'Deployment completed after the steer.', createdAt: '2026-07-29T00:00:02.000Z' },
    );
    f.advance(2_000);

    await f.make('boot-steered').processTurnNow('turn-1');

    expect(f.store.get('turn-1')).toMatchObject({ state: 'published', publishedMessageId: 'tower-message-1' });
    expect(f.calls[0]?.body).toBe('Deployment completed after the steer.');
  });

  test('enforces the default inclusive window during late reconciliation', async () => {
    const candidateAt = '2026-07-29T00:03:00.000Z';
    for (const seconds of [179, 180, 181]) {
      const f = fixture();
      f.advance(180_000);
      const priorAt = new Date(Date.parse(candidateAt) - seconds * 1_000).toISOString();
      f.publicationDecisionStore.recordPublished({ decisionId: `prior-late-${seconds}`, routingKey: f.routingKey,
        candidateAt: priorAt, publishedAt: priorAt, publishedMessageId: `prior-message-${seconds}` });
      f.seed();
      f.session.messages.push({ role: 'assistant', content: `Duplicate callback: late recovery ${seconds}.`,
        createdAt: candidateAt });
      await f.make(`boot-late-${seconds}`).processTurnNow('turn-1');
      expect(f.calls).toHaveLength(seconds <= 180 ? 0 : 1);
      expect(f.store.get('turn-1')).toMatchObject(seconds <= 180
        ? { state: 'suppressed', lastErrorClass: 'duplicate_callback_within_window', publishedMessageId: null }
        : { state: 'published', publishedMessageId: 'tower-message-1' });
    }
  });

  test('suppresses a frozen reply after restart without publishing its body to Tower', async () => {
    const f = fixture();
    f.publicationDecisionStore.recordPublished({ decisionId: 'prior-restart', routingKey: f.routingKey,
      candidateAt: '2026-07-28T23:59:00.000Z', publishedAt: '2026-07-28T23:59:00.000Z',
      publishedMessageId: 'prior-message' });
    f.seed();
    f.store.freezeReply('turn-1', 'DUPLICATE CALLBACK: restart recovery.', '2026-07-29T00:00:00.000Z');
    f.sessions.clear();
    await f.make('new-boot').processTurnNow('turn-1');
    expect(f.calls).toHaveLength(0);
    expect(f.store.get('turn-1')?.state).toBe('suppressed');
  });

  test('restart releases the old lease and resumes without submitting another session turn', async () => {
    const f = fixture(); f.seed({ leaseOwner: 'old-boot:runtime', leaseExpiresAt: '2026-07-29T00:05:10.000Z' });
    f.session.messages.push({ role: 'assistant', content: 'Final persisted before restart.', createdAt: '2026-07-29T00:00:00.000Z' });
    f.store.releaseForeignLeases('new-boot', '2026-07-29T00:00:00.000Z');
    await f.make('new-boot').processTurnNow('turn-1');
    expect(f.calls).toHaveLength(1);
    expect(f.store.get('turn-1')?.state).toBe('published');
  });

  test('restart requeues only the obsolete subscription-signer integrity halt with its Builder binding intact', async () => {
    const f = fixture();
    const BuilderRoutingKey = buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1',
      channelId: 'channel-1', threadId: 'thread-1', agentNpub: 'npub1Builder' });
    f.sessions.clear();
    f.seed({ routingKey: BuilderRoutingKey, agentId: 'Builder', agentNpub: 'npub1Builder' });
    f.store.freezeReply('turn-1', 'Recovered Builder reply.', '2026-07-29T00:00:00.000Z');
    f.store.markIntegrityHalt('turn-1', 'agent_identity_mismatch',
      'Stored Builder identity does not match subscription signer Example Agent.', '2026-07-29T00:00:00.000Z');
    const reconstructed = new DirectChatTurnStore(f.storePath);
    expect(reconstructed.get('turn-1')).toMatchObject({ state: 'retry_wait', agentId: 'Builder', agentNpub: 'npub1Builder',
      routingKey: BuilderRoutingKey, replyBody: 'Recovered Builder reply.', lastErrorClass: null });
    await f.make('restarted-Builder').processTurnNow('turn-1');
    expect(f.calls[0]?.botIdentity.botNpub).toBe('npub1Builder');
    expect(f.store.get('turn-1')?.state).toBe('published');
  });

  test('publishes a frozen reply when the originating session is archived or missing', async () => {
    const f = fixture(); f.seed(); f.store.freezeReply('turn-1', 'Stored immutable reply.', '2026-07-29T00:00:00.000Z'); f.sessions.clear();
    await f.make('boot-1').processTurnNow('turn-1');
    expect(f.calls[0]).toMatchObject({ body: 'Stored immutable reply.', threadId: 'thread-1' });
    expect(f.store.get('turn-1')?.state).toBe('published');
  });

  test('uses the saved Builder turn identity even when the shared subscription was created for Example Agent', async () => {
    const f = fixture();
    const BuilderRoutingKey = buildDirectChatRoutingKey({ towerServiceNpub: 'npub1tower', workspaceId: 'workspace-1',
      channelId: 'channel-1', threadId: 'thread-1', agentNpub: 'npub1Builder' });
    f.sessions.clear();
    f.seed({ routingKey: BuilderRoutingKey, agentId: 'Builder', agentNpub: 'npub1Builder' });
    f.store.freezeReply('turn-1', 'Builder reply.', '2026-07-29T00:00:00.000Z');
    await f.make('Builder-boot').processTurnNow('turn-1');
    expect(f.calls[0]?.botIdentity.botNpub).toBe('npub1Builder');
    expect(f.calls[0]?.metadata.agent_npub).toBe('npub1Builder');
    expect(f.store.get('turn-1')?.state).toBe('published');
  });

  test('halts when the saved routing key is tampered across agents', async () => {
    const f = fixture(); f.seed({ agentId: 'Builder', agentNpub: 'npub1Builder' });
    f.store.freezeReply('turn-1', 'Do not publish.', '2026-07-29T00:00:00.000Z');
    await f.make('tamper-boot').processTurnNow('turn-1');
    expect(f.calls).toHaveLength(0);
    expect(f.store.get('turn-1')).toMatchObject({ state: 'integrity_halt', lastErrorClass: 'routing_binding_mismatch' });
  });

  test('halts when the resolved profile vault identity differs from the turn npub', async () => {
    const f = fixture({ resolvedNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' }); f.seed();
    f.store.freezeReply('turn-1', 'Do not publish.', '2026-07-29T00:00:00.000Z');
    await f.make('mismatch-boot').processTurnNow('turn-1');
    expect(f.calls).toHaveLength(0);
    expect(f.store.get('turn-1')).toMatchObject({ state: 'integrity_halt', lastErrorClass: 'profile_vault_identity_mismatch' });
  });

  test('blocks publication truthfully when the selected profile vault envelope is missing', async () => {
    const f = fixture({ identityError: new BrokerKeyNotProvisionedError('npub1owner', 'npub1agent') });
    f.seed(); f.store.freezeReply('turn-1', 'Wait for vault provisioning.', '2026-07-29T00:00:00.000Z');
    await f.make('missing-vault-boot').processTurnNow('turn-1');
    expect(f.calls).toHaveLength(0);
    expect(f.store.get('turn-1')).toMatchObject({ state: 'blocked_auth', lastErrorClass: 'broker_key_not_provisioned' });
  });

  test('uses an atomic lease so concurrent recovery paths publish once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture({ publish: async () => { await gate; return { message: { id: 'one-message' } }; } });
    f.seed(); f.store.freezeReply('turn-1', 'One reply.', '2026-07-29T00:00:00.000Z');
    const reconciler = f.make('boot-1');
    const first = reconciler.processTurnNow('turn-1'); const second = reconciler.processTurnNow('turn-1');
    await Bun.sleep(0); release(); await Promise.all([first, second]);
    expect(f.calls).toHaveLength(1);
  });

  test('persists Tower outage retry state and later sends the identical frozen payload', async () => {
    const f = fixture({ publish: async (_input, attempt) => {
      if (attempt === 1) throw Object.assign(new Error('unavailable'), { status: 503 });
      return { message: { id: 'recovered-message' } };
    } });
    f.seed(); f.store.freezeReply('turn-1', 'Retry me exactly.', '2026-07-29T00:00:00.000Z'); const reconciler = f.make('boot-1');
    await reconciler.processTurnNow('turn-1');
    expect(f.store.get('turn-1')).toMatchObject({ state: 'retry_wait', attemptCount: 1, lastErrorClass: 'tower_503' });
    f.advance(2_000); await reconciler.processTurnNow('turn-1');
    expect(f.store.get('turn-1')?.state).toBe('published');
    expect(f.calls[1]).toEqual(f.calls[0]);
  });

  test('reconciles an identical Tower idempotency replay as published', async () => {
    const f = fixture({ publish: async () => ({ message: { id: 'existing-message' }, replayed: true }) });
    f.seed(); f.store.freezeReply('turn-1', 'Already there.', '2026-07-29T00:00:00.000Z'); await f.make('boot-1').processTurnNow('turn-1');
    expect(f.store.get('turn-1')).toMatchObject({ state: 'published', publishedMessageId: 'existing-message' });
  });

  test('quarantines a materially different Tower idempotency payload and preserves the frozen reply', async () => {
    const f = fixture({ publish: async () => { throw Object.assign(new Error('materially different message'), { status: 409, detailCode: 'idempotency_conflict' }); } });
    f.seed(); const frozen = f.store.freezeReply('turn-1', 'Frozen original.', '2026-07-29T00:00:00.000Z'); await f.make('boot-1').processTurnNow('turn-1');
    expect(f.store.get('turn-1')).toMatchObject({ state: 'integrity_halt', replyBody: 'Frozen original.', payloadHash: frozen.payloadHash,
      lastErrorClass: 'idempotency_payload_conflict' });
    expect(() => f.store.freezeReply('turn-1', 'Replacement.')).toThrow();
  });

  test('keeps auth failure visible and recovers after subscription authentication repair', async () => {
    const f = fixture({ auth: false }); f.seed(); f.store.freezeReply('turn-1', 'Publish after repair.', '2026-07-29T00:00:00.000Z'); const reconciler = f.make('boot-1');
    await reconciler.processTurnNow('turn-1');
    expect(f.store.get('turn-1')).toMatchObject({ state: 'blocked_auth', lastErrorClass: 'transport_binding_unavailable' });
    f.setAuth(true); f.advance(11_000); await reconciler.processTurnNow('turn-1');
    expect(f.store.get('turn-1')?.state).toBe('published');
  });

  test('persists a Tower 403 and publishes after the repaired credential succeeds', async () => {
    const f = fixture({ publish: async (_input, attempt) => {
      if (attempt === 1) throw Object.assign(new Error('forbidden'), { status: 403 });
      return { message: { id: 'message-after-auth-repair' } };
    } });
    f.seed();
    f.store.freezeReply('turn-1', 'Credential repair reply.', '2026-07-29T00:00:00.000Z');
    const reconciler = f.make('boot-1');
    await reconciler.processTurnNow('turn-1');
    expect(f.store.get('turn-1')).toMatchObject({ state: 'blocked_auth', lastErrorClass: 'tower_auth_403' });
    f.advance(11_000);
    await reconciler.processTurnNow('turn-1');
    expect(f.store.get('turn-1')).toMatchObject({ state: 'published', publishedMessageId: 'message-after-auth-repair' });
  });

  test('classifies historical rows repeatably and freezes known replies once', async () => {
    const f = fixture(); f.seed({ replyBody: 'Historical known reply.', state: 'reply_ready' });
    expect(f.store.audit()).toEqual(f.store.audit());
    expect(f.store.audit()[0]?.classification).toBe('freeze_known_reply');
    await f.make('boot-1').processTurnNow('turn-1');
    expect(f.store.get('turn-1')).toMatchObject({ state: 'published', replyBody: 'Historical known reply.' });
  });

  test('migrates historical binding and local publication evidence deterministically', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-direct-history-')); roots.push(root); const path = join(root, 'history.sqlite');
    const db = new Database(path);
    db.exec(`CREATE TABLE agent_direct_chat_turns (turn_id TEXT PRIMARY KEY,routing_key TEXT NOT NULL,source_message_ids_json TEXT NOT NULL,
      client_request_id TEXT NOT NULL UNIQUE,reply_body TEXT,published_message_id TEXT,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE chat_intercept_state (routing_key TEXT PRIMARY KEY,subscription_id TEXT,agent_id TEXT,session_id TEXT,tower_service_npub TEXT,
      workspace_id TEXT,source_app_npub TEXT,channel_id TEXT,thread_id TEXT,target_bot_npub TEXT);
      CREATE TABLE workspace_subscriptions (subscription_id TEXT PRIMARY KEY,backend_base_url TEXT,tower_service_npub TEXT,workspace_id TEXT,source_app_npub TEXT);
      CREATE TABLE flightdeck_session_turn_publications (turn_id TEXT PRIMARY KEY,session_id TEXT,prompt TEXT,client_request_id TEXT,reply_body TEXT,published_message_id TEXT,state TEXT,updated_at TEXT);`);
    db.query("INSERT INTO chat_intercept_state VALUES ('route','sub','exampleAgent','session','tower','workspace','app','channel','thread','agent')").run();
    db.query("INSERT INTO workspace_subscriptions VALUES ('sub','https://tower.test','tower','workspace','app')").run();
    db.query("INSERT INTO agent_direct_chat_turns VALUES ('same','route','[\"m1\"]','client-same','Reply',NULL,'reply_ready','2026-01-01T00:00:00Z','2026-01-01T00:00:01Z')").run();
    db.query("INSERT INTO flightdeck_session_turn_publications VALUES ('same','session','prompt','client-same','Reply','message-1','completed','2026-01-01T00:00:02Z')").run();
    db.close();
    const first = new DirectChatTurnStore(path); const second = new DirectChatTurnStore(path);
    expect(first.get('same')).toMatchObject({ state: 'published', publishedMessageId: 'message-1', backendBaseUrl: 'https://tower.test',
      subscriptionId: 'sub', threadId: 'thread', agentNpub: 'agent' });
    expect(second.get('same')).toEqual(first.get('same'));
  });

  test('degrades delivery health when durable backlog age crosses thresholds despite healthy transport', () => {
    const f = fixture(); f.seed({ state: 'reply_ready', replyBody: 'Backlogged.', replyReadyAt: '2026-07-28T23:59:00.000Z' });
    const health = f.store.getHealth('sub-1', Date.parse('2026-07-29T00:01:00.000Z'), { replyDegradedMs: 30_000, replyUnhealthyMs: 300_000 });
    expect(health.healthStatus).toBe('degraded');
    expect(health.oldestReplyReadyAgeMs).toBe(120_000);
  });
});
