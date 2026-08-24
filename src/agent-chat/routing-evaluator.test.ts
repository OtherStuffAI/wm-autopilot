import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { AgentDefinitionStore } from './agent-definition-store';
import { ChatInterceptStateStore } from './chat-intercept-state-store';
import { AgentChatRoutingEvaluator, buildLegacyRoutingKey } from './routing-evaluator';
import type { WorkspaceSubscriptionRecord } from './types';

function makeTempDb(): string {
  return join(tmpdir(), `agent-chat-routing-${randomUUID()}.sqlite`);
}

function createSubscription(overrides: Partial<WorkspaceSubscriptionRecord> = {}): WorkspaceSubscriptionRecord {
  const now = new Date().toISOString();
  return {
    subscriptionId: 'sub-1',
    workspaceOwnerNpub: 'npub1workspace',
    backendBaseUrl: 'https://tower.example.com',
    botNpub: 'npub1botshared',
    sourceAppNpub: 'npub1sourceapp',
    wsKeyNpub: null,
    wsKeyStatus: 'active',
    groupKeyStatus: 'active',
    sseStatus: 'connected',
    healthStatus: 'healthy',
    triggerConfigRecordId: null,
    lastSseEventId: null,
    lastAuthOkAt: null,
    lastGroupRefreshAt: null,
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
    ...overrides,
  };
}

