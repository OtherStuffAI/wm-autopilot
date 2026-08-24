import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

import { AgentDefinitionStore } from './agent-definition-store';
import { AgentProfilePolicyStore } from './agent-profile-policy-store';
import { BackendConnectionStore } from './backend-connection-store';
import { DispatchPipelineRuntime } from './dispatch-pipelines/runtime';
import { DispatchRouteStore } from './dispatch-pipelines/route-store';
import { WorkspaceSubscriptionManager } from './subscription-runtime';
import { WorkspaceSubscriptionStore } from './workspace-subscription-store';
import { encodeFlightDeckPgEventCursor } from './tower-client';
import { PipelineStore } from '../pipelines/pipeline-store';
import { BrokerKeyNotProvisionedError } from '../signing/broker-key-vault';
import type {
  AgentDefinitionRecord,
  BackendConnectionRecord,
  BotKeyStoreRecord,
  RuntimeBotIdentity,
  WorkspaceSubscriptionRecord,
} from './types';
import type { WingmanInstanceIdentity } from '../identity/wingman-instance-identity';

function makeTempDb(): string {
  return join(tmpdir(), `agent-chat-subscription-runtime-${randomUUID()}.sqlite`);
}

function encodeToken(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function makeSignedInstructionIdentity() {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  return {
    secretKey,
    pubkey,
    npub: nip19.npubEncode(pubkey),
  };
}

function makeInstructionSignature(input: {
  body: string;
  signer: ReturnType<typeof makeSignedInstructionIdentity>;
  workspaceId?: string;
  channelId?: string;
  threadId?: string;
}) {
  const bodySha256 = createHash('sha256').update(input.body, 'utf8').digest('hex');
  const tags = [
    ['protocol', 'flightdeck_pg_message_instruction'],
    ['body_sha256', bodySha256],
  ];
  if (input.workspaceId) tags.push(['workspace_id', input.workspaceId]);
  if (input.channelId) tags.push(['channel_id', input.channelId]);
  if (input.threadId) tags.push(['thread_id', input.threadId]);
  const event = finalizeEvent({
    kind: 33358,
    created_at: 1_781_000_000,
    tags,
    content: input.body,
  }, input.signer.secretKey);
  return {
    version: 1,
    protocol: 'flightdeck_pg_message_instruction',
    kind: 33358,
    signer_npub: input.signer.npub,
    body_sha256: bodySha256,
    nostr_event: event,
  };
}

function makeConnectPackage(overrides: Record<string, unknown> = {}) {
  const connectionToken = encodeToken({
    direct_https_url: 'https://tower.example.com',
    service_npub: 'npub1service',
    workspace_owner_npub: 'npub1workspace',
    app_npub: 'npub1sourceapp',
  });
  return {
    kind: 'coworker_agent_connect',
    version: 5,
    generated_at: '2026-05-05T00:00:00.000Z',
    service: {
      direct_https_url: 'https://tower.example.com',
      service_npub: 'npub1service',
      health_url: 'https://tower.example.com/health',
    },
    workspace: { owner_npub: 'npub1workspace' },
    app: { app_npub: 'npub1sourceapp' },
    connection_token: connectionToken,
    capabilities: ['chat_intercept'],
    ...overrides,
  };
}

function makeConnectPackageForWorkspace(workspaceId: string, workspaceServiceNpub: string) {
  return makeConnectPackage({
    workspace: {
      owner_npub: 'npub1workspace',
      workspace_id: workspaceId,
      workspace_service_npub: workspaceServiceNpub,
    },
  });
}

function makeRevokedAccessGrant(input: {
  eventId: string;
  workspaceId: string;
  workspaceServiceNpub: string;
  action?: 'revoked' | 'deleted';
  reason?: string;
}) {
  return {
    event: { id: input.eventId },
    recipientNpub: 'npub1wingmanbot',
    payload: {
      action: input.action ?? 'deleted',
      app: { app_npub: 'npub1sourceapp', namespace: 'flightdeck_pg' },
      service: {
        direct_https_url: 'https://tower.example.com',
        service_npub: 'npub1service',
      },
      workspace: {
        owner_npub: 'npub1workspace',
        workspace_service_npub: input.workspaceServiceNpub,
        workspace_id: input.workspaceId,
      },
      revocation: { reason: input.reason ?? 'workspace_deleted' },
    },
    serviceNpub: 'npub1service',
    workspaceServiceNpub: input.workspaceServiceNpub,
    workspaceOwnerNpub: 'npub1workspace',
    appNpub: 'npub1sourceapp',
  };
}

function makeBotKeyRecord(botNpub: string): BotKeyStoreRecord {
  const now = new Date().toISOString();
  return {
    id: `key-${botNpub}`,
    userNpub: 'npub1manager',
    botPubkeyHex: `${botNpub.slice(-2) || 'ab'}`.padEnd(64, 'a').slice(0, 64),
    botNpub,
    displayName: botNpub,
    encryptedToUser: 'encrypted-user',
    encryptedEscrow: 'encrypted-escrow',
    escrowUuid: 'escrow-1',
    isActive: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function makeInstanceIdentity(overrides: Partial<WingmanInstanceIdentity> = {}): WingmanInstanceIdentity {
  const secretKey = new Uint8Array(32);
  secretKey[0] = 1;
  return {
    nsec: 'nsec1wingman',
    nsecHex: '01'.padEnd(64, '0'),
    secretKey,
    pubkeyHex: 'f'.repeat(64),
    npub: 'npub1wingmanbot',
    displayName: 'wingman-bot',
    source: 'env',
    ...overrides,
  };
}

const ATHENA_BOT_NPUB = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzqunz0d4';

function createTestManager(
  dbPath: string,
  botKeys: Map<string, BotKeyStoreRecord>,
  checkBackendHealth?: ConstructorParameters<typeof WorkspaceSubscriptionManager>[0]['checkBackendHealth'],
  instanceIdentity: WingmanInstanceIdentity | null = null,
  dispatchPipelineRuntime?: ConstructorParameters<typeof WorkspaceSubscriptionManager>[0]['dispatchPipelineRuntime'],
  overrides: Partial<ConstructorParameters<typeof WorkspaceSubscriptionManager>[0]> = {},
) {
  const store = new WorkspaceSubscriptionStore(dbPath);
  const agentStore = new AgentDefinitionStore(dbPath);
  const backendStore = new BackendConnectionStore(dbPath);
  const profilePolicyStore = new AgentProfilePolicyStore(dbPath);
  const manager = new WorkspaceSubscriptionManager({
    store,
    agentStore,
    backendStore,
    profilePolicyStore,
    checkBackendHealth: checkBackendHealth ?? (async (record) => ({
      healthStatus: record.healthUrl ? 'healthy' : 'degraded',
      diagnostic: {
        ok: Boolean(record.healthUrl),
        code: record.healthUrl ? null : 'backend_health_unavailable',
        message: record.healthUrl ? 'Backend health check passed.' : 'Backend connection has no health URL.',
        at: new Date().toISOString(),
        details: { health_url: record.healthUrl },
      },
    })),
    fetchFlightDeckPgWorkspaceMe: async () => ({
      actor: { actor_id: 'actor-bot' },
      membership: { role: 'member' },
      permissions: ['workspace.read'],
    }),
    fetchFlightDeckPgEvents: async () => ({ events: [], next_cursor: null }),
    reconcileFlightDeckPgEventSubscriptionAgents: async ({ agentNpubs }) => ({ agent_npubs: [...agentNpubs].sort() }),
    fetchFlightDeckPgChannelMessages: async () => ({ messages: [], next_cursor: null }),
    fetchFlightDeckPgWorkroomContext: async () => ({ isWorkroom: false, workroom: null, participant: null, appTargets: [], recentEvents: [], recentLinks: [], openApprovals: [] }),
    botKeyStore: {
      getActiveKeyForUser: () => null,
      getActiveKeyForBotNpub: (botNpub) => botKeys.get(botNpub) ?? null,
    },
    brokerKeyVault: {
      provision: () => undefined,
      remove: async () => undefined,
      withKey: async (_record, operation) => operation(new Uint8Array(32)),
    },
    getInstanceIdentity: () => instanceIdentity,
    dispatchPipelineRuntime,
    dispatchAgentWorkingDirectory: join(tmpdir(), 'wingman-dispatch-agent'),
    ...overrides,
  });

  const managerInternals = manager as unknown as {
    prepareWorkspaceSession: (record: WorkspaceSubscriptionRecord, botIdentity: RuntimeBotIdentity) => Promise<WorkspaceSubscriptionRecord>;
    registerWorkspaceKey: (record: WorkspaceSubscriptionRecord) => Promise<WorkspaceSubscriptionRecord>;
    refreshGroupKeys: (record: WorkspaceSubscriptionRecord) => Promise<WorkspaceSubscriptionRecord>;
    ensureConnected: (record: WorkspaceSubscriptionRecord) => Promise<void>;
    reconcileFlightDeckAudience: (
      record: WorkspaceSubscriptionRecord,
      botIdentity: RuntimeBotIdentity,
    ) => Promise<string[]>;
    resolveStoredBotIdentity: (botNpub: string) => Promise<RuntimeBotIdentity | null>;
  };
  managerInternals.prepareWorkspaceSession = async (record) => store.save({
    ...record,
    wsKeyNpub: `ws-${record.botNpub}`,
    wsKeyBlobJson: JSON.stringify({ bot: record.botNpub }),
  });
  managerInternals.registerWorkspaceKey = async (record) => store.save({
    ...record,
    wsKeyStatus: 'active',
    lastAuthOkAt: new Date().toISOString(),
  });
  managerInternals.refreshGroupKeys = async (record) => store.save({
    ...record,
    groupKeyStatus: 'active',
    healthStatus: 'healthy',
    wrappedGroupKeysJson: JSON.stringify([{ group_npub: `group-${record.botNpub}` }]),
  });
  managerInternals.ensureConnected = async (record) => {
    store.save({
      ...record,
      sseStatus: 'connected',
      healthStatus: 'healthy',
    });
  };

  return { manager, store, agentStore, backendStore, profilePolicyStore, managerInternals };
}

function saveAgent(agentStore: AgentDefinitionStore, input: Partial<AgentDefinitionRecord> & { agentId: string; botNpub: string; managedByNpub: string }) {
  const now = new Date().toISOString();
  agentStore.save({
    agentId: input.agentId,
    label: input.label ?? input.agentId,
    botNpub: input.botNpub,
    workspaceOwnerNpub: input.workspaceOwnerNpub ?? 'npub1workspace',
    groupNpubs: input.groupNpubs ?? ['npub1group'],
    workingDirectory: input.workingDirectory ?? `/tmp/${input.agentId}`,
    directChat: input.directChat,
    capabilities: input.capabilities ?? ['chat_intercept'],
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    managedByNpub: input.managedByNpub,
  });
}

function saveDirectChatAgent(
  agentStore: AgentDefinitionStore,
  input: { agentId: string; botNpub: string; managedByNpub: string },
): void {
  saveAgent(agentStore, {
    ...input,
    directChat: {
      enabled: true,
      sessionAgent: 'codex',
      directory: `/tmp/${input.agentId}`,
      model: null,
      idleRetentionMinutes: 60,
    },
  });
}

function saveBackendConnection(
  backendStore: BackendConnectionStore,
  input: Partial<BackendConnectionRecord> & { managedByNpub: string },
): BackendConnectionRecord {
  return backendStore.save({
    ...backendStore.createDefault({
      managedByNpub: input.managedByNpub,
      backendBaseUrl: input.backendBaseUrl ?? 'https://tower.example.com',
      serviceNpub: input.serviceNpub ?? 'npub1service',
      healthUrl: input.healthUrl ?? 'https://tower.example.com/health',
    }),
    ...input,
  });
}

describe('WorkspaceSubscriptionManager', () => {
  test('keeps one Flight Deck subscription and reconciles its enabled Agent Direct audience', async () => {
    const dbPath = makeTempDb();
    const BuilderRecord = {
      ...makeBotKeyRecord('npub1Builder'),
      encryptedEscrow: '',
      escrowUuid: '',
    };
    const botKeys = new Map([
      ['npub1base', makeBotKeyRecord('npub1base')],
      ['npub1Builder', BuilderRecord],
    ]);
    const vaultResolutions: string[] = [];
    const signingNpubs: string[] = [];
    const reconciledAudiences: string[][] = [];
    const { manager, store, agentStore } = createTestManager(dbPath, botKeys, undefined, null, undefined, {
      brokerKeyVault: {
        provision: () => undefined,
        remove: async () => undefined,
        withKey: async (record, operation) => {
          vaultResolutions.push(record.botNpub);
          return operation(new Uint8Array(32));
        },
      },
      fetchFlightDeckPgWorkspaceMe: async ({ botIdentity }) => {
        signingNpubs.push(botIdentity.botNpub);
        return { actor: { actor_id: 'actor-bot' }, membership: { role: 'member' }, permissions: ['workspace.read'] };
      },
      reconcileFlightDeckPgEventSubscriptionAgents: async ({ agentNpubs }) => {
        reconciledAudiences.push(agentNpubs);
        return { agent_npubs: [...agentNpubs].sort() };
      },
    });
    const base = store.save(store.createDefault({
      managedByNpub: 'npub1manager', workspaceOwnerNpub: 'npub1manager',
      backendBaseUrl: 'https://tower.example.com', towerServiceNpub: 'npub1tower',
      workspaceId: 'workspace-1', workspaceServiceNpub: 'npub1workspace',
      botNpub: 'npub1base', sourceAppNpub: 'npub1app',
    }));
    const now = new Date().toISOString();
    agentStore.save({
      agentId: 'Builder', label: 'Builder', botNpub: 'npub1Builder', workspaceOwnerNpub: 'npub1manager',
      groupNpubs: [], workingDirectory: '/tmp/Builder', capabilities: ['chat_intercept'], enabled: true,
      directChat: { enabled: true, sessionAgent: 'goose', directory: '/tmp/Builder', model: null, idleRetentionMinutes: 60 },
      createdAt: now, updatedAt: now, managedByNpub: 'npub1manager',
    });

    await manager.startupReload();

    const subscriptions = store.listForManagerNpub('npub1manager');
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.subscriptionId).toBe(base.subscriptionId);
    const baseIdentity = manager.getRuntimeBotIdentity(base.subscriptionId)!;
    await (manager as unknown as {
      reconcileFlightDeckAudience: (record: WorkspaceSubscriptionRecord, identity: RuntimeBotIdentity) => Promise<string[]>;
    }).reconcileFlightDeckAudience(subscriptions[0]!, baseIdentity);
    expect(reconciledAudiences).toContainEqual(['npub1Builder']);
    expect(vaultResolutions).not.toContain('npub1Builder');
    expect(signingNpubs).toContain('npub1base');
    const Builder = agentStore.getByAgentId('Builder')!;
    agentStore.save({ ...Builder, enabled: false, updatedAt: new Date().toISOString() });
    await (manager as unknown as {
      reconcileFlightDeckAudience: (record: WorkspaceSubscriptionRecord, identity: RuntimeBotIdentity) => Promise<string[]>;
    }).reconcileFlightDeckAudience(base, {
      botNpub: 'npub1base', botPubkeyHex: 'a'.repeat(64), botSecret: new Uint8Array(32),
    });
    expect(reconciledAudiences.at(-1)).toEqual([]);
    const BuilderIdentity = await (manager as unknown as {
      resolveStoredBotIdentity: (botNpub: string) => Promise<RuntimeBotIdentity | null>;
    }).resolveStoredBotIdentity('npub1Builder');
    expect(vaultResolutions).toContain('npub1Builder');
    expect(BuilderIdentity?.botNpub).toBe('npub1Builder');
  });

  test('continues with Tower accepted profiles and records rejected audience diagnostics', async () => {
    const dbPath = makeTempDb();
    const { manager, store, agentStore, managerInternals } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      null,
      undefined,
      {
        reconcileFlightDeckPgEventSubscriptionAgents: async () => ({
          agent_npubs: ['npub1Builder'],
          audience_npubs: ['npub1Builder'],
          rejected_audience: [{ npub: 'npub1Mick', code: 'inactive_or_unknown_workspace_member' }],
        }),
      },
    );
    const subscription = store.save(store.createDefault({
      managedByNpub: 'npub1manager', workspaceOwnerNpub: 'npub1manager',
      backendBaseUrl: 'https://tower.example.com', towerServiceNpub: 'npub1tower',
      workspaceId: 'workspace-1', workspaceServiceNpub: 'npub1workspace',
      botNpub: 'npub1base', sourceAppNpub: 'npub1app',
    }));
    saveDirectChatAgent(agentStore, { agentId: 'Builder', botNpub: 'npub1Builder', managedByNpub: 'npub1manager' });
    saveDirectChatAgent(agentStore, { agentId: 'Mick', botNpub: 'npub1Mick', managedByNpub: 'npub1manager' });

    const accepted = await managerInternals.reconcileFlightDeckAudience(subscription, {
      botNpub: 'npub1base', botPubkeyHex: 'a'.repeat(64), botSecret: new Uint8Array(32),
    });

    expect(accepted).toEqual(['npub1Builder']);
    expect(store.getBySubscriptionId(subscription.subscriptionId)?.lastRoutingResult).toMatchObject({
      code: 'flightdeck_pg_event_subscription_audience_partial',
      details: {
        accepted_npubs: ['npub1Builder'],
        rejected_audience: [{ npub: 'npub1Mick', code: 'inactive_or_unknown_workspace_member' }],
      },
    });
  });

  test('fails retryably with a persisted diagnostic when Tower accepts no configured profiles', async () => {
    const dbPath = makeTempDb();
    const { store, agentStore, managerInternals } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      null,
      undefined,
      {
        reconcileFlightDeckPgEventSubscriptionAgents: async () => ({
          agent_npubs: [],
          audience_npubs: [],
          rejected_audience: [{ npub: 'npub1Mick', code: 'inactive_or_unknown_workspace_member' }],
        }),
      },
    );
    const subscription = store.save(store.createDefault({
      managedByNpub: 'npub1manager', workspaceOwnerNpub: 'npub1manager',
      backendBaseUrl: 'https://tower.example.com', towerServiceNpub: 'npub1tower',
      workspaceId: 'workspace-1', workspaceServiceNpub: 'npub1workspace',
      botNpub: 'npub1base', sourceAppNpub: 'npub1app',
    }));
    saveDirectChatAgent(agentStore, { agentId: 'Mick', botNpub: 'npub1Mick', managedByNpub: 'npub1manager' });

    await expect(managerInternals.reconcileFlightDeckAudience(subscription, {
      botNpub: 'npub1base', botPubkeyHex: 'a'.repeat(64), botSecret: new Uint8Array(32),
    })).rejects.toMatchObject({
      detailCode: 'flightdeck_pg_event_subscription_audience_empty',
      retryable: true,
    });
    expect(store.getBySubscriptionId(subscription.subscriptionId)?.lastRoutingResult).toMatchObject({
      code: 'flightdeck_pg_event_subscription_audience_empty',
      details: {
        rejected_audience: [{ npub: 'npub1Mick', code: 'inactive_or_unknown_workspace_member' }],
        retryable: true,
      },
    });
  });

  test('fails profile runtime identity resolution closed when the broker vault is not provisioned', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([
      ['npub1base', makeBotKeyRecord('npub1base')],
      ['npub1Builder', { ...makeBotKeyRecord('npub1Builder'), encryptedEscrow: '', escrowUuid: '' }],
    ]);
    const { manager, store, agentStore } = createTestManager(dbPath, botKeys, undefined, null, undefined, {
      brokerKeyVault: {
        provision: () => undefined,
        remove: async () => undefined,
        withKey: async (record, operation) => {
          if (record.botNpub === 'npub1Builder') {
            throw new BrokerKeyNotProvisionedError(record.userNpub, record.botNpub);
          }
          return operation(new Uint8Array(32));
        },
      },
    });
    store.save(store.createDefault({
      managedByNpub: 'npub1manager', workspaceOwnerNpub: 'npub1manager',
      backendBaseUrl: 'https://tower.example.com', towerServiceNpub: 'npub1tower',
      workspaceId: 'workspace-1', workspaceServiceNpub: 'npub1workspace',
      botNpub: 'npub1base', sourceAppNpub: 'npub1app',
    }));
    saveAgent(agentStore, { agentId: 'Builder', botNpub: 'npub1Builder', managedByNpub: 'npub1manager', directChat: {
      enabled: true, sessionAgent: 'goose', directory: '/tmp/Builder', model: null, idleRetentionMinutes: 60,
    } });

    await manager.startupReload();

    expect(store.listForManagerNpub('npub1manager').some((record) => record.botNpub === 'npub1Builder')).toBe(false);
    await expect((manager as unknown as {
      resolveStoredBotIdentity: (botNpub: string) => Promise<RuntimeBotIdentity | null>;
    }).resolveStoredBotIdentity('npub1Builder')).rejects.toMatchObject({
      code: 'broker_key_not_provisioned',
      botNpub: 'npub1Builder',
    });
  });

  test('does not advance the SSE resume point from connected event payload cursors', async () => {
    const dbPath = makeTempDb();
    const store = new WorkspaceSubscriptionStore(dbPath);
    const manager = new WorkspaceSubscriptionManager({
      store,
      botKeyStore: {
        getActiveKeyForUser: () => null,
        getActiveKeyForBotNpub: () => null,
      },
    });
    const record = store.save(store.createDefault({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      botNpub: 'npub1bot',
      sourceAppNpub: 'npub1sourceapp',
    }));

    const next = await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(record, null, 'connected', JSON.stringify({ event_id: 1011 }));

    expect(next.lastSseEventId).toBeNull();
    expect(store.getBySubscriptionId(record.subscriptionId)?.lastSseEventId).toBeNull();
  });

  test('retries failed chat advisory pulls and keeps the prior SSE cursor for replay', async () => {
    const dbPath = makeTempDb();
    const store = new WorkspaceSubscriptionStore(dbPath);
    let pullAttempts = 0;
    let reconnectRequested = false;
    const manager = new WorkspaceSubscriptionManager({
      store,
      chatRecordPullMaxAttempts: 3,
      chatRecordPullRetryDelayMs: 1,
      chatRecordPullTimeoutMs: 50,
      fetchRecordHistory: async () => {
        pullAttempts += 1;
        throw Object.assign(new Error('Tower did not return the record in time.'), {
          detailCode: 'chat_record_pull_timeout',
        });
      },
      botKeyStore: {
        getActiveKeyForUser: () => null,
        getActiveKeyForBotNpub: () => null,
      },
    });
    const record = store.save({
      ...store.createDefault({
        managedByNpub: 'npub1manager',
        workspaceOwnerNpub: 'npub1workspace',
        backendBaseUrl: 'https://tower.example.com',
        botNpub: 'npub1bot',
        sourceAppNpub: 'npub1sourceapp',
      }),
      wsKeyStatus: 'active',
      groupKeyStatus: 'active',
      sseStatus: 'connected',
      lastSseEventId: '72',
    });
    (manager as unknown as { runtimes: Map<string, unknown> }).runtimes.set(record.subscriptionId, {
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
      groupKeys: null,
      wrappedKeyRows: [],
      removed: false,
    });
    (manager as unknown as { reconnectForReplay: (subscriptionId: string, reason: string) => Promise<void> }).reconnectForReplay = async (
      subscriptionId,
      reason,
    ) => {
      reconnectRequested = subscriptionId === record.subscriptionId && reason === 'chat_record_pull_timeout';
    };

    await (manager as unknown as {
      handleSseEvent: (
        record: WorkspaceSubscriptionRecord,
        eventId: string | null,
        eventType: string,
        eventData: string,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).handleSseEvent(record, '73', 'record-changed', JSON.stringify({
      family_hash: 'npub1sourceapp:chat_message',
      record_id: 'aaa47a6d-05f8-48b7-bbe0-5801e56cdb49',
      version: 1,
      record_state: 'active',
    }));

    const saved = store.getBySubscriptionId(record.subscriptionId)!;
    expect(pullAttempts).toBe(3);
    expect(saved.lastSseEventId).toBe('72');
    expect(saved.lastRecordPullResult).toMatchObject({
      ok: false,
      code: 'record_pull_failed',
      details: {
        record_id: 'aaa47a6d-05f8-48b7-bbe0-5801e56cdb49',
        pull_attempts: 3,
        failed_event_id: '73',
        replay_from_event_id: '72',
      },
    });
    expect(saved.lastRoutingResult).toMatchObject({
      ok: false,
      message: 'Routing skipped because the chat record could not be pulled.',
    });
    expect(reconnectRequested).toBe(true);
  });

  test('derives agent groups from refreshed wrapped group keys when none are supplied', async () => {
    const dbPath = makeTempDb();
    const store = new WorkspaceSubscriptionStore(dbPath);
    const agentStore = new AgentDefinitionStore(dbPath);
    const manager = new WorkspaceSubscriptionManager({
      store,
      agentStore,
      botKeyStore: {
        getActiveKeyForUser: () => null,
        getActiveKeyForBotNpub: () => null,
      },
    });

    const now = new Date().toISOString();
    store.save({
      subscriptionId: 'sub-1',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      botNpub: 'npub1botshared',
      sourceAppNpub: 'npub1sourceapp',
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
      wrappedGroupKeysJson: JSON.stringify([
        { group_npub: 'npub1groupb' },
        { group_npub: 'npub1groupa' },
        { group_npub: 'npub1groupa' },
        {},
      ]),
      lastAuthResult: null,
      lastGroupRefreshResult: null,
      lastRecordPullResult: null,
      lastDecryptResult: null,
      lastRoutingResult: null,
      lastSseEvent: null,
      recentSseEvents: [],
      recentDispatches: [],
      lastSuccessfulStartupReloadAt: null,
    });

    const record = await manager.saveAgentForManager({
      managedByNpub: 'npub1manager',
      agentId: 'agent_auto',
      label: 'Auto Agent',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: [],
      workingDirectory: '/tmp/agent-auto',
      capabilities: ['chat_intercept'],
      enabled: true,
    });

    expect(record.groupNpubs).toEqual(['npub1groupa', 'npub1groupb']);
  });

  test('saves a Flight Deck PG agent without legacy group keys', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity();
    const { manager, agentStore } = createTestManager(dbPath, new Map(), undefined, instanceIdentity);
    await manager.createOrUpdate({
      managedByNpub: 'npub1manager', workspaceOwnerNpub: 'npub1owner', workspaceServiceNpub: 'npub1workspace-service',
      workspaceId: 'workspace-pg', backendBaseUrl: 'https://tower.example.com', sourceAppNpub: 'npub1sourceapp',
      onboardingSource: 'nostr_33357',
    });
    const onboarded = agentStore.getByBotNpub(instanceIdentity.npub)!;
    const saved = await manager.saveAgentForManager({ managedByNpub: 'npub1manager', agentId: onboarded.agentId, label: 'Athena',
      botNpub: instanceIdentity.npub, workspaceOwnerNpub: 'npub1workspace-service', workingDirectory: '/tmp/athena',
      capabilities: ['chat_intercept', 'task_dispatch'], directChat: { enabled: true, sessionAgent: 'codex',
        directory: '/tmp/athena', model: null, idleRetentionMinutes: 60 }, enabled: true });
    expect(saved.groupNpubs).toEqual([]);
    expect(saved.directChat).toMatchObject({ sessionAgent: 'codex', directory: '/tmp/athena' });
    expect(saved.capabilities).toEqual(['chat_intercept', 'task_dispatch']);
  });

  test('imports the same Agent Connect workspace for two owned profiles with separate bot identities', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([
      ['npub1botone', makeBotKeyRecord('npub1botone')],
      ['npub1bottwo', makeBotKeyRecord('npub1bottwo')],
    ]);
    const { manager, store, agentStore, backendStore, profilePolicyStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });
    saveAgent(agentStore, { agentId: 'wm-two', botNpub: 'npub1bottwo', managedByNpub: 'npub1manager' });

    const first = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage(),
      agentProfileId: 'wm-one',
    });
    const second = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage(),
      agentProfileId: 'wm-two',
    });

    expect(first.subscription.subscriptionId).not.toBe(second.subscription.subscriptionId);
    expect(first.subscription.agentProfileId).toBe('wm-one');
    expect(second.subscription.agentProfileId).toBe('wm-two');
    expect(first.subscription.onboardingSource).toBe('agent_connect_import');
    expect(second.subscription.onboardingSource).toBe('agent_connect_import');
    expect(first.subscription.botNpub).toBe('npub1botone');
    expect(second.subscription.botNpub).toBe('npub1bottwo');
    expect(store.listForManagerNpub('npub1manager')).toHaveLength(2);
    expect(backendStore.listForManagerNpub('npub1manager')[0]?.healthStatus).toBe('healthy');

    const firstWorkspaces = profilePolicyStore.listWorkspacesForProfile('wm-one', 'npub1manager');
    const secondWorkspaces = profilePolicyStore.listWorkspacesForProfile('wm-two', 'npub1manager');
    expect(firstWorkspaces).toHaveLength(1);
    expect(secondWorkspaces).toHaveLength(1);
    expect(firstWorkspaces[0]).toMatchObject({
      subscriptionId: first.subscription.subscriptionId,
      profileId: 'wm-one',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1sourceapp',
      relayOnboardingStatus: 'ready',
    });
    expect(secondWorkspaces[0]).toMatchObject({
      subscriptionId: second.subscription.subscriptionId,
      profileId: 'wm-two',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1sourceapp',
      relayOnboardingStatus: 'ready',
    });
    expect(profilePolicyStore.listPolicies(firstWorkspaces[0]!.profileWorkspaceId)).toHaveLength(12);
    expect(profilePolicyStore.listPolicies(secondWorkspaces[0]!.profileWorkspaceId)).toHaveLength(12);
  });

  test('imports wrapped Agent Connect text without a profile when WINGMAN_PRIV is configured', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity();
    const { manager, store, backendStore, profilePolicyStore, agentStore } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
    );

    const tokenText = [
      '======AGENTCONNECT-TOKEN======',
      JSON.stringify(makeConnectPackage(), null, 2),
      '======AGENTCONNECT-TOKEN======',
    ].join('\n');

    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: tokenText,
    });

    expect(imported.subscription.botNpub).toBe(instanceIdentity.npub);
    expect(imported.subscription.agentProfileId).toBeNull();
    expect(imported.subscription.onboardingSource).toBe('agent_connect_import');
    expect(imported.subscription.sseStatus).toBe('connected');
    expect(store.listForManagerNpub('npub1manager')).toHaveLength(1);
    expect(backendStore.listForManagerNpub('npub1manager')[0]?.healthStatus).toBe('healthy');

    const identityWorkspaces = profilePolicyStore.listWorkspacesForProfile(instanceIdentity.npub, 'npub1manager');
    expect(identityWorkspaces).toHaveLength(1);
    expect(identityWorkspaces[0]).toMatchObject({
      subscriptionId: imported.subscription.subscriptionId,
      profileId: instanceIdentity.npub,
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1sourceapp',
      relayOnboardingStatus: 'ready',
    });
    expect(profilePolicyStore.listPolicies(identityWorkspaces[0]!.profileWorkspaceId)).toHaveLength(12);
    expect(agentStore.listByWorkspaceAndBot('npub1workspace', instanceIdentity.npub)).toHaveLength(0);
  });

  test('promotes an existing manual subscription when 33357 onboarding imports it', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity();
    const { manager, store, agentStore } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
    );

    const manual = await manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      towerServiceNpub: 'npub1service',
      sourceAppNpub: 'npub1sourceapp',
    });

    expect(manual.onboardingSource).toBe('manual');

    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage(),
      onboardingSource: 'nostr_33357',
    });

    expect(imported.subscription.subscriptionId).toBe(manual.subscriptionId);
    expect(imported.subscription.onboardingSource).toBe('nostr_33357');
    expect(store.getBySubscriptionId(manual.subscriptionId)?.onboardingSource).toBe('nostr_33357');
    const agents = agentStore.listByWorkspaceAndBot('npub1workspace', instanceIdentity.npub);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.groupNpubs).toEqual([`group-${instanceIdentity.npub}`]);
    expect(agents[0]?.capabilities.toSorted()).toEqual(['chat_intercept', 'comment_dispatch', 'task_dispatch']);
  });

  test('seeds default dispatch routes from Agent Connect capability defaults', async () => {
    const dbPath = makeTempDb();
    const routeStore = new DispatchRouteStore(dbPath);
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      pipelineStore: new PipelineStore(makeTempDb()),
      getSessionApiContext: () => null,
      callbackOrigin: 'http://localhost:3600',
      requirePipelineRoutes: true,
    });
    const { manager, agentStore } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      makeInstanceIdentity(),
      dispatchPipelineRuntime,
    );

    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage({
        capabilities: ['chat_intercept', 'task_dispatch'],
        workspace: {
          owner_npub: 'npub1workspace',
          workspace_id: 'workspace-1',
          workspace_service_npub: 'npub1workspaceservice',
          label: 'Wingmen',
        },
      }),
      onboardingSource: 'nostr_33357',
    });

    expect(imported.subscription.onboardingSource).toBe('nostr_33357');
    expect(imported.subscription.workspaceId).toBe('workspace-1');
    expect(imported.subscription.workspaceServiceNpub).toBe('npub1workspaceservice');
    expect(agentStore.listByWorkspaceAndBot('npub1workspace', imported.subscription.botNpub)).toHaveLength(1);
    expect(agentStore.listByWorkspaceAndBot('npub1workspaceservice', imported.subscription.botNpub)).toHaveLength(1);
    const routes = routeStore.listForSubscription(imported.subscription.subscriptionId);
    expect([...new Set(routes.map((route) => route.workspaceOwnerNpub))]).toEqual(['npub1workspaceservice']);
    expect(routes.map((route) => `${route.triggerKind}:${route.capability}`).sort()).toEqual([
      'chat:chat_intercept',
      'comment:comment_dispatch',
      'task:task_dispatch',
    ]);
    expect(routes.map((route) => route.pipelineDefinitionId).sort()).toEqual([
      'fd-agent-dispatch-chat',
      'fd-agent-dispatch-comment-response',
      'fd-agent-dispatch-task-response',
    ]);
  });

  test('creates a 33357 Flight Deck workspace agent without v4 workspace key registration', async () => {
    const dbPath = makeTempDb();
    const routeStore = new DispatchRouteStore(dbPath);
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      pipelineStore: new PipelineStore(makeTempDb()),
      getSessionApiContext: () => null,
      callbackOrigin: 'http://localhost:3600',
      requirePipelineRoutes: true,
    });
    const instanceIdentity = makeInstanceIdentity();
    const { manager, agentStore, managerInternals } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
      dispatchPipelineRuntime,
    );
    let registerCalled = false;
    managerInternals.registerWorkspaceKey = async () => {
      registerCalled = true;
      throw Object.assign(new Error('user does not have access to this workspace'), {
        status: 403,
        detailCode: 'workspace_access_denied',
      });
    };

    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage({
        capabilities: ['chat_intercept', 'task_dispatch'],
        workspace: {
          owner_npub: 'npub1workspace',
          workspace_id: 'workspace-1',
          workspace_service_npub: 'npub1workspaceservice',
          label: 'Wingmen',
        },
      }),
      onboardingSource: 'nostr_33357',
    });

    expect(registerCalled).toBe(false);
    expect(imported.subscription.wsKeyStatus).toBe('active');
    expect(imported.subscription.healthStatus).toBe('healthy');
    expect(imported.subscription.workspaceServiceNpub).toBe('npub1workspaceservice');
    const agents = agentStore.listByWorkspaceAndBot('npub1workspaceservice', instanceIdentity.npub);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.groupNpubs).toEqual([]);
    expect(routeStore.listForSubscription(imported.subscription.subscriptionId)).toHaveLength(3);
  });

  test('createOrUpdate creates the auto agent for 33357 Flight Deck PG workspaces', async () => {
    const dbPath = makeTempDb();
    const routeStore = new DispatchRouteStore(dbPath);
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      pipelineStore: new PipelineStore(makeTempDb()),
      getSessionApiContext: () => null,
      callbackOrigin: 'http://localhost:3600',
      requirePipelineRoutes: true,
    });
    const instanceIdentity = makeInstanceIdentity();
    const { manager, agentStore, managerInternals } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
      dispatchPipelineRuntime,
    );
    let registerCalled = false;
    managerInternals.registerWorkspaceKey = async () => {
      registerCalled = true;
      throw new Error('legacy registration should not run for PG workspaces');
    };

    const subscription = await manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspaceowner',
      towerServiceNpub: 'npub1tower',
      workspaceId: 'workspace-1',
      workspaceServiceNpub: 'npub1workspaceservice',
      backendBaseUrl: 'https://tower.example.com',
      sourceAppNpub: 'npub1sourceapp',
      onboardingSource: 'nostr_33357',
      capabilityDefaults: ['chat_intercept', 'task_dispatch', 'comment_dispatch'],
    });

    expect(registerCalled).toBe(false);
    expect(subscription.healthStatus).toBe('healthy');
    expect(subscription.sseStatus).toBe('connected');
    const agents = agentStore.listByWorkspaceAndBot('npub1workspaceservice', instanceIdentity.npub);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.workingDirectory).toBe(join(tmpdir(), 'wingman-dispatch-agent'));
    expect(routeStore.listForSubscription(subscription.subscriptionId)).toHaveLength(3);
  });

  test('createOrUpdate migrates legacy private agent workspace directories to the dispatch directory', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity();
    const { manager, agentStore } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
    );
    const agentId = 'fd-npub1wingmanbot-workspace1-npub1sourceapp';
    saveAgent(agentStore, {
      agentId,
      botNpub: instanceIdentity.npub,
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspaceservice',
      groupNpubs: [],
      workingDirectory: `/repo/autopilot/data/agent-chat-workspaces/${agentId}`,
    });

    await manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspaceowner',
      towerServiceNpub: 'npub1tower',
      workspaceId: 'workspace-1',
      workspaceServiceNpub: 'npub1workspaceservice',
      backendBaseUrl: 'https://tower.example.com',
      sourceAppNpub: 'npub1sourceapp',
      onboardingSource: 'nostr_33357',
      capabilityDefaults: ['chat_intercept'],
    });

    expect(agentStore.getByAgentId(agentId)?.workingDirectory).toBe(join(tmpdir(), 'wingman-dispatch-agent'));
  });

  test('routes the live Athena person mention shape into Agent Direct Chat', async () => {
    const dbPath = makeTempDb();
    const directInputs: unknown[] = [];
    const instanceIdentity = makeInstanceIdentity({ npub: ATHENA_BOT_NPUB });
    const workspaceId = '6b39f051-3833-46e6-8a59-be9b4eb57639';
    const channelId = 'b59adb00-50a3-4f5e-92db-5831a4d31a95';
    const threadId = 'b6139d72-b6a0-4ca7-ae75-f114c48e11b6';
    const messageId = 'd3afc187-3ef1-4f1b-a7a5-25a35793d95e';
    const message = {
      id: messageId,
      workspace_id: workspaceId,
      channel_id: channelId,
      thread_id: threadId,
      body: '@Athena Lumia please handle this',
      mentions: [{ type: 'person', npub: ATHENA_BOT_NPUB, label: 'Athena Lumia' }],
      created_by_actor_id: 'actor-user',
      created_by_actor_npub: 'npub1human',
      created_at: '2026-07-26T00:00:00.000Z',
    };
    const { manager, store } = createTestManager(dbPath, new Map(), undefined, instanceIdentity, undefined, {
      chatRuntime: {
        handleDirectChat: async (input: unknown) => {
          directInputs.push(input);
          return { handled: true, reason: 'direct_chat_queued' };
        },
      } as never,
      fetchFlightDeckPgChannel: async () => ({ id: channelId, workspace_id: workspaceId, kind: 'channel', metadata: {} }),
      fetchFlightDeckPgChannelMessages: async () => ({ messages: [message], next_cursor: null }),
    });
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace(workspaceId, 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });

    const next = await (manager as unknown as {
      handleFlightDeckPgEvent: (record: WorkspaceSubscriptionRecord, event: Record<string, unknown>) => Promise<WorkspaceSubscriptionRecord>;
    }).handleFlightDeckPgEvent(imported.subscription, {
      id: '112', event_id: '112', cursor: encodeFlightDeckPgEventCursor(112), workspace_id: workspaceId,
      channel_id: channelId, actor_id: 'actor-user', event_type: 'flightdeck_pg.message.created',
      entity_type: 'message', entity_id: messageId, operation: 'created', entity_row_version: 1, row_version: 112,
      created_at: '2026-07-26T00:00:00.000Z', payload: {},
    });

    expect(directInputs).toHaveLength(1);
    expect(directInputs[0]).toMatchObject({
      subscription: { workspaceId, botNpub: ATHENA_BOT_NPUB },
      channel: { id: channelId },
      messages: [{ id: messageId, thread_id: threadId, mentions: [{ type: 'person', npub: ATHENA_BOT_NPUB, label: 'Athena Lumia' }] }],
    });
    expect(next.lastRoutingResult?.details).toMatchObject({ direct_chat_handled: true, direct_chat_reason: 'direct_chat_queued' });
    expect(store.getBySubscriptionId(imported.subscription.subscriptionId)?.lastRoutingResult?.details)
      .toMatchObject({ direct_chat_handled: true });
  });

  test('fails closed without visibility evidence and routes only to evidenced local profiles', async () => {
    const dbPath = makeTempDb();
    const directInputs: Array<{ audienceAgentNpubs?: string[] }> = [];
    const instanceIdentity = makeInstanceIdentity();
    const messages = [
      { id: 'message-1', channel_id: 'channel-1', thread_id: 'thread-1', body: 'For Builder' },
      { id: 'message-2', channel_id: 'channel-1', thread_id: 'thread-1', body: 'For Mick' },
    ];
    const botKeys = new Map([
      ['npub1Builder', makeBotKeyRecord('npub1Builder')],
      ['npub1Mick', makeBotKeyRecord('npub1Mick')],
    ]);
    const { manager, store, agentStore } = createTestManager(dbPath, botKeys, undefined, instanceIdentity, undefined, {
      chatRuntime: {
        handleDirectChat: async (input: { audienceAgentNpubs?: string[] }) => {
          directInputs.push(input);
          return { handled: true, reason: 'direct_chat_queued' };
        },
      } as never,
      fetchFlightDeckPgChannel: async () => ({ id: 'channel-1', workspace_id: 'workspace-1', metadata: {} }),
      fetchFlightDeckPgChannelMessages: async () => ({ messages, next_cursor: null }),
    });
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace('workspace-1', 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });
    saveDirectChatAgent(agentStore, { agentId: 'Builder', botNpub: 'npub1Builder', managedByNpub: 'npub1manager' });
    saveDirectChatAgent(agentStore, { agentId: 'Mick', botNpub: 'npub1Mick', managedByNpub: 'npub1manager' });
    const internals = manager as unknown as {
      handleFlightDeckPgEvent: (
        record: WorkspaceSubscriptionRecord,
        event: Record<string, unknown>,
      ) => Promise<WorkspaceSubscriptionRecord>;
    };
    const firstEvent = {
      event_id: 'event-1', cursor: encodeFlightDeckPgEventCursor(1), workspace_id: 'workspace-1',
      channel_id: 'channel-1', actor_id: 'actor-user', event_type: 'flightdeck_pg.message.created',
      entity_type: 'message', entity_id: 'message-1', operation: 'created', row_version: 1, payload: {},
    };

    await expect(internals.handleFlightDeckPgEvent(imported.subscription, firstEvent))
      .rejects.toMatchObject({ detailCode: 'flightdeck_pg_event_audience_missing' });
    expect(directInputs).toHaveLength(0);
    expect(store.getBySubscriptionId(imported.subscription.subscriptionId)?.lastSyncCursor).toBeNull();

    const afterEmpty = await internals.handleFlightDeckPgEvent(imported.subscription, {
      ...firstEvent,
      event_id: 'event-empty',
      visible_to_audience_npubs: [],
    });
    expect(directInputs).toHaveLength(0);
    expect(afterEmpty.recentDispatches.at(-1)).toMatchObject({
      action: 'chat_direct_suppressed',
      suppressionReason: 'audience_visibility_empty',
    });

    const afterNeutral = await internals.handleFlightDeckPgEvent(imported.subscription, {
      ...firstEvent,
      event_id: 'event-neutral',
      cursor: encodeFlightDeckPgEventCursor(2),
      row_version: 2,
      visible_to_audience_npubs: ['npub1Builder'],
      visible_to_agent_npubs: ['npub1Mick'],
    });
    await internals.handleFlightDeckPgEvent(afterNeutral, {
      ...firstEvent,
      event_id: 'event-legacy',
      cursor: encodeFlightDeckPgEventCursor(3),
      entity_id: 'message-2',
      row_version: 3,
      visible_to_audience_npubs: undefined,
      visible_to_agent_npubs: ['npub1Mick'],
    });

    expect(directInputs.map((input) => input.audienceAgentNpubs)).toEqual([
      ['npub1Builder'],
      ['npub1Mick'],
    ]);
  });

  test('dispatches a Flight Deck PG message event to the chat pipeline route', async () => {
    const dbPath = makeTempDb();
    const routeStore = new DispatchRouteStore(dbPath);
    const dispatches: unknown[] = [];
    const dispatchPipelineRuntime = {
      listRoutesForSubscription: (subscriptionId: string) => routeStore.listForSubscription(subscriptionId),
      saveRoute: (input: Parameters<DispatchRouteStore['save']>[0]) => routeStore.save(input),
      dispatch: async (input: unknown) => {
        dispatches.push(input);
        return {
          handled: true,
          lastPipelineRunId: 'run-pg-chat-1',
          historyEntries: [{
            at: new Date().toISOString(),
            kind: 'chat',
            action: 'chat_pipeline_dispatch',
            agentId: 'dispatch-pipeline',
            sessionId: null,
            recordId: (input as { recordId?: string }).recordId ?? null,
            bindingId: (input as { bindingId?: string }).bindingId ?? null,
            bindingType: 'thread',
            routeId: 'route-chat',
            pipelineRunId: 'run-pg-chat-1',
            status: 'ok',
          }],
        };
      },
    } as unknown as DispatchPipelineRuntime;
    const instanceIdentity = makeInstanceIdentity();
    const signer = makeSignedInstructionIdentity();
    const body = 'Hello autopilot';
    const { manager, store } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
      dispatchPipelineRuntime,
      {
        fetchFlightDeckPgChannelMessages: async () => ({
          messages: [{
            id: 'message-1',
            workspace_id: 'workspace-1',
            scope_id: 'scope-1',
            channel_id: 'channel-1',
            thread_id: 'thread-1',
            body,
            metadata: {
              thread_title: 'Autopilot release discussion',
              mentions: [{ npub: instanceIdentity.npub, type: 'agent' }],
              agent_instruction_signature: makeInstructionSignature({
                body,
                signer,
                workspaceId: 'workspace-1',
                channelId: 'channel-1',
                threadId: 'thread-1',
              }),
            },
            sender_npub: signer.npub,
            created_by_actor_npub: signer.npub,
            row_version: 42,
            created_by_actor_id: 'actor-user',
            updated_by_actor_id: 'actor-user',
            created_at: '2026-06-10T00:00:00.000Z',
            updated_at: '2026-06-10T00:00:00.000Z',
          }],
          next_cursor: null,
        }),
        fetchFlightDeckPgWorkroomContext: async () => ({
          isWorkroom: true,
          workroom: { id: 'room-1', goal: 'Ship the release', repo: { integrationBranch: 'staging' } },
          participant: { npub: signer.npub, role: 'reviewer', metadataStatus: 'valid', capabilities: ['github_pr'], localWorkspace: { repoPath: '/repo', defaultBranch: 'main', canRunTests: true }, constraints: { canMergeIntegration: false, canMergeProduction: false, canRestartManagedApps: false } },
          appTargets: [{ kind: 'preview' }],
          recentEvents: [{ eventType: 'pr_ready' }],
          recentLinks: [],
          openApprovals: [],
        }),
      },
    );
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace('workspace-1', 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });

    const next = await (manager as unknown as {
      handleFlightDeckPgEvent: (record: WorkspaceSubscriptionRecord, event: Record<string, unknown>) => Promise<WorkspaceSubscriptionRecord>;
    }).handleFlightDeckPgEvent(imported.subscription, {
      id: 'event-1',
      event_id: 'event-1',
      cursor: 'cursor-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      actor_id: 'actor-user',
      event_type: 'message.created',
      entity_type: 'message',
      entity_id: 'message-1',
      operation: 'created',
      entity_row_version: 42,
      row_version: 100,
      created_at: '2026-06-10T00:00:00.000Z',
      payload: {},
    });

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      triggerKind: 'chat',
      capability: 'chat_intercept',
      recordId: 'message-1',
      bindingId: 'thread-1',
      scopeId: 'scope-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      sourceLabel: 'Autopilot release discussion',
      workroomContext: {
        isWorkroom: true,
        participant: { role: 'reviewer' },
      },
      payload: {
        body: 'Hello autopilot',
        channel_id: 'channel-1',
        thread_id: 'thread-1',
      },
    });
    expect(next.lastPipelineRunId).toBe('run-pg-chat-1');
    expect(dispatches[0]).toMatchObject({ updaterNpub: signer.npub });
    expect(store.getBySubscriptionId(imported.subscription.subscriptionId)?.recentDispatches.at(-1)?.pipelineRunId).toBe('run-pg-chat-1');
  });

  test('suppresses Flight Deck PG chat dispatch from unauthorized actors', async () => {
    const dbPath = makeTempDb();
    const routeStore = new DispatchRouteStore(dbPath);
    let dispatchCount = 0;
    const dispatchPipelineRuntime = {
      listRoutesForSubscription: (subscriptionId: string) => routeStore.listForSubscription(subscriptionId),
      saveRoute: (input: Parameters<DispatchRouteStore['save']>[0]) => routeStore.save(input),
      dispatch: async () => {
        dispatchCount += 1;
        return { handled: true, lastPipelineRunId: 'run-unauthorized', historyEntries: [] };
      },
    } as unknown as DispatchPipelineRuntime;
    const instanceIdentity = makeInstanceIdentity();
    const outsideSigner = makeSignedInstructionIdentity();
    const body = 'Hello from outside';
    const { manager, store } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
      dispatchPipelineRuntime,
      {
        isAuthorizedDispatchActorNpub: () => false,
        fetchFlightDeckPgChannelMessages: async () => ({
          messages: [{
            id: 'message-unauthorized-1',
            workspace_id: 'workspace-1',
            scope_id: 'scope-1',
            channel_id: 'channel-1',
            thread_id: 'thread-unauthorized-1',
            body,
            metadata: {
              mentions: [{ npub: instanceIdentity.npub, type: 'agent' }],
              agent_instruction_signature: makeInstructionSignature({
                body,
                signer: outsideSigner,
                workspaceId: 'workspace-1',
                channelId: 'channel-1',
                threadId: 'thread-unauthorized-1',
              }),
            },
            sender_npub: outsideSigner.npub,
            created_by_actor_npub: outsideSigner.npub,
            row_version: 42,
            created_by_actor_id: 'actor-outside',
            updated_by_actor_id: 'actor-outside',
            created_at: '2026-06-10T00:00:00.000Z',
            updated_at: '2026-06-10T00:00:00.000Z',
          }],
          next_cursor: null,
        }),
      },
    );
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace('workspace-1', 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });

    await (manager as unknown as {
      handleFlightDeckPgEvent: (record: WorkspaceSubscriptionRecord, event: Record<string, unknown>) => Promise<WorkspaceSubscriptionRecord>;
    }).handleFlightDeckPgEvent(imported.subscription, {
      id: 'event-unauthorized-1',
      event_id: 'event-unauthorized-1',
      cursor: 'cursor-unauthorized-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      actor_id: 'actor-outside',
      event_type: 'message.created',
      entity_type: 'message',
      entity_id: 'message-unauthorized-1',
      operation: 'created',
      entity_row_version: 42,
      row_version: 100,
      created_at: '2026-06-10T00:00:00.000Z',
      payload: {},
    });

    const saved = store.getBySubscriptionId(imported.subscription.subscriptionId);
    expect(dispatchCount).toBe(0);
    expect(saved?.lastRoutingResult?.code).toBe('chat_skip_unauthorized_actor');
    expect(saved?.recentDispatches.at(-1)?.action).toBe('chat_skip_unauthorized_actor');
    expect(saved?.recentDispatches.at(-1)?.details).toMatchObject({
      actor_npub: outsideSigner.npub,
      suppression_reason: 'unauthorized_dispatch_actor',
      source: 'flightdeck_pg',
    });
  });

  test('suppresses Flight Deck PG chat dispatch when the signed body was tampered', async () => {
    const dbPath = makeTempDb();
    const routeStore = new DispatchRouteStore(dbPath);
    let dispatchCount = 0;
    const dispatchPipelineRuntime = {
      listRoutesForSubscription: (subscriptionId: string) => routeStore.listForSubscription(subscriptionId),
      saveRoute: (input: Parameters<DispatchRouteStore['save']>[0]) => routeStore.save(input),
      dispatch: async () => {
        dispatchCount += 1;
        return { handled: true, lastPipelineRunId: 'run-tampered', historyEntries: [] };
      },
    } as unknown as DispatchPipelineRuntime;
    const instanceIdentity = makeInstanceIdentity();
    const signer = makeSignedInstructionIdentity();
    const { manager, store } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
      dispatchPipelineRuntime,
      {
        isAuthorizedDispatchActorNpub: (npub) => npub === signer.npub,
        fetchFlightDeckPgChannelMessages: async () => ({
          messages: [{
            id: 'message-tampered-1',
            workspace_id: 'workspace-1',
            scope_id: 'scope-1',
            channel_id: 'channel-1',
            thread_id: 'thread-tampered-1',
            body: 'Tampered body',
            metadata: {
              mentions: [{ npub: instanceIdentity.npub, type: 'agent' }],
              agent_instruction_signature: makeInstructionSignature({
                body: 'Original signed body',
                signer,
                workspaceId: 'workspace-1',
                channelId: 'channel-1',
                threadId: 'thread-tampered-1',
              }),
            },
            sender_npub: signer.npub,
            created_by_actor_npub: signer.npub,
            row_version: 42,
            created_by_actor_id: 'actor-user',
            updated_by_actor_id: 'actor-user',
            created_at: '2026-06-10T00:00:00.000Z',
            updated_at: '2026-06-10T00:00:00.000Z',
          }],
          next_cursor: null,
        }),
      },
    );
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace('workspace-1', 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });

    await (manager as unknown as {
      handleFlightDeckPgEvent: (record: WorkspaceSubscriptionRecord, event: Record<string, unknown>) => Promise<WorkspaceSubscriptionRecord>;
    }).handleFlightDeckPgEvent(imported.subscription, {
      id: 'event-tampered-1',
      event_id: 'event-tampered-1',
      cursor: 'cursor-tampered-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      actor_id: 'actor-user',
      event_type: 'message.created',
      entity_type: 'message',
      entity_id: 'message-tampered-1',
      operation: 'created',
      entity_row_version: 42,
      row_version: 100,
      created_at: '2026-06-10T00:00:00.000Z',
      payload: {},
    });

    const saved = store.getBySubscriptionId(imported.subscription.subscriptionId);
    expect(dispatchCount).toBe(0);
    expect(saved?.lastRoutingResult?.code).toBe('chat_skip_invalid_instruction_signature');
    expect(saved?.recentDispatches.at(-1)?.action).toBe('chat_skip_invalid_instruction_signature');
    expect(saved?.recentDispatches.at(-1)?.details?.suppression_reason).toBe('instruction_body_mismatch');
  });

  test('suppresses legacy task dispatch from unauthorized record signers', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity();
    const { manager, store } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
      undefined,
      {
        isAuthorizedDispatchActorNpub: (npub) => npub === 'npub1allowed',
        fetchRecordHistory: async () => [{
          id: 'task-record-unauthorized-1',
          record_id: 'task-record-unauthorized-1',
          version: 1,
          record_state: 'active',
          signature_npub: 'npub1outside',
        }],
        decryptRecordPayload: async () => ({
          task_id: 'task-record-unauthorized-1',
          title: 'Outside task',
          description: 'Should not dispatch',
          state: 'new',
          assigned_to_npub: instanceIdentity.npub,
        }),
      },
    );
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage({
        workspace: { owner_npub: 'npub1workspace' },
        app: { app_npub: 'npub1sourceapp' },
        capabilities: ['task_dispatch'],
      }),
      onboardingSource: 'agent_connect_import',
    });
    (manager as unknown as { runtimes: Map<string, unknown> }).runtimes.set(imported.subscription.subscriptionId, {
      abortController: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      botIdentity: {
        botNpub: instanceIdentity.npub,
        botPubkeyHex: instanceIdentity.pubkeyHex,
        botSecret: instanceIdentity.secretKey,
      },
      wsSession: {},
      groupKeys: null,
      wrappedKeyRows: [],
      flightDeckPgActorId: null,
      removed: false,
    });

    await (manager as unknown as {
      handleTaskRecordChanged: (record: WorkspaceSubscriptionRecord, payload: Record<string, unknown>) => Promise<WorkspaceSubscriptionRecord>;
    }).handleTaskRecordChanged(imported.subscription, {
      record_id: 'task-record-unauthorized-1',
      family_hash: 'npub1sourceapp:task',
    });

    const saved = store.getBySubscriptionId(imported.subscription.subscriptionId);
    expect(saved?.lastRoutingResult?.code).toBe('task_skip_unauthorized_actor');
    expect(saved?.recentDispatches.at(-1)?.action).toBe('task_skip_unauthorized_actor');
    expect(saved?.recentDispatches.at(-1)?.sourceLabel).toBe('Outside task');
    expect(saved?.recentDispatches.at(-1)?.details).toMatchObject({
      actor_npub: 'npub1outside',
      source: 'record',
      suppression_reason: 'unauthorized_dispatch_actor',
    });
  });

  test('times out a stuck Flight Deck PG event poll and records poll failure health', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity();
    let pollAborted = false;
    const { manager, store } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
      undefined,
      {
        flightDeckPgEventPollTimeoutMs: 5,
        flightDeckPgEventPollIntervalMs: 5,
        fetchFlightDeckPgEvents: async (_input) => {
          await new Promise<void>((resolve) => {
            _input.signal?.addEventListener('abort', () => {
              pollAborted = true;
              resolve();
            }, { once: true });
          });
          await new Promise(() => {});
          return { events: [], next_cursor: null };
        },
      },
    );
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace('workspace-1', 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });

    await (manager as unknown as {
      runFlightDeckPgEventLoop: (subscriptionId: string, signal: AbortSignal, isStartupReload: boolean) => Promise<void>;
    }).runFlightDeckPgEventLoop(imported.subscription.subscriptionId, new AbortController().signal, false);

    const saved = store.getBySubscriptionId(imported.subscription.subscriptionId);
    expect(pollAborted).toBe(true);
    expect(saved?.sseStatus).toBe('connected');
    expect(saved?.lastEventPollErrorCode).toBe('flightdeck_pg_event_poll_timeout');
    expect(saved?.lastEventPollErrorAt).toBeString();
  });

  test('keeps Flight Deck PG workspace access retryable after transient Tower 5xx', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity();
    const { manager, store } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
      undefined,
      {
        fetchFlightDeckPgWorkspaceMe: async () => {
          throw Object.assign(new Error('{"status":502,"retryable":true}'), {
            status: 502,
            detailCode: 'flightdeck_pg_access_failed',
          });
        },
      },
    );
    const record = store.save({
      ...store.createDefault({
        managedByNpub: 'npub1manager',
        workspaceOwnerNpub: 'npub1workspace',
        workspaceServiceNpub: 'npub1workspaceservice',
        workspaceId: 'workspace-1',
        backendBaseUrl: 'https://tower.example.com',
        sourceAppNpub: 'npub1sourceapp',
        botNpub: 'npub1wingmanbot',
        onboardingSource: 'nostr_33357',
      }),
      wsKeyStatus: 'active',
      groupKeyStatus: 'active',
      sseStatus: 'connected',
      healthStatus: 'healthy',
    });

    const next = await (manager as unknown as {
      verifyFlightDeckPgWorkspaceAccess: (
        record: WorkspaceSubscriptionRecord,
        botIdentity: RuntimeBotIdentity,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).verifyFlightDeckPgWorkspaceAccess(record, {
      botNpub: 'npub1wingmanbot',
      botPubkeyHex: 'f'.repeat(64),
      botSecret: new Uint8Array(32),
    });

    expect(next.wsKeyStatus).toBe('active');
    expect(next.sseStatus).toBe('backoff');
    expect(next.healthStatus).toBe('degraded');
    expect(next.lastAuthResult?.details?.retryable).toBe(true);
  });

  test('keeps Flight Deck PG workspace access retryable after Bun connection failure', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity();
    const { manager, store } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
      undefined,
      {
        fetchFlightDeckPgWorkspaceMe: async () => {
          throw new Error('Unable to connect. Is the computer able to access the url? Was there a typo in the url or port?');
        },
      },
    );
    const record = store.save({
      ...store.createDefault({
        managedByNpub: 'npub1manager',
        workspaceOwnerNpub: 'npub1workspace',
        workspaceServiceNpub: 'npub1workspaceservice',
        workspaceId: 'workspace-1',
        backendBaseUrl: 'https://tower.example.com',
        sourceAppNpub: 'npub1sourceapp',
        botNpub: 'npub1wingmanbot',
        onboardingSource: 'nostr_33357',
      }),
      wsKeyStatus: 'active',
      groupKeyStatus: 'active',
      sseStatus: 'connected',
      healthStatus: 'healthy',
    });

    const next = await (manager as unknown as {
      verifyFlightDeckPgWorkspaceAccess: (
        record: WorkspaceSubscriptionRecord,
        botIdentity: RuntimeBotIdentity,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).verifyFlightDeckPgWorkspaceAccess(record, {
      botNpub: 'npub1wingmanbot',
      botPubkeyHex: 'f'.repeat(64),
      botSecret: new Uint8Array(32),
    });

    expect(next.wsKeyStatus).toBe('active');
    expect(next.sseStatus).toBe('backoff');
    expect(next.healthStatus).toBe('degraded');
    expect(next.lastAuthResult?.details?.retryable).toBe(true);
  });

  test('keeps Flight Deck PG workspace access retryable after local helper load failure', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity();
    const { manager, store } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
      undefined,
      {
        fetchFlightDeckPgWorkspaceMe: async () => {
          throw new Error("Cannot find module '@runwingman/flightdeck-cli/src/bot-helpers.js'");
        },
      },
    );
    const record = store.save({
      ...store.createDefault({
        managedByNpub: 'npub1manager',
        workspaceOwnerNpub: 'npub1workspace',
        workspaceServiceNpub: 'npub1workspaceservice',
        workspaceId: 'workspace-1',
        backendBaseUrl: 'https://tower.example.com',
        sourceAppNpub: 'npub1sourceapp',
        botNpub: 'npub1wingmanbot',
        onboardingSource: 'nostr_33357',
      }),
      wsKeyStatus: 'active',
      groupKeyStatus: 'active',
      sseStatus: 'connected',
      healthStatus: 'healthy',
    });

    const next = await (manager as unknown as {
      verifyFlightDeckPgWorkspaceAccess: (
        record: WorkspaceSubscriptionRecord,
        botIdentity: RuntimeBotIdentity,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).verifyFlightDeckPgWorkspaceAccess(record, {
      botNpub: 'npub1wingmanbot',
      botPubkeyHex: 'f'.repeat(64),
      botSecret: new Uint8Array(32),
    });

    expect(next.wsKeyStatus).toBe('active');
    expect(next.sseStatus).toBe('backoff');
    expect(next.healthStatus).toBe('degraded');
    expect(next.lastAuthResult?.details?.retryable).toBe(true);
  });

  test('dispatches a Flight Deck PG message from the live event stream', async () => {
    const dbPath = makeTempDb();
    const routeStore = new DispatchRouteStore(dbPath);
    const dispatches: unknown[] = [];
    const liveController = new AbortController();
    const dispatchPipelineRuntime = {
      listRoutesForSubscription: (subscriptionId: string) => routeStore.listForSubscription(subscriptionId),
      saveRoute: (input: Parameters<DispatchRouteStore['save']>[0]) => routeStore.save(input),
      dispatch: async (input: unknown) => {
        dispatches.push(input);
        liveController.abort();
        return {
          handled: true,
          lastPipelineRunId: 'run-live-pg-chat-1',
          historyEntries: [{
            at: new Date().toISOString(),
            kind: 'chat',
            action: 'chat_pipeline_dispatch',
            agentId: 'dispatch-pipeline',
            sessionId: null,
            recordId: (input as { recordId?: string }).recordId ?? null,
            bindingId: (input as { bindingId?: string }).bindingId ?? null,
            bindingType: 'thread',
            routeId: 'route-chat',
            pipelineRunId: 'run-live-pg-chat-1',
            status: 'ok',
          }],
        };
      },
    } as unknown as DispatchPipelineRuntime;
    const instanceIdentity = makeInstanceIdentity();
    const signer = makeSignedInstructionIdentity();
    const body = 'Live hello';
    const liveCursor = encodeFlightDeckPgEventCursor(101);
    const event = {
      id: 'event-live-1',
      event_id: 'event-live-1',
      cursor: liveCursor,
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      actor_id: 'actor-user',
      event_type: 'message.created',
      entity_type: 'message',
      entity_id: 'message-live-1',
      operation: 'created',
      entity_row_version: 42,
      row_version: 101,
      created_at: '2026-06-10T00:00:00.000Z',
      payload: {},
    };
    const { manager, store } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
      dispatchPipelineRuntime,
      {
        connectFlightDeckPgEventStream: async () => new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(`event: flightdeck_pg.event\ndata: ${JSON.stringify(event)}\n\n`));
            controller.close();
          },
        })),
        fetchFlightDeckPgChannelMessages: async () => ({
          messages: [{
            id: 'message-live-1',
            workspace_id: 'workspace-1',
            scope_id: 'scope-1',
            channel_id: 'channel-1',
            thread_id: 'thread-live-1',
            body,
            metadata: {
              mentions: [{ npub: instanceIdentity.npub, type: 'agent' }],
              agent_instruction_signature: makeInstructionSignature({
                body,
                signer,
                workspaceId: 'workspace-1',
                channelId: 'channel-1',
                threadId: 'thread-live-1',
              }),
            },
            sender_npub: signer.npub,
            created_by_actor_npub: signer.npub,
            row_version: 42,
            created_by_actor_id: 'actor-user',
            updated_by_actor_id: 'actor-user',
            created_at: '2026-06-10T00:00:00.000Z',
            updated_at: '2026-06-10T00:00:00.000Z',
          }],
          next_cursor: null,
        }),
      },
    );
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace('workspace-1', 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });

    await (manager as unknown as {
      runFlightDeckPgLiveEventLoop: (subscriptionId: string, signal: AbortSignal, isStartupReload: boolean) => Promise<void>;
    }).runFlightDeckPgLiveEventLoop(imported.subscription.subscriptionId, liveController.signal, false);

    const saved = store.getBySubscriptionId(imported.subscription.subscriptionId);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      triggerKind: 'chat',
      recordId: 'message-live-1',
      bindingId: 'thread-live-1',
      channelId: 'channel-1',
    });
    expect(saved?.lastSyncCursor).toBe(liveCursor);
    expect(saved?.lastPipelineRunId).toBe('run-live-pg-chat-1');
  });

  test('keeps an accepted profile live across an SSE audience change', async () => {
    const dbPath = makeTempDb();
    const liveController = new AbortController();
    const directAudiences: string[][] = [];
    const instanceIdentity = makeInstanceIdentity();
    const event = {
      event_id: 'event-audience-1', cursor: encodeFlightDeckPgEventCursor(301), workspace_id: 'workspace-1',
      channel_id: 'channel-1', actor_id: 'actor-user', event_type: 'flightdeck_pg.message.created',
      entity_type: 'message', entity_id: 'message-audience-1', operation: 'created', row_version: 301,
      visible_to_audience_npubs: ['npub1Builder'], payload: {},
    };
    const botKeys = new Map([
      ['npub1Builder', makeBotKeyRecord('npub1Builder')],
      ['npub1Mick', makeBotKeyRecord('npub1Mick')],
    ]);
    const { manager, store, agentStore } = createTestManager(dbPath, botKeys, undefined, instanceIdentity, undefined, {
      reconcileFlightDeckPgEventSubscriptionAgents: async () => ({
        agent_npubs: ['npub1Builder'],
        audience_npubs: ['npub1Builder'],
        rejected_audience: [{ npub: 'npub1Mick', code: 'inactive_or_unknown_workspace_member' }],
      }),
      connectFlightDeckPgEventStream: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`event: flightdeck_pg.audience_changed\ndata: ${JSON.stringify({
            subscription_audience_npubs: ['npub1Builder'],
            rejected_audience_npubs: ['npub1Mick'],
          })}\n\n`));
          controller.enqueue(encoder.encode(`event: flightdeck_pg.event\ndata: ${JSON.stringify(event)}\n\n`));
          controller.close();
        },
      })),
      chatRuntime: {
        clearSubscriptionBlocked: () => undefined,
        handleDirectChat: async (input: { audienceAgentNpubs: string[] }) => {
          directAudiences.push(input.audienceAgentNpubs);
          liveController.abort();
          return { handled: true, reason: 'direct_chat_queued' };
        },
      } as never,
      fetchFlightDeckPgChannel: async () => ({ id: 'channel-1', workspace_id: 'workspace-1', metadata: {} }),
      fetchFlightDeckPgChannelMessages: async () => ({
        messages: [{ id: 'message-audience-1', channel_id: 'channel-1', thread_id: 'thread-1', body: 'Builder only' }],
        next_cursor: null,
      }),
    });
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace('workspace-1', 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });
    saveDirectChatAgent(agentStore, { agentId: 'Builder', botNpub: 'npub1Builder', managedByNpub: 'npub1manager' });
    saveDirectChatAgent(agentStore, { agentId: 'Mick', botNpub: 'npub1Mick', managedByNpub: 'npub1manager' });

    await (manager as unknown as {
      runFlightDeckPgLiveEventLoop: (
        subscriptionId: string,
        signal: AbortSignal,
        isStartupReload: boolean,
      ) => Promise<void>;
    }).runFlightDeckPgLiveEventLoop(imported.subscription.subscriptionId, liveController.signal, false);

    const saved = store.getBySubscriptionId(imported.subscription.subscriptionId);
    expect(directAudiences).toEqual([['npub1Builder']]);
    expect(saved?.lastSyncCursor).toBe(encodeFlightDeckPgEventCursor(301));
    expect(saved?.recentSseEvents.some((item) => item.eventType === 'flightdeck_pg.audience_changed')).toBe(true);
  });

  test('uses one authoritative PG event consumer instead of racing SSE and polling', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity();
    let liveConnections = 0;
    let pollCalls = 0;
    let managerInternals: {
      ensureFlightDeckPgConnected: (record: WorkspaceSubscriptionRecord, botIdentity: RuntimeBotIdentity, startup: boolean) => Promise<void>;
      stopRuntime: (subscriptionId: string, removed: boolean) => void;
    };
    const { manager } = createTestManager(dbPath, new Map(), undefined, instanceIdentity, undefined, {
      flightDeckPgEventPollIntervalMs: 1,
      connectFlightDeckPgEventStream: async () => {
        liveConnections += 1;
        throw new Error('SSE must not consume PG events concurrently.');
      },
      fetchFlightDeckPgEvents: async () => {
        pollCalls += 1;
        return { events: [], next_cursor: null };
      },
    });
    managerInternals = manager as unknown as typeof managerInternals;
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace('workspace-1', 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });

    await managerInternals.ensureFlightDeckPgConnected(imported.subscription, {
      botNpub: instanceIdentity.npub,
      botPubkeyHex: instanceIdentity.pubkeyHex,
      botSecret: instanceIdentity.secretKey.slice(),
    }, false);
    for (let attempt = 0; attempt < 20 && pollCalls === 0; attempt += 1) await Bun.sleep(1);
    managerInternals.stopRuntime(imported.subscription.subscriptionId, false);

    expect(pollCalls).toBeGreaterThan(0);
    expect(liveConnections).toBe(0);
  });

  test('does not acknowledge an unresolved PG event and coalesces concurrent duplicate delivery', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity({ npub: ATHENA_BOT_NPUB });
    let directCalls = 0;
    let releaseDirect!: (value: { handled: boolean; reason: string }) => void;
    const directPending = new Promise<{ handled: boolean; reason: string }>((resolve) => { releaseDirect = resolve; });
    const { manager, store } = createTestManager(dbPath, new Map(), undefined, instanceIdentity, undefined, {
      chatRuntime: {
        handleDirectChat: async () => {
          directCalls += 1;
          return await directPending;
        },
      } as never,
      fetchFlightDeckPgChannel: async () => ({ id: 'channel-1', workspace_id: 'workspace-1', metadata: {} }),
      fetchFlightDeckPgChannelMessages: async () => ({
        messages: [
          { id: 'message-pending', channel_id: 'channel-1', thread_id: 'thread-1', body: 'Pending mention' },
          { id: 'message-adjacent', channel_id: 'channel-1', thread_id: 'thread-1', body: 'Adjacent mention' },
        ],
        next_cursor: null,
      }),
    });
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace('workspace-1', 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });
    const event = {
      event_id: 'event-pending', cursor: encodeFlightDeckPgEventCursor(201), workspace_id: 'workspace-1',
      channel_id: 'channel-1', actor_id: 'actor-user', event_type: 'flightdeck_pg.message.created',
      entity_type: 'message', entity_id: 'message-pending', operation: 'created', row_version: 201,
      payload: { thread_id: 'thread-1' },
    };
    const internals = manager as unknown as {
      handleFlightDeckPgEvent: (record: WorkspaceSubscriptionRecord, event: Record<string, unknown>) => Promise<WorkspaceSubscriptionRecord>;
    };

    const first = internals.handleFlightDeckPgEvent(imported.subscription, event);
    const duplicate = internals.handleFlightDeckPgEvent(imported.subscription, event);
    const adjacent = internals.handleFlightDeckPgEvent(imported.subscription, {
      ...event,
      event_id: 'event-adjacent',
      cursor: encodeFlightDeckPgEventCursor(202),
      entity_id: 'message-adjacent',
      row_version: 202,
    });
    for (let attempt = 0; attempt < 20 && directCalls === 0; attempt += 1) await Bun.sleep(1);
    expect(store.getBySubscriptionId(imported.subscription.subscriptionId)?.lastSyncCursor).toBeNull();
    expect(directCalls).toBe(1);

    releaseDirect({ handled: true, reason: 'direct_chat_queued' });
    await Promise.all([first, duplicate, adjacent]);
    expect(store.getBySubscriptionId(imported.subscription.subscriptionId)?.lastSyncCursor)
      .toBe(encodeFlightDeckPgEventCursor(202));
    expect(directCalls).toBe(2);
  });

  test('keeps a PG event replayable when its exact trigger message is missing', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity();
    const { manager, store } = createTestManager(dbPath, new Map(), undefined, instanceIdentity, undefined, {
      chatRuntime: { handleDirectChat: async () => ({ handled: true, reason: 'unexpected' }) } as never,
      fetchFlightDeckPgChannelMessages: async () => ({
        messages: [{ id: 'unrelated-message', channel_id: 'channel-1', thread_id: 'thread-1' }],
        next_cursor: null,
      }),
    });
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace('workspace-1', 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });
    const cursor = encodeFlightDeckPgEventCursor(202);

    await expect((manager as unknown as {
      handleFlightDeckPgEvent: (record: WorkspaceSubscriptionRecord, event: Record<string, unknown>) => Promise<WorkspaceSubscriptionRecord>;
    }).handleFlightDeckPgEvent(imported.subscription, {
      event_id: 'event-missing', cursor, workspace_id: 'workspace-1', channel_id: 'channel-1',
      actor_id: 'actor-user', event_type: 'flightdeck_pg.message.created', entity_type: 'message',
      entity_id: 'missing-message', operation: 'created', row_version: 202, payload: { thread_id: 'thread-1' },
    })).rejects.toMatchObject({ detailCode: 'flightdeck_pg_chat_message_missing' });

    const saved = store.getBySubscriptionId(imported.subscription.subscriptionId);
    expect(saved?.lastSyncCursor).toBeNull();
    expect(saved?.lastRoutingResult?.code).toBe('flightdeck_pg_chat_message_missing');
    expect(saved?.lastErrorCode).toBe('flightdeck_pg_chat_message_missing');
  });

  test('skips duplicate Flight Deck PG events already covered by the saved cursor', async () => {
    const dbPath = makeTempDb();
    const routeStore = new DispatchRouteStore(dbPath);
    let dispatchCount = 0;
    const dispatchPipelineRuntime = {
      listRoutesForSubscription: (subscriptionId: string) => routeStore.listForSubscription(subscriptionId),
      saveRoute: (input: Parameters<DispatchRouteStore['save']>[0]) => routeStore.save(input),
      dispatch: async () => {
        dispatchCount += 1;
        return {
          handled: true,
          lastPipelineRunId: `run-${dispatchCount}`,
          historyEntries: [{
            at: new Date().toISOString(),
            kind: 'chat',
            action: 'chat_pipeline_dispatch',
            agentId: 'dispatch-pipeline',
            sessionId: null,
            recordId: 'message-dupe-1',
            bindingId: 'thread-dupe-1',
            bindingType: 'thread',
            routeId: 'route-chat',
            pipelineRunId: `run-${dispatchCount}`,
            status: 'ok',
          }],
        };
      },
    } as unknown as DispatchPipelineRuntime;
    const instanceIdentity = makeInstanceIdentity();
    const signer = makeSignedInstructionIdentity();
    const body = 'Duplicate hello';
    const cursor = encodeFlightDeckPgEventCursor(150);
    const { manager } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
      dispatchPipelineRuntime,
      {
        fetchFlightDeckPgChannelMessages: async () => ({
          messages: [{
            id: 'message-dupe-1',
            workspace_id: 'workspace-1',
            scope_id: 'scope-1',
            channel_id: 'channel-1',
            thread_id: 'thread-dupe-1',
            body,
            metadata: {
              mentions: [{ npub: instanceIdentity.npub, type: 'agent' }],
              agent_instruction_signature: makeInstructionSignature({
                body,
                signer,
                workspaceId: 'workspace-1',
                channelId: 'channel-1',
                threadId: 'thread-dupe-1',
              }),
            },
            sender_npub: signer.npub,
            created_by_actor_npub: signer.npub,
            row_version: 42,
            created_by_actor_id: 'actor-user',
            updated_by_actor_id: 'actor-user',
            created_at: '2026-06-10T00:00:00.000Z',
            updated_at: '2026-06-10T00:00:00.000Z',
          }],
          next_cursor: null,
        }),
      },
    );
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace('workspace-1', 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });
    const event = {
      id: 'event-dupe-1',
      event_id: 'event-dupe-1',
      cursor,
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      actor_id: 'actor-user',
      event_type: 'message.created',
      entity_type: 'message',
      entity_id: 'message-dupe-1',
      operation: 'created',
      entity_row_version: 42,
      row_version: 150,
      created_at: '2026-06-10T00:00:00.000Z',
      payload: {},
    };

    const internals = manager as unknown as {
      handleFlightDeckPgEvent: (record: WorkspaceSubscriptionRecord, event: Record<string, unknown>) => Promise<WorkspaceSubscriptionRecord>;
    };
    const first = await internals.handleFlightDeckPgEvent(imported.subscription, event);
    await internals.handleFlightDeckPgEvent(first, event);

    expect(dispatchCount).toBe(1);
  });

  test('suppresses self-authored Flight Deck PG message events by actor id', async () => {
    const dbPath = makeTempDb();
    const routeStore = new DispatchRouteStore(dbPath);
    let dispatchCalled = false;
    const dispatchPipelineRuntime = {
      listRoutesForSubscription: (subscriptionId: string) => routeStore.listForSubscription(subscriptionId),
      saveRoute: (input: Parameters<DispatchRouteStore['save']>[0]) => routeStore.save(input),
      dispatch: async () => {
        dispatchCalled = true;
        return { handled: false, lastPipelineRunId: null, historyEntries: [] };
      },
    } as unknown as DispatchPipelineRuntime;
    const instanceIdentity = makeInstanceIdentity();
    const { manager, store } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
      dispatchPipelineRuntime,
    );
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace('workspace-1', 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });
    const verified = await (manager as unknown as {
      verifyFlightDeckPgWorkspaceAccess: (
        record: WorkspaceSubscriptionRecord,
        botIdentity: RuntimeBotIdentity,
      ) => Promise<WorkspaceSubscriptionRecord>;
    }).verifyFlightDeckPgWorkspaceAccess(imported.subscription, {
      botNpub: instanceIdentity.npub,
      botPubkeyHex: instanceIdentity.pubkeyHex,
      botSecret: instanceIdentity.secretKey,
    });

    await (manager as unknown as {
      handleFlightDeckPgEvent: (record: WorkspaceSubscriptionRecord, event: Record<string, unknown>) => Promise<WorkspaceSubscriptionRecord>;
    }).handleFlightDeckPgEvent(verified, {
      id: 'event-self',
      event_id: 'event-self',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      actor_id: 'actor-bot',
      event_type: 'message.created',
      entity_type: 'message',
      entity_id: 'message-self',
      operation: 'created',
      row_version: 100,
      payload: {},
    });

    const saved = store.getBySubscriptionId(imported.subscription.subscriptionId);
    expect(dispatchCalled).toBe(false);
    expect(saved?.recentDispatches.at(-1)).toMatchObject({
      action: 'chat_pipeline_suppressed',
      details: {
        suppression_reason: 'self_authored',
        event_actor_id: 'actor-bot',
        bot_actor_id: 'actor-bot',
      },
    });
  });

  test('removes dispatch routes when deleting a manual subscription', async () => {
    const dbPath = makeTempDb();
    const routeStore = new DispatchRouteStore(dbPath);
    const dispatchPipelineRuntime = new DispatchPipelineRuntime({
      routeStore,
      pipelineStore: new PipelineStore(makeTempDb()),
      getSessionApiContext: () => null,
      callbackOrigin: 'http://localhost:3600',
      requirePipelineRoutes: true,
    });
    const { manager } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      makeInstanceIdentity(),
      dispatchPipelineRuntime,
    );
    const subscription = await manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      sourceAppNpub: 'npub1sourceapp',
    });
    routeStore.save({
      managedByNpub: 'npub1manager',
      subscriptionId: subscription.subscriptionId,
      workspaceOwnerNpub: 'npub1workspace',
      botNpub: subscription.botNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      triggerKind: 'chat',
      capability: 'chat_intercept',
      pipelineDefinitionId: 'fd-agent-dispatch-chat',
      enabled: true,
    });

    expect(routeStore.listForSubscription(subscription.subscriptionId).length).toBeGreaterThan(0);
    expect(manager.removeForManager(subscription.subscriptionId, 'npub1manager')).toBe(true);
    expect(routeStore.listForSubscription(subscription.subscriptionId)).toHaveLength(0);
  });

  test('marks confirmed 33357 revocation as local tombstone and disables SSE', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity();
    const { manager, store, profilePolicyStore } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
    );
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace('workspace-1', 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });

    const result = await manager.handleAccessGrantRevocation({
      managedByNpub: 'npub1manager',
      grant: {
        ...makeRevokedAccessGrant({
          eventId: 'event-revoked-1',
          workspaceId: 'workspace-1',
          workspaceServiceNpub: 'npub1workspaceservice',
        }),
        recipientNpub: instanceIdentity.npub,
      } as never,
      verification: {
        confirmed: true,
        towerResult: 'workspace_deleted',
        checkedAt: '2026-06-08T00:00:00.000Z',
        message: 'Tower confirmed deletion.',
      },
    });

    const saved = store.getBySubscriptionId(imported.subscription.subscriptionId);
    expect(result.matchedSubscriptions).toBe(1);
    expect(saved?.wsKeyStatus).toBe('revoked');
    expect(saved?.groupKeyStatus).toBe('revoked');
    expect(saved?.sseStatus).toBe('disabled');
    expect(saved?.lastErrorCode).toBe('workspace_access_revoked');
    expect(saved?.lastRecordPullResult?.message).toContain('self-index tombstone');
    expect(saved?.lastRecordPullResult?.details?.state).toMatchObject({
      deleted: true,
      status: 'deleted',
      source_33357_event_id: 'event-revoked-1',
    });

    const workspaces = profilePolicyStore.listWorkspacesForProfile(instanceIdentity.npub, 'npub1manager');
    expect(workspaces[0]?.relayOnboardingStatus).toBe('deleted');
  });

  test('records unconfirmed 33357 revocation without disabling SSE or hiding active workspace', async () => {
    const dbPath = makeTempDb();
    const instanceIdentity = makeInstanceIdentity();
    const { manager, store, profilePolicyStore } = createTestManager(
      dbPath,
      new Map(),
      undefined,
      instanceIdentity,
    );
    const imported = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackageForWorkspace('workspace-1', 'npub1workspaceservice'),
      onboardingSource: 'nostr_33357',
    });
    store.save({
      ...imported.subscription,
      sseStatus: 'connected',
      healthStatus: 'healthy',
    });

    const result = await manager.handleAccessGrantRevocation({
      managedByNpub: 'npub1manager',
      grant: {
        ...makeRevokedAccessGrant({
          eventId: 'event-revoked-unconfirmed',
          workspaceId: 'workspace-1',
          workspaceServiceNpub: 'npub1workspaceservice',
          action: 'revoked',
          reason: 'workspace_access_revoked',
        }),
        recipientNpub: instanceIdentity.npub,
      } as never,
      verification: {
        confirmed: false,
        towerResult: 'access_active',
        checkedAt: '2026-06-08T00:00:00.000Z',
        message: 'Tower still confirms active access.',
      },
    });

    const saved = store.getBySubscriptionId(imported.subscription.subscriptionId);
    const workspaces = profilePolicyStore.listWorkspacesForProfile(instanceIdentity.npub, 'npub1manager');
    expect(result.matchedSubscriptions).toBe(1);
    expect(result.selfIndexRefresh).toBeNull();
    expect(saved?.sseStatus).toBe('connected');
    expect(saved?.wsKeyStatus).not.toBe('revoked');
    expect(saved?.lastErrorCode).toBe('workspace_revocation_unconfirmed');
    expect(saved?.lastAuthResult?.details?.source_33357_event_id).toBe('event-revoked-unconfirmed');
    expect(workspaces[0]?.relayOnboardingStatus).toBe('ready');
  });

  test('matches confirmed 33357 revocation to the exact workspace identity only', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, store, profilePolicyStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });

    const first = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      agentProfileId: 'wm-one',
      packageJson: makeConnectPackageForWorkspace('workspace-one', 'npub1workspaceone'),
      onboardingSource: 'nostr_33357',
    });
    const second = await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      agentProfileId: 'wm-one',
      packageJson: makeConnectPackageForWorkspace('workspace-two', 'npub1workspacetwo'),
      onboardingSource: 'nostr_33357',
    });

    expect(first.subscription.subscriptionId).not.toBe(second.subscription.subscriptionId);

    const result = await manager.handleAccessGrantRevocation({
      managedByNpub: 'npub1manager',
      agentProfileId: 'wm-one',
      grant: makeRevokedAccessGrant({
        eventId: 'event-revoked-workspace-two',
        workspaceId: 'workspace-two',
        workspaceServiceNpub: 'npub1workspacetwo',
      }) as never,
      verification: {
        confirmed: true,
        towerResult: 'workspace_deleted',
        checkedAt: '2026-06-08T00:00:00.000Z',
        message: 'Tower confirmed deletion.',
      },
    });

    const active = store.getBySubscriptionId(first.subscription.subscriptionId);
    const revoked = store.getBySubscriptionId(second.subscription.subscriptionId);
    const workspaces = profilePolicyStore.listWorkspacesForProfile('wm-one', 'npub1manager');
    const workspaceBySubscription = new Map(workspaces.map((workspace) => [workspace.subscriptionId, workspace]));

    expect(result.matchedSubscriptions).toBe(1);
    expect(result.updatedSubscriptions.map((subscription) => subscription.subscriptionId)).toEqual([
      second.subscription.subscriptionId,
    ]);
    expect(active?.sseStatus).not.toBe('disabled');
    expect(active?.wsKeyStatus).not.toBe('revoked');
    expect(revoked?.sseStatus).toBe('disabled');
    expect(revoked?.wsKeyStatus).toBe('revoked');
    expect(workspaceBySubscription.get(first.subscription.subscriptionId)?.relayOnboardingStatus).toBe('ready');
    expect(workspaceBySubscription.get(second.subscription.subscriptionId)?.relayOnboardingStatus).toBe('deleted');
  });

  test('rejects missing or foreign Agent Profile ids before importing Agent Connect packages', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'foreign-agent', botNpub: 'npub1botone', managedByNpub: 'npub1othermanager' });

    await expect(manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage(),
    })).rejects.toThrow('No active bot key exists for this user');

    await expect(manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage(),
      agentProfileId: 'missing-agent',
    })).rejects.toThrow('was not found');

    await expect(manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage(),
      agentProfileId: 'foreign-agent',
    })).rejects.toThrow('owned by another manager');

    expect(backendStore.listForManagerNpub('npub1manager')).toHaveLength(0);
  });

  test('rejects a subscription that references a foreign backend connection', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore, store } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });
    const foreignBackend = saveBackendConnection(backendStore, { managedByNpub: 'npub1othermanager' });

    await expect(manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId: foreignBackend.backendConnectionId,
      agentProfileId: 'wm-one',
    })).rejects.toThrow('is not available to this manager');

    expect(store.listForManagerNpub('npub1manager')).toHaveLength(0);
  });

  test('allows a selected user grant to create a subscription on a managed backend connection', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });
    const sharedBackend = saveBackendConnection(backendStore, {
      managedByNpub: 'npub1owner',
      backendBaseUrl: 'https://shared-tower.example.com',
    });
    backendStore.replaceAvailabilityGrants({
      backendConnectionId: sharedBackend.backendConnectionId,
      managerNpubs: ['npub1manager'],
    });

    const subscription = await manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://ignored-input.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId: sharedBackend.backendConnectionId,
      agentProfileId: 'wm-one',
    });

    expect(subscription.backendConnectionId).toBe(sharedBackend.backendConnectionId);
    expect(subscription.backendBaseUrl).toBe('https://shared-tower.example.com');
    expect(manager.listBackendConnectionsForManager('npub1manager').map((record) => record.backendConnectionId))
      .toContain(sharedBackend.backendConnectionId);
  });

  test('creates a selected-user subscription from backend setup hints without repeated fields', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });
    const sharedBackend = saveBackendConnection(backendStore, {
      managedByNpub: 'npub1owner',
      backendBaseUrl: 'https://shared-hints.example.com',
      setupWorkspaceOwnerNpub: 'npub1workspacehints',
      setupSourceAppNpub: 'npub1sourcehints',
      setupSourceAppSchemaNamespace: 'cowork',
      setupCapabilityDefaults: ['chat_intercept', 'task_dispatch'],
    });
    backendStore.replaceAvailabilityGrants({
      backendConnectionId: sharedBackend.backendConnectionId,
      managerNpubs: ['npub1manager'],
    });

    const subscription = await manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: '',
      backendBaseUrl: '',
      sourceAppNpub: '',
      backendConnectionId: sharedBackend.backendConnectionId,
      agentProfileId: 'wm-one',
    });

    expect(subscription.backendConnectionId).toBe(sharedBackend.backendConnectionId);
    expect(subscription.backendBaseUrl).toBe('https://shared-hints.example.com');
    expect(subscription.workspaceOwnerNpub).toBe('npub1workspacehints');
    expect(subscription.sourceAppNpub).toBe('npub1sourcehints');
    expect(subscription.sourceAppSchemaNamespace).toBe('cowork');
    expect(subscription.capabilityDefaults).toEqual(['chat_intercept', 'task_dispatch']);
  });

  test('backfills legacy direct subscriptions into reusable backend connections once', () => {
    const dbPath = makeTempDb();
    const botKeys = new Map<string, BotKeyStoreRecord>();
    const { manager, store, backendStore } = createTestManager(dbPath, botKeys);
    const legacy = store.save(store.createDefault({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://legacy-tower.example.com/',
      botNpub: 'npub1legacybot',
      sourceAppNpub: 'npub1sourceapp',
      sourceAppSchemaNamespace: 'cowork',
      capabilityDefaults: ['chat_intercept'],
    }));

    const first = manager.backfillLegacyBackendConnections();
    const linked = store.getBySubscriptionId(legacy.subscriptionId);
    const backends = backendStore.listForManagerNpub('npub1manager');
    const second = manager.backfillLegacyBackendConnections();

    expect(first).toEqual({ backfilled: 1, linkedSubscriptions: 1 });
    expect(second).toEqual({ backfilled: 0, linkedSubscriptions: 0 });
    expect(backends).toHaveLength(1);
    expect(backends[0]?.backendBaseUrl).toBe('https://legacy-tower.example.com');
    expect(backends[0]?.setupWorkspaceOwnerNpub).toBe('npub1workspace');
    expect(backends[0]?.setupSourceAppNpub).toBe('npub1sourceapp');
    expect(backends[0]?.setupCapabilityDefaults).toEqual(['chat_intercept']);
    expect(linked?.backendConnectionId).toBe(backends[0]?.backendConnectionId);
    expect(linked?.wsKeyBlobJson).toBeNull();
  });

  test('rejects an unlisted user for a selected-users backend connection', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore, store } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });
    const sharedBackend = saveBackendConnection(backendStore, {
      managedByNpub: 'npub1owner',
      backendBaseUrl: 'https://selected-tower.example.com',
    });
    backendStore.replaceAvailabilityGrants({
      backendConnectionId: sharedBackend.backendConnectionId,
      managerNpubs: ['npub1anothermanager'],
    });

    await expect(manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://ignored-input.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId: sharedBackend.backendConnectionId,
      agentProfileId: 'wm-one',
    })).rejects.toThrow('is not available to this manager');

    expect(store.listForManagerNpub('npub1manager')).toHaveLength(0);
  });

  test('requires the explicit shared-service marker to use a shared-service backend grant', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });
    const sharedServiceBackend = saveBackendConnection(backendStore, {
      managedByNpub: 'npub1owner',
      backendBaseUrl: 'https://service-tower.example.com',
    });
    backendStore.replaceAvailabilityGrants({
      backendConnectionId: sharedServiceBackend.backendConnectionId,
      sharedService: true,
    });

    await expect(manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://ignored-input.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId: sharedServiceBackend.backendConnectionId,
      agentProfileId: 'wm-one',
    })).rejects.toThrow('is not available to this manager');

    const subscription = await manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://ignored-input.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId: sharedServiceBackend.backendConnectionId,
      backendConnectionGrantKind: 'shared_service',
      agentProfileId: 'wm-one',
    });

    expect(subscription.backendConnectionId).toBe(sharedServiceBackend.backendConnectionId);
    expect(subscription.backendBaseUrl).toBe('https://service-tower.example.com');
  });

  test('reports missing backend connection ids as not found', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });

    await expect(manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://tower.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId: 'missing-backend',
      agentProfileId: 'wm-one',
    })).rejects.toMatchObject({
      code: 'backend_connection_not_found',
      statusCode: 404,
    });
  });

  test('creates a subscription that references an owned backend connection', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });
    const ownedBackend = saveBackendConnection(backendStore, {
      managedByNpub: 'npub1manager',
      backendBaseUrl: 'https://owned-tower.example.com',
    });

    const subscription = await manager.createOrUpdate({
      managedByNpub: 'npub1manager',
      workspaceOwnerNpub: 'npub1workspace',
      backendBaseUrl: 'https://ignored-input.example.com',
      sourceAppNpub: 'npub1sourceapp',
      backendConnectionId: ownedBackend.backendConnectionId,
      agentProfileId: 'wm-one',
    });

    expect(subscription.backendConnectionId).toBe(ownedBackend.backendConnectionId);
    expect(subscription.backendBaseUrl).toBe('https://owned-tower.example.com');
    expect(subscription.managedByNpub).toBe('npub1manager');
  });

  test('persists degraded backend health when Agent Connect has no health URL', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore } = createTestManager(dbPath, botKeys);
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });

    await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage({
        service: {
          direct_https_url: 'https://tower.example.com',
          service_npub: 'npub1service',
        },
      }),
      agentProfileId: 'wm-one',
    });

    const [backend] = backendStore.listForManagerNpub('npub1manager');
    expect(backend?.healthStatus).toBe('degraded');
    expect(backend?.lastHealthResult?.code).toBe('backend_health_unavailable');
  });

  test('persists unhealthy backend health diagnostics during Agent Connect import', async () => {
    const dbPath = makeTempDb();
    const botKeys = new Map([['npub1botone', makeBotKeyRecord('npub1botone')]]);
    const { manager, agentStore, backendStore } = createTestManager(
      dbPath,
      botKeys,
      async () => ({
        healthStatus: 'unhealthy',
        diagnostic: {
          ok: false,
          code: 'backend_health_failed',
          message: 'Service unavailable',
          at: new Date().toISOString(),
          details: { detailCode: 'backend_health_http_error' },
        },
      }),
    );
    saveAgent(agentStore, { agentId: 'wm-one', botNpub: 'npub1botone', managedByNpub: 'npub1manager' });

    await manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager',
      packageJson: makeConnectPackage(),
      agentProfileId: 'wm-one',
    });

    const [backend] = backendStore.listForManagerNpub('npub1manager');
    expect(backend?.healthStatus).toBe('unhealthy');
    expect(backend?.lastHealthResult?.message).toBe('Service unavailable');
  });
});
