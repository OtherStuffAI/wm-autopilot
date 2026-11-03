import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';

import { AgentDefinitionStore } from './agent-definition-store';
import { AgentInboxStore } from './agent-inbox-store';
import { AgentProfilePolicyStore } from './agent-profile-policy-store';
import { BackendConnectionStore } from './backend-connection-store';
import { WorkspaceSubscriptionManager } from './subscription-runtime';
import { WorkspaceSubscriptionStore } from './workspace-subscription-store';
import type { BotKeyStoreRecord } from './types';

const dirs: string[] = [];
const originalFetch = globalThis.fetch;
let manager: WorkspaceSubscriptionManager | null = null;
afterEach(() => {
  manager?.shutdown();
  manager = null;
  globalThis.fetch = originalFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const secret = generateSecretKey();
const botPubkeyHex = getPublicKey(secret);
const botNpub = nip19.npubEncode(botPubkeyHex);

function connectPackage() {
  const token = Buffer.from(JSON.stringify({ direct_https_url: 'https://tower.example.com', service_npub: 'npub1service', workspace_owner_npub: 'npub1workspace', app_npub: 'npub1sourceapp' })).toString('base64url');
  return {
    kind: 'coworker_agent_connect', version: 5, generated_at: '2026-05-05T00:00:00.000Z',
    service: { direct_https_url: 'https://tower.example.com', service_npub: 'npub1service', health_url: 'https://tower.example.com/health' },
    workspace: { owner_npub: 'npub1workspace', workspace_id: 'workspace-1', workspace_service_npub: 'npub1workspaceone' },
    app: { app_npub: 'npub1sourceapp' }, connection_token: token, capabilities: ['chat_intercept'],
  };
}

describe('strict inbox mode in the subscription runtime', () => {
  test('an opted-in profile never calls /me, /events or audience registration; it reaches only the agent inbox, signed by its own key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-runtime-'));
    dirs.push(dir);
    const dbPath = join(dir, 'db.sqlite');
    const calls: string[] = [];
    const now = new Date().toISOString();
    const keyRecord: BotKeyStoreRecord = {
      id: 'key-1', userNpub: 'npub1manager', botPubkeyHex, botNpub, displayName: 'bot', encryptedToUser: 'x', encryptedEscrow: 'x', escrowUuid: 'e', isActive: 1, createdAt: now, updatedAt: now,
    };
    const agentStore = new AgentDefinitionStore(dbPath);
    agentStore.save({
      agentId: 'wm-one', label: 'One', botNpub, workspaceOwnerNpub: 'npub1workspace', groupNpubs: ['npub1group'], workingDirectory: dir, managedByNpub: 'npub1manager',
      enabled: true, archived: false, capabilities: ['chat_intercept'], createdAt: now, updatedAt: now,
      directChat: { enabled: true, sessionAgent: 'codex', directory: dir, model: null, idleRetentionMinutes: 60 },
    } as any);
    const inboxStore = new AgentInboxStore(dbPath);
    const towerRequests: Array<{ url: string; auth: any }> = [];
    const towerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const header = request.headers.get('authorization');
      towerRequests.push({ url: request.url, auth: header ? JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8')) : null });
      if (request.url.includes('/agent-notifications/subscriptions')) {
        return Response.json({ recipient_npub: botNpub, created: true, subscription: { id: 'tower-sub', consumer_id: 'c', floor_at: now, policy_version: 1, acked_through_seq: 0 }, cursor: 'tower-sub~c0' }, { status: 201 });
      }
      if (request.url.includes('/agent-notifications?')) return Response.json({ subscription_id: 'tower-sub', notifications: [], next_cursor: 'tower-sub~c0', has_more: false });
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });
    manager = new WorkspaceSubscriptionManager({
      store: new WorkspaceSubscriptionStore(dbPath), agentStore, backendStore: new BackendConnectionStore(dbPath), profilePolicyStore: new AgentProfilePolicyStore(dbPath),
      agentInboxStore: inboxStore,
      agentInboxFetch: towerFetch,
      checkBackendHealth: async () => ({ healthStatus: 'healthy', diagnostic: { ok: true, code: null, message: 'ok', at: now, details: {} } }),
      fetchFlightDeckPgWorkspaceMe: async () => { calls.push('me'); return { actor: { actor_id: 'a' }, membership: { role: 'member' }, permissions: [] }; },
      fetchFlightDeckPgEvents: async () => { calls.push('events'); return { events: [], next_cursor: null }; },
      reconcileFlightDeckPgEventSubscriptionAgents: async ({ agentNpubs }) => { calls.push('audience'); return { agent_npubs: [...agentNpubs] }; },
      fetchFlightDeckPgChannelMessages: async () => { calls.push('messages'); return { messages: [], next_cursor: null }; },
      botKeyStore: { getActiveKeyForUser: () => null, getActiveKeyForBotNpub: (npub: string) => (npub === botNpub ? keyRecord : null) },
      brokerKeyVault: { provision: () => undefined, remove: async () => undefined, withKey: async (_record: unknown, operation: (key: Uint8Array) => unknown) => operation(new Uint8Array(secret)) },
      getInstanceIdentity: () => null,
      dispatchAgentWorkingDirectory: join(dir, 'dispatch'),
      flightDeckPgEventPollIntervalMs: 50,
    } as any);
    const imported = await manager.importAgentConnectPackage({ managedByNpub: 'npub1manager', agentProfileId: 'wm-one', packageJson: connectPackage() as any, onboardingSource: 'manual' } as any);
    const subscriptionId = imported.subscription.subscriptionId;
    calls.length = 0;
    towerRequests.length = 0;
    const state = await manager.setAgentInboxModeForManager(subscriptionId, 'npub1manager', 'inbox_required');
    expect(state?.mode).toBe('inbox_required');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !towerRequests.some((r) => r.url.includes('/agent-notifications?'))) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls).toEqual([]); // no /me, /events, audience PUT or raw thread reads
    expect(towerRequests.length).toBeGreaterThan(0);
    for (const request of towerRequests) {
      expect(request.url).toContain('/agent-notifications');
      expect(request.url).not.toContain('audience_npub');
      expect(verifyEvent(request.auth)).toBe(true);
      expect(request.auth.pubkey).toBe(botPubkeyHex); // the profile's own key
      expect(request.auth.tags.some((t: string[]) => t[0] === 'nonce')).toBe(true);
    }
    expect(inboxStore.get(subscriptionId)?.towerSubscriptionId).toBe('tower-sub');
    // Opting out is explicit; the inbox cursor is retained for a later resume.
    expect((await manager.setAgentInboxModeForManager(subscriptionId, 'npub1manager', 'legacy'))?.cursor).toBe('tower-sub~c0');
  });

  test('inbox mode requires a profile-bound subscription', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-runtime-'));
    dirs.push(dir);
    const dbPath = join(dir, 'db.sqlite');
    manager = new WorkspaceSubscriptionManager({
      store: new WorkspaceSubscriptionStore(dbPath), agentStore: new AgentDefinitionStore(dbPath), backendStore: new BackendConnectionStore(dbPath),
      profilePolicyStore: new AgentProfilePolicyStore(dbPath), agentInboxStore: new AgentInboxStore(dbPath),
      botKeyStore: { getActiveKeyForUser: () => null, getActiveKeyForBotNpub: () => null }, getInstanceIdentity: () => null,
    } as any);
    expect(await manager.setAgentInboxModeForManager('missing', 'npub1manager', 'inbox_required')).toBeNull();
  });
});