describe('AgentChatRoutingEvaluator', () => {
  test('routes a PG message only to its explicitly mentioned agent in the verified workspace', async () => {
    const dbPath = makeTempDb();
    const agentStore = new AgentDefinitionStore(dbPath);
    const interceptStore = new ChatInterceptStateStore(dbPath);
    const now = new Date().toISOString();
    for (const [agentId, botNpub] of [['athena', 'npub1athena'], ['exampleAgent', 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg']] as Array<[string, string]>) {
      agentStore.save({ agentId, label: agentId, botNpub, workspaceOwnerNpub: 'npub1workspace-service', groupNpubs: [],
        workingDirectory: `/tmp/${agentId}`, capabilities: ['chat_intercept'], enabled: true, createdAt: now, updatedAt: now,
        managedByNpub: 'npub1manager' });
    }
    const evaluator = new AgentChatRoutingEvaluator({
      agentStore,
      interceptStore,
      resolveRoutingContext: async () => ({ recordId: 'msg-pg', workspaceId: 'workspace-pg', channelId: 'channel-pg',
        scopeId: 'scope-pg', threadId: 'thread-pg', participantNpubs: [], mentionedNpubs: ['npub1athena'],
        towerAccessVerified: true }),
    });
    const input = {
      subscription: createSubscription({ onboardingSource: 'nostr_33357', workspaceId: 'workspace-pg',
        workspaceServiceNpub: 'npub1workspace-service', botNpub: 'npub1athena' }),
      wsSession: { npub: 'npub1workspacekey', secret: new Uint8Array([1]) }, groupKeys: {}, chatRecordId: 'msg-pg',
      chatRecord: {}, chatMessage: { record_id: 'msg-pg', mentions: [{ npub: 'npub1athena' }] },
    };
    expect((await evaluator.evaluate(input)).assignments.map((row) => row.agent.agentId)).toEqual(['athena']);
    expect((await evaluator.evaluate({ ...input, subscription: { ...input.subscription, workspaceId: 'workspace-other' } })).assignments).toEqual([]);
    expect((await evaluator.evaluate({ ...input, chatMessage: { record_id: 'msg-pg-2', mentions: [{ npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' }] },
      chatRecordId: 'msg-pg-2' })).assignments).toEqual([]);
  });

  test('rejects two local profiles that claim the same routing identity', () => {
    const dbPath = makeTempDb();
    const agentStore = new AgentDefinitionStore(dbPath);
    const interceptStore = new ChatInterceptStateStore(dbPath);
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent_alpha',
      label: 'Alpha',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group-chat'],
      workingDirectory: '/tmp/alpha',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });
    expect(() => agentStore.save({
      agentId: 'agent_beta',
      label: 'Beta',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group-chat'],
      workingDirectory: '/tmp/beta',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    })).toThrow('already bound to profile agent_alpha');
    expect(interceptStore.listAll()).toHaveLength(0);
  });

  test('separates matching chat threads from different subscriptions', async () => {
    const dbPath = makeTempDb();
    const agentStore = new AgentDefinitionStore(dbPath);
    const interceptStore = new ChatInterceptStateStore(dbPath);
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent_alpha',
      label: 'Alpha',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group-chat'],
      workingDirectory: '/tmp/alpha',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const evaluator = new AgentChatRoutingEvaluator({
      agentStore,
      interceptStore,
      resolveRoutingContext: async () => ({
        recordId: 'msg-1',
        channelId: 'chan-1',
        threadId: 'thread-1',
        participantNpubs: ['npub1human'],
      }),
      extractMessageGroupNpubs: () => ['npub1group-chat'],
    });
    const sharedInput = {
      wsSession: {
        npub: 'npub1workspacekey',
        secret: new Uint8Array([1]),
      },
      groupKeys: {},
      chatRecordId: 'msg-1',
      chatRecord: {},
      chatMessage: {
        record_id: 'msg-1',
        sender_npub: 'npub1human',
      },
    };

    const first = await evaluator.evaluate({
      ...sharedInput,
      subscription: createSubscription({ subscriptionId: 'sub-1', backendBaseUrl: 'https://tower-one.example.com' }),
    });
    const second = await evaluator.evaluate({
      ...sharedInput,
      subscription: createSubscription({ subscriptionId: 'sub-2', backendBaseUrl: 'https://tower-two.example.com' }),
    });

    expect(first.assignments).toHaveLength(1);
    expect(second.assignments).toHaveLength(1);
    expect(first.assignments[0]?.intercept.routingKey).toBe(
      'agent-chat:v2:sub-1:npub1workspace:npub1sourceapp:chan-1:thread-1:npub1botshared',
    );
    expect(second.assignments[0]?.intercept.routingKey).toBe(
      'agent-chat:v2:sub-2:npub1workspace:npub1sourceapp:chan-1:thread-1:npub1botshared',
    );
    expect(interceptStore.listAll()).toHaveLength(2);
  });

  test('migrates matching legacy routing keys only for the same subscription', async () => {
    const dbPath = makeTempDb();
    const agentStore = new AgentDefinitionStore(dbPath);
    const interceptStore = new ChatInterceptStateStore(dbPath);
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent_alpha',
      label: 'Alpha',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group-chat'],
      workingDirectory: '/tmp/alpha',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });
    interceptStore.save({
      routingKey: buildLegacyRoutingKey({
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1sourceapp',
        channelId: 'chan-1',
        threadId: 'thread-1',
        agentId: 'agent_alpha',
      }),
      subscriptionId: 'sub-1',
      agentId: 'agent_alpha',
      sessionId: 'session-legacy',
      sessionClass: 'chat',
      workspaceOwnerNpub: 'npub1workspace',
      sourceAppNpub: 'npub1sourceapp',
      channelId: 'chan-1',
      threadId: 'thread-1',
      botNpub: 'npub1botshared',
      lastMessageIdSeen: 'msg-0',
      pendingMessageCount: 1,
      state: 'active',
      lastDecision: 'respond',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const evaluator = new AgentChatRoutingEvaluator({
      agentStore,
      interceptStore,
      resolveRoutingContext: async () => ({
        recordId: 'msg-2',
        channelId: 'chan-1',
        threadId: 'thread-1',
        participantNpubs: ['npub1human'],
      }),
      extractMessageGroupNpubs: () => ['npub1group-chat'],
    });

    const result = await evaluator.evaluate({
      subscription: createSubscription({ subscriptionId: 'sub-1' }),
      wsSession: {
        npub: 'npub1workspacekey',
        secret: new Uint8Array([1]),
      },
      groupKeys: {},
      chatRecordId: 'msg-2',
      chatRecord: {},
      chatMessage: {
        record_id: 'msg-2',
        sender_npub: 'npub1human',
      },
    });

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]?.intercept.sessionId).toBe('session-legacy');
    expect(result.assignments[0]?.intercept.routingKey).toBe(
      'agent-chat:v2:sub-1:npub1workspace:npub1sourceapp:chan-1:thread-1:npub1botshared',
    );
    expect(interceptStore.getByRoutingKey('npub1workspace+npub1sourceapp+chan-1+thread-1+agent_alpha')).toBeNull();
    expect(interceptStore.listBySubscriptionId('sub-1')).toHaveLength(1);
  });

  test('suppresses same-agent duplicates and self-authored bot messages', async () => {
    const dbPath = makeTempDb();
    const agentStore = new AgentDefinitionStore(dbPath);
    const interceptStore = new ChatInterceptStateStore(dbPath);
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent_alpha',
      label: 'Alpha',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group-chat'],
      workingDirectory: '/tmp/alpha',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const evaluator = new AgentChatRoutingEvaluator({
      agentStore,
      interceptStore,
      resolveRoutingContext: async () => ({
        recordId: 'msg-1',
        channelId: 'chan-1',
        threadId: 'thread-1',
        participantNpubs: ['npub1human'],
      }),
      extractMessageGroupNpubs: () => ['npub1group-chat'],
    });

    const subscription = createSubscription();
    await evaluator.evaluate({
      subscription,
      wsSession: {
        npub: 'npub1workspacekey',
        secret: new Uint8Array([1]),
      },
      groupKeys: {},
      chatRecordId: 'msg-1',
      chatRecord: {},
      chatMessage: {
        record_id: 'msg-1',
        sender_npub: 'npub1human',
      },
    });

    const duplicateResult = await evaluator.evaluate({
      subscription,
      wsSession: {
        npub: 'npub1workspacekey',
        secret: new Uint8Array([1]),
      },
      groupKeys: {},
      chatRecordId: 'msg-1',
      chatRecord: {},
      chatMessage: {
        record_id: 'msg-1',
        sender_npub: 'npub1human',
      },
    });
    expect(duplicateResult.assignments).toHaveLength(0);
    expect(duplicateResult.diagnostic.details?.duplicate_suppressed_agent_ids).toEqual(['agent_alpha']);

    const selfResult = await evaluator.evaluate({
      subscription,
      wsSession: {
        npub: 'npub1workspacekey',
        secret: new Uint8Array([1]),
      },
      groupKeys: {},
      chatRecordId: 'msg-2',
      chatRecord: {},
      chatMessage: {
        record_id: 'msg-2',
        sender_npub: 'npub1botshared',
      },
    });
    expect(selfResult.assignments).toHaveLength(0);
    expect(selfResult.diagnostic.details?.self_suppressed_agent_ids).toEqual(['agent_alpha']);
    expect(interceptStore.listBySubscriptionId('sub-1')).toHaveLength(1);
  });

  test('suppresses chat records whose latest updater matches the bot', async () => {
    const dbPath = makeTempDb();
    const agentStore = new AgentDefinitionStore(dbPath);
    const interceptStore = new ChatInterceptStateStore(dbPath);
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent_alpha',
      label: 'Alpha',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group-chat'],
      workingDirectory: '/tmp/alpha',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const evaluator = new AgentChatRoutingEvaluator({
      agentStore,
      interceptStore,
      resolveRoutingContext: async () => ({
        recordId: 'msg-3',
        channelId: 'chan-1',
        threadId: 'thread-1',
        participantNpubs: ['npub1human'],
      }),
      extractMessageGroupNpubs: () => ['npub1group-chat'],
    });

    const result = await evaluator.evaluate({
      subscription: createSubscription(),
      wsSession: {
        npub: 'npub1workspacekey',
        secret: new Uint8Array([1]),
      },
      groupKeys: {},
      chatRecordId: 'msg-3',
      chatRecord: {
        signature_npub: 'npub1botshared',
      },
      chatMessage: {
        record_id: 'msg-3',
        sender_npub: 'npub1workspacekey',
      },
    });

    expect(result.assignments).toHaveLength(0);
    expect(result.diagnostic.details?.self_suppressed_agent_ids).toEqual(['agent_alpha']);
    expect(result.diagnostic.details?.updater_npub).toBe('npub1botshared');
  });

  test('suppresses chat records whose latest updater matches the workspace key', async () => {
    const dbPath = makeTempDb();
    const agentStore = new AgentDefinitionStore(dbPath);
    const interceptStore = new ChatInterceptStateStore(dbPath);
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent_alpha',
      label: 'Alpha',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group-chat'],
      workingDirectory: '/tmp/alpha',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const evaluator = new AgentChatRoutingEvaluator({
      agentStore,
      interceptStore,
      resolveRoutingContext: async () => ({
        recordId: 'msg-4',
        channelId: 'chan-1',
        threadId: 'thread-1',
        participantNpubs: ['npub1human'],
      }),
      extractMessageGroupNpubs: () => ['npub1group-chat'],
    });

    const subscription = createSubscription();
    subscription.wsKeyNpub = 'npub1workspacekey';
    const result = await evaluator.evaluate({
      subscription,
      wsSession: {
        npub: 'npub1workspacekey',
        secret: new Uint8Array([1]),
      },
      groupKeys: {},
      chatRecordId: 'msg-4',
      chatRecord: {
        signature_npub: 'npub1workspacekey',
      },
      chatMessage: {
        record_id: 'msg-4',
        sender_npub: 'npub1workspacekey',
      },
    });

    expect(result.assignments).toHaveLength(0);
    expect(result.diagnostic.details?.self_suppressed_agent_ids).toEqual(['agent_alpha']);
    expect(result.diagnostic.details?.updater_npub).toBe('npub1workspacekey');
  });

  test('suppresses chat messages whose sender matches the workspace key even when the updater is external', async () => {
    const dbPath = makeTempDb();
    const agentStore = new AgentDefinitionStore(dbPath);
    const interceptStore = new ChatInterceptStateStore(dbPath);
    const now = new Date().toISOString();

    agentStore.save({
      agentId: 'agent_alpha',
      label: 'Alpha',
      botNpub: 'npub1botshared',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group-chat'],
      workingDirectory: '/tmp/alpha',
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const evaluator = new AgentChatRoutingEvaluator({
      agentStore,
      interceptStore,
      resolveRoutingContext: async () => ({
        recordId: 'msg-5',
        channelId: 'chan-1',
        threadId: 'thread-1',
        participantNpubs: ['npub1human'],
      }),
      extractMessageGroupNpubs: () => ['npub1group-chat'],
    });

    const subscription = createSubscription();
    subscription.wsKeyNpub = 'npub1workspacekey';
    const result = await evaluator.evaluate({
      subscription,
      wsSession: {
        npub: 'npub1workspacekey',
        secret: new Uint8Array([1]),
      },
      groupKeys: {},
      chatRecordId: 'msg-5',
      chatRecord: {
        signature_npub: 'npub1human',
      },
      chatMessage: {
        record_id: 'msg-5',
        sender_npub: 'npub1workspacekey',
      },
    });

    expect(result.assignments).toHaveLength(0);
    expect(result.diagnostic.details?.self_suppressed_agent_ids).toEqual(['agent_alpha']);
    expect(result.diagnostic.details?.sender_npub).toBe('npub1workspacekey');
  });
});
