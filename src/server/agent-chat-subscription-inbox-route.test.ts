import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

import { AgentDefinitionStore } from '../agent-chat/agent-definition-store';
import { AgentInboxStore } from '../agent-chat/agent-inbox-store';
import { AgentProfilePolicyStore } from '../agent-chat/agent-profile-policy-store';
import { BackendConnectionStore } from '../agent-chat/backend-connection-store';
import { WorkspaceSubscriptionManager } from '../agent-chat/subscription-runtime';
import { WorkspaceSubscriptionStore } from '../agent-chat/workspace-subscription-store';
import type { BotKeyStoreRecord } from '../agent-chat/types';
import { handleAgentChatApi } from './agent-chat-routes';

const dirs: string[] = [];
let manager: WorkspaceSubscriptionManager | null = null;
afterEach(() => {
  manager?.shutdown();
  manager = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const secret = generateSecretKey();
const botPubkeyHex = getPublicKey(secret);
const botNpub = nip19.npubEncode(botPubkeyHex);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-route-'));
  dirs.push(dir);
  const dbPath = join(dir, 'db.sqlite');
  const now = new Date().toISOString();
  const broad: string[] = [];
  const towerUrls: string[] = [];
  const keyRecord: BotKeyStoreRecord = {
    id: 'key-1', userNpub: 'npub1manager', botPubkeyHex, botNpub, displayName: 'bot', encryptedToUser: 'x', encryptedEscrow: 'x', escrowUuid: 'e', isActive: 1, createdAt: now, updatedAt: now,
  };
  const agentStore = new AgentDefinitionStore(dbPath);
  agentStore.save({
    agentId: 'wm-one', label: 'One', botNpub, workspaceOwnerNpub: 'npub1workspace', groupNpubs: [], workingDirectory: dir, managedByNpub: 'npub1manager',
    enabled: true, archived: false, capabilities: ['chat_intercept'], createdAt: now, updatedAt: now,
    directChat: { enabled: true, sessionAgent: 'codex', directory: dir, model: null, idleRetentionMinutes: 60 },
  } as any);
  const inboxStore = new AgentInboxStore(dbPath);
  const deny = (name: string) => async () => { broad.push(name); throw new Error(`${name} must not be called`); };
  manager = new WorkspaceSubscriptionManager({
    store: new WorkspaceSubscriptionStore(dbPath), agentStore, backendStore: new BackendConnectionStore(dbPath), profilePolicyStore: new AgentProfilePolicyStore(dbPath),
    agentInboxStore: inboxStore,
    agentInboxFetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      towerUrls.push(request.url);
      if (request.url.includes('/agent-notifications/subscriptions')) {
        return Response.json({ recipient_npub: botNpub, created: true, subscription: { id: 'tower-sub', consumer_id: 'c', floor_at: now, policy_version: 1, acked_through_seq: 0 }, cursor: 'tower-sub~c0' }, { status: 201 });
      }
      if (request.url.includes('/agent-notifications?')) return Response.json({ subscription_id: 'tower-sub', notifications: [], next_cursor: 'tower-sub~c0', has_more: false });
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }),
    checkBackendHealth: async () => ({ healthStatus: 'healthy', diagnostic: { ok: true, code: null, message: 'ok', at: now, details: {} } }),
    fetchFlightDeckPgWorkspaceMe: deny('me'),
    fetchFlightDeckPgEvents: deny('events'),
    reconcileFlightDeckPgEventSubscriptionAgents: deny('audience'),
    fetchFlightDeckPgChannelMessages: deny('messages'),
    botKeyStore: { getActiveKeyForUser: () => null, getActiveKeyForBotNpub: (npub: string) => (npub === botNpub ? keyRecord : null) },
    brokerKeyVault: { provision: () => undefined, remove: async () => undefined, withKey: async (_record: unknown, operation: (key: Uint8Array) => unknown) => operation(new Uint8Array(secret)) },
    getInstanceIdentity: () => null,
    dispatchAgentWorkingDirectory: join(dir, 'dispatch'),
    flightDeckPgEventPollIntervalMs: 50,
  } as any);
  return { inboxStore, broad, towerUrls };
}

const body = (patch: Record<string, unknown>) => ({
  workspaceOwnerNpub: 'npub1workspace', backendBaseUrl: 'https://tower.example.com', sourceAppNpub: 'npub1sourceapp',
  towerServiceNpub: 'npub1service', workspaceId: 'workspace-1', workspaceServiceNpub: 'npub1workspaceone', ...patch,
});
async function post(payload: Record<string, unknown>) {
  const request = new Request('http://localhost/api/agent-chat/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return await handleAgentChatApi(request, new URL(request.url), 'POST', { npub: 'npub1manager', session: null }, { manager: manager! });
}

describe('POST /api/agent-chat/subscriptions agentInboxMode', () => {
  test('inbox_required on a profile-bound create opts in before connecting: no /me, /events, audience or raw reads', async () => {
    const { inboxStore, broad, towerUrls } = setup();
    const response = await post(body({ agentProfileId: 'wm-one', agentInboxMode: 'inbox_required' }));
    const json = await response!.json();
    expect([response!.status, json.error]).toEqual([200, undefined]);
    const subscriptionId = json.subscription.subscriptionId as string;
    expect(inboxStore.get(subscriptionId)?.mode).toBe('inbox_required');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !towerUrls.some((url) => url.includes('/agent-notifications?'))) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(broad).toEqual([]);
    expect(towerUrls.length).toBeGreaterThan(0);
    expect(towerUrls.every((url) => url.includes('/agent-notifications'))).toBe(true);
  });

  test('rejects unknown modes and inbox mode without a profile, before creating anything', async () => {
    const { broad } = setup();
    for (const [payload, message] of [
      [body({ agentProfileId: 'wm-one', agentInboxMode: 'legacy' }), 'must be inbox_required'],
      [body({ agentProfileId: 'wm-one', agentInboxMode: true }), 'must be inbox_required'],
      [body({ agentInboxMode: 'inbox_required' }), 'explicit agentProfileId'],
    ] as const) {
      const response = await post(payload);
      expect(response!.status).toBe(400);
      expect((await response!.json()).error).toContain(message);
    }
    expect(manager!.listForManager('npub1manager')).toEqual([]);
    expect(broad).toEqual([]);
  });
});
