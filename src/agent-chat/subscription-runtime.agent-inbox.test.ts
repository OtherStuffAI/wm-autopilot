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
      if (request.url.endsWith('/agent-notifications/access-profile') && request.method === 'PUT') return Response.json({ actor_npub: botNpub, profile: 'notification_only' });
      if (request.url.endsWith('/agent-notifications/access-profile') && request.method === 'GET') return Response.json({ actor_npub: botNpub, profile: null });
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
    // Explicit self-classification is signed by the profile's own key and goes only to the inbox access-profile route.
    towerRequests.length = 0;
    await manager.setAgentInboxModeForManager(subscriptionId, 'npub1manager', 'inbox_required', { classify: true });
    const classify = towerRequests.find((r) => r.url.endsWith('/agent-notifications/access-profile'));
    expect(classify?.auth.pubkey).toBe(botPubkeyHex);
    await expect(manager.setAgentInboxModeForManager(subscriptionId, 'npub1manager', 'legacy', { classify: true })).rejects.toThrow();
    // A newly connected bot can never be moved back to the broad legacy feed.
    await expect(manager.setAgentInboxModeForManager(subscriptionId, 'npub1manager', 'legacy')).rejects.toMatchObject({ statusCode: 409, detailCode: 'agent_inbox_downgrade_refused' });
    expect(inboxStore.get(subscriptionId)?.mode).toBe('inbox_required');
  });

  test('inbox-first import opts in before ANY connection: no /me, /events, audience or raw reads from creation onward', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-first-'));
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
    const towerUrls: string[] = [];
    const towerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      towerUrls.push(request.url);
      if (request.url.includes('/agent-notifications/subscriptions')) {
        return Response.json({ recipient_npub: botNpub, created: true, subscription: { id: 'tower-sub', consumer_id: 'c', floor_at: now, policy_version: 1, acked_through_seq: 0 }, cursor: 'tower-sub~c0' }, { status: 201 });
      }
      if (request.url.includes('/agent-notifications?')) return Response.json({ subscription_id: 'tower-sub', notifications: [], next_cursor: 'tower-sub~c0', has_more: false });
      if (request.url.endsWith('/agent-notifications/access-profile')) return Response.json({ actor_npub: botNpub, profile: 'notification_only' });
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });
    const record = (name: string) => async () => { calls.push(name); throw new Error(`${name} must not be called`); };
    manager = new WorkspaceSubscriptionManager({
      store: new WorkspaceSubscriptionStore(dbPath), agentStore, backendStore: new BackendConnectionStore(dbPath), profilePolicyStore: new AgentProfilePolicyStore(dbPath),
      agentInboxStore: inboxStore,
      agentInboxFetch: towerFetch,
      checkBackendHealth: async () => ({ healthStatus: 'healthy', diagnostic: { ok: true, code: null, message: 'ok', at: now, details: {} } }),
      fetchFlightDeckPgWorkspaceMe: record('me'),
      fetchFlightDeckPgEvents: record('events'),
      reconcileFlightDeckPgEventSubscriptionAgents: record('audience'),
      fetchFlightDeckPgChannelMessages: record('messages'),
      botKeyStore: { getActiveKeyForUser: () => null, getActiveKeyForBotNpub: (npub: string) => (npub === botNpub ? keyRecord : null) },
      brokerKeyVault: { provision: () => undefined, remove: async () => undefined, withKey: async (_record: unknown, operation: (key: Uint8Array) => unknown) => operation(new Uint8Array(secret)) },
      getInstanceIdentity: () => null,
      dispatchAgentWorkingDirectory: join(dir, 'dispatch'),
      flightDeckPgEventPollIntervalMs: 50,
    } as any);
    const imported = await manager.importAgentConnectPackage({ managedByNpub: 'npub1manager', agentProfileId: 'wm-one', packageJson: connectPackage() as any, onboardingSource: 'manual', agentInboxMode: 'inbox_required' } as any);
    const subscriptionId = imported.subscription.subscriptionId;
    expect(inboxStore.get(subscriptionId)?.mode).toBe('inbox_required');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !towerUrls.some((url) => url.includes('/agent-notifications?'))) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls).toEqual([]);
    expect(towerUrls.length).toBeGreaterThan(0);
    expect(towerUrls.every((url) => url.includes('/agent-notifications'))).toBe(true);
    expect(manager.getForManager(subscriptionId, 'npub1manager')?.recentDispatches ?? []).toEqual([]);
    // A recovered inbox poll clears its own stale poll failure (health no longer stuck degraded after recovery).
    const store = (manager as any).store as WorkspaceSubscriptionStore;
    store.save({ ...store.getBySubscriptionId(subscriptionId)!, lastEventPollErrorCode: 'agent_inbox_halt:agent_identity_required', lastEventPollErrorAt: now, healthStatus: 'degraded' });
    const healthDeadline = Date.now() + 3000;
    while (Date.now() < healthDeadline && store.getBySubscriptionId(subscriptionId)?.lastEventPollErrorCode) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(store.getBySubscriptionId(subscriptionId)).toMatchObject({ lastEventPollErrorCode: null, healthStatus: 'healthy', sseStatus: 'connected' });
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

describe('safe default onboarding: new bots connect only through their own strict inbox', () => {
  type Harness = { manager: WorkspaceSubscriptionManager; calls: string[]; towerRequests: Array<{ url: string; auth: any; body: string }>;
    inboxStore: AgentInboxStore; store: WorkspaceSubscriptionStore; profilePolicyStore: AgentProfilePolicyStore; agentStore: AgentDefinitionStore };
  const floorAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  function harness(options: { withProfile?: boolean; ceiling?: 'unclassified' | 'classified' | 'refused' } = {}): Harness {
    let classified = options.ceiling === 'classified';
    const dir = mkdtempSync(join(tmpdir(), 'safe-onboarding-'));
    dirs.push(dir);
    const dbPath = join(dir, 'db.sqlite');
    const now = new Date().toISOString();
    const calls: string[] = [];
    const keyRecord: BotKeyStoreRecord = {
      id: 'key-1', userNpub: 'npub1manager', botPubkeyHex, botNpub, displayName: 'bot', encryptedToUser: 'x', encryptedEscrow: 'x', escrowUuid: 'e', isActive: 1, createdAt: now, updatedAt: now,
    };
    const agentStore = new AgentDefinitionStore(dbPath);
    if (options.withProfile !== false) {
      agentStore.save({
        agentId: 'wm-one', label: 'One', botNpub, workspaceOwnerNpub: 'npub1workspace', groupNpubs: [], workingDirectory: dir, managedByNpub: 'npub1manager',
        enabled: true, archived: false, capabilities: ['chat_intercept'], createdAt: now, updatedAt: now,
        directChat: { enabled: true, sessionAgent: 'codex', directory: dir, model: null, idleRetentionMinutes: 60 },
      } as any);
    }
    const inboxStore = new AgentInboxStore(dbPath);
    const store = new WorkspaceSubscriptionStore(dbPath);
    const profilePolicyStore = new AgentProfilePolicyStore(dbPath);
    const towerRequests: Harness['towerRequests'] = [];
    const towerFetch = (async (url: string, init: RequestInit) => {
      const request = { url, method: init.method ?? 'GET' };
      const header = new Headers(init.headers).get('authorization');
      towerRequests.push({ url, auth: header ? JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8')) : null, body: typeof init.body === 'string' ? init.body : '' });
      if (request.url.includes('/agent-notifications/subscriptions')) {
        return Response.json({ recipient_npub: botNpub, created: true, subscription: { id: 'tower-sub', consumer_id: 'c', floor_at: floorAt, policy_version: 1, acked_through_seq: 0 }, cursor: 'tower-sub~c0' }, { status: 201 });
      }
      if (request.url.includes('/agent-notifications?')) return Response.json({ subscription_id: 'tower-sub', notifications: [], next_cursor: 'tower-sub~c0', has_more: false });
      if (request.url.endsWith('/agent-notifications/access-profile') && request.method === 'GET') return Response.json({ actor_npub: botNpub, profile: classified ? 'notification_only' : null });
      if (request.url.endsWith('/agent-notifications/access-profile') && request.method === 'PUT') {
        if (options.ceiling === 'refused') return Response.json({ error: { code: 'agent_identity_required', message: 'Only agent identities can be classified notification-only' } }, { status: 403 });
        classified = true;
        return Response.json({ actor_npub: botNpub, profile: 'notification_only' });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });
    const forbidden = (name: string) => async () => { calls.push(name); throw new Error(`${name} must not be called`); };
    const created = new WorkspaceSubscriptionManager({
      store, agentStore, backendStore: new BackendConnectionStore(dbPath), profilePolicyStore,
      agentInboxStore: inboxStore,
      agentInboxFetch: towerFetch,
      checkBackendHealth: async () => ({ healthStatus: 'healthy', diagnostic: { ok: true, code: null, message: 'ok', at: now, details: {} } }),
      fetchFlightDeckPgWorkspaceMe: forbidden('me'),
      fetchFlightDeckPgEvents: forbidden('events'),
      fetchFlightDeckPgEventSubscriptionAgents: forbidden('audience_read'),
      reconcileFlightDeckPgEventSubscriptionAgents: forbidden('audience'),
      fetchFlightDeckPgChannelMessages: forbidden('messages'),
      botKeyStore: { getActiveKeyForUser: () => null, getActiveKeyForBotNpub: (npub: string) => (npub === botNpub ? keyRecord : null), createKey: forbidden('create_key') },
      brokerKeyVault: { provision: () => undefined, remove: async () => undefined, withKey: async (_record: unknown, operation: (key: Uint8Array) => unknown) => operation(new Uint8Array(secret)) },
      getInstanceIdentity: () => null,
      dispatchAgentWorkingDirectory: join(dir, 'dispatch'),
      flightDeckPgEventPollIntervalMs: 50,
    } as any);
    manager = created;
    return { manager: created, calls, towerRequests, inboxStore, store, profilePolicyStore, agentStore };
  }
  async function expectStrictInboxOnly(h: Harness, subscriptionId: string) {
    expect(h.inboxStore.get(subscriptionId)?.mode).toBe('inbox_required');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !h.towerRequests.some((r) => r.url.includes('/agent-notifications?'))) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.calls).toEqual([]); // no /me, /events, audience read/registration, raw reads or key generation
    expect(h.towerRequests.length).toBeGreaterThan(0);
    for (const request of h.towerRequests) {
      expect(request.url).toContain('/agent-notifications');
      expect(verifyEvent(request.auth)).toBe(true);
      expect(request.auth.pubkey).toBe(botPubkeyHex); // the bound profile's stable signer
    }
    // Tower's notification-only ceiling is verified (self-classifying when absent) before any inbox subscription or poll.
    const firstInbox = h.towerRequests.findIndex((r) => !r.url.endsWith('/access-profile'));
    const ceilingRequests = h.towerRequests.slice(0, firstInbox).map((r) => r.url.endsWith('/access-profile'));
    expect(ceilingRequests.length).toBeGreaterThan(0);
    expect(ceilingRequests.every(Boolean)).toBe(true);
    // The first window is Tower's floor; Autopilot sends no window/backfill of its own.
    const create = h.towerRequests.find((r) => r.url.includes('/agent-notifications/subscriptions'));
    expect(Object.keys(JSON.parse(create!.body))).toEqual(['consumer_id']);
    expect(h.inboxStore.get(subscriptionId)?.floorAt).toBe(floorAt);
  }

  test('AgentConnect import of a new bot without agentInboxMode is strict-inbox only', async () => {
    const h = harness();
    const imported = await h.manager.importAgentConnectPackage({ managedByNpub: 'npub1manager', agentProfileId: 'wm-one', packageJson: connectPackage() as any });
    expect(imported.subscription.agentProfileId).toBe('wm-one');
    expect(imported.subscription.botNpub).toBe(botNpub);
    await expectStrictInboxOnly(h, imported.subscription.subscriptionId);
  });

  test('createOrUpdate (UI/API) of a new bot without agentInboxMode is strict-inbox only', async () => {
    const h = harness();
    const created = await h.manager.createOrUpdate({
      managedByNpub: 'npub1manager', agentProfileId: 'wm-one', workspaceOwnerNpub: 'npub1workspace', workspaceId: 'workspace-1',
      workspaceServiceNpub: 'npub1workspaceone', backendBaseUrl: 'https://tower.example.com', towerServiceNpub: 'npub1service', sourceAppNpub: 'npub1sourceapp',
    });
    await expectStrictInboxOnly(h, created.subscriptionId);
  });

  test('a 33357 discovery addressed to a known profile is strict-inbox only for that profile', async () => {
    const h = harness();
    const imported = await h.manager.importAgentConnectPackage({
      managedByNpub: 'npub1manager', packageJson: connectPackage() as any, onboardingSource: 'nostr_33357',
      discoveryEvent: { eventId: 'event-1', createdAt: Math.floor(Date.now() / 1000), dedupeKey: 'grant-1', recipientNpub: botNpub },
    });
    expect(imported.subscription.agentProfileId).toBe('wm-one');
    await expectStrictInboxOnly(h, imported.subscription.subscriptionId);
  });

  test('omitting the profile, or a partial Flight Deck descriptor, fails closed before any key, backend or Tower request', async () => {
    for (const input of [
      { managedByNpub: 'npub1manager', packageJson: connectPackage() as any },
      { managedByNpub: 'npub1manager', packageJson: connectPackage() as any, onboardingSource: 'nostr_33357' as const,
        discoveryEvent: { eventId: 'event-2', createdAt: 1, dedupeKey: 'grant-2', recipientNpub: 'npub1unknownrecipient' } },
    ]) {
      const h = harness({ withProfile: false });
      await expect(h.manager.importAgentConnectPackage(input)).rejects.toMatchObject({ statusCode: 400, detailCode: 'agent_inbox_profile_required' });
      expect(h.calls).toEqual([]);
      expect(h.towerRequests).toEqual([]);
      expect(h.store.listAll()).toEqual([]);
    }
    const h = harness();
    await expect(h.manager.createOrUpdate({
      managedByNpub: 'npub1manager', agentProfileId: 'wm-one', workspaceOwnerNpub: 'npub1workspace', workspaceId: 'workspace-1',
      backendBaseUrl: 'https://tower.example.com', sourceAppNpub: 'npub1sourceapp',
    })).rejects.toMatchObject({ statusCode: 400, detailCode: 'agent_inbox_flightdeck_pg_required' });
    expect(h.calls).toEqual([]);
    expect(h.store.listAll()).toEqual([]);
  });

  test('a new profile for a bot that already serves a shared record gets its own strict inbox; the shared record is untouched', async () => {
    const h = harness();
    const shared = h.store.save(h.store.createDefault({
      managedByNpub: 'npub1manager', workspaceOwnerNpub: 'npub1workspace', backendBaseUrl: 'https://tower.example.com', towerServiceNpub: 'npub1service',
      workspaceId: 'workspace-1', workspaceServiceNpub: 'npub1workspaceone', botNpub, sourceAppNpub: 'npub1sourceapp',
    }));
    const imported = await h.manager.importAgentConnectPackage({ managedByNpub: 'npub1manager', agentProfileId: 'wm-one', packageJson: connectPackage() as any });
    expect(imported.subscription.subscriptionId).not.toBe(shared.subscriptionId);
    expect(h.store.getBySubscriptionId(shared.subscriptionId)?.agentProfileId ?? null).toBeNull();
    expect(h.inboxStore.get(shared.subscriptionId)?.mode ?? 'legacy').toBe('legacy');
    await expectStrictInboxOnly(h, imported.subscription.subscriptionId);
  });

  test('an existing legacy profile-bound record reconnects with its mode unchanged', async () => {
    const h = harness();
    const existing = h.store.save(h.store.createDefault({
      managedByNpub: 'npub1manager', workspaceOwnerNpub: 'npub1workspace', backendBaseUrl: 'https://tower.example.com', towerServiceNpub: 'npub1service',
      workspaceId: 'workspace-1', workspaceServiceNpub: 'npub1workspaceone', botNpub, sourceAppNpub: 'npub1sourceapp', agentProfileId: 'wm-one',
    }));
    // It stays on its existing legacy path (its /me verify is attempted; this harness refuses it), never a silent conversion.
    const reconnected = await h.manager.createOrUpdate({
      managedByNpub: 'npub1manager', agentProfileId: 'wm-one', workspaceOwnerNpub: 'npub1workspace', workspaceId: 'workspace-1',
      workspaceServiceNpub: 'npub1workspaceone', backendBaseUrl: 'https://tower.example.com', towerServiceNpub: 'npub1service', sourceAppNpub: 'npub1sourceapp',
    });
    expect(reconnected.subscriptionId).toBe(existing.subscriptionId);
    expect(h.calls).toContain('me');
    expect(h.store.listAll().map((record) => record.subscriptionId)).toEqual([existing.subscriptionId]);
    expect(h.inboxStore.get(existing.subscriptionId)?.mode ?? 'legacy').toBe('legacy');
  });

  test('a new bot whose notification-only ceiling Tower refuses never polls or dispatches', async () => {
    const h = harness({ ceiling: 'refused' });
    const imported = await h.manager.importAgentConnectPackage({ managedByNpub: 'npub1manager', agentProfileId: 'wm-one', packageJson: connectPackage() as any });
    const subscriptionId = imported.subscription.subscriptionId;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !h.store.getBySubscriptionId(subscriptionId)?.lastErrorCode) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.store.getBySubscriptionId(subscriptionId)?.lastErrorCode).toBe('agent_inbox_halt:agent_inbox_ceiling_unverified');
    expect(h.towerRequests.length).toBeGreaterThan(0);
    expect(h.towerRequests.every((r) => r.url.endsWith('/agent-notifications/access-profile'))).toBe(true);
    expect(h.calls).toEqual([]);
    expect(h.store.getBySubscriptionId(subscriptionId)?.recentDispatches ?? []).toEqual([]);
    await expect(h.manager.setAgentInboxModeForManager(subscriptionId, 'npub1manager', 'legacy')).rejects.toMatchObject({ detailCode: 'agent_inbox_downgrade_refused' });
  });

  test('an already classified new bot is verified by a read only, without re-classifying', async () => {
    const h = harness({ ceiling: 'classified' });
    const imported = await h.manager.importAgentConnectPackage({ managedByNpub: 'npub1manager', agentProfileId: 'wm-one', packageJson: connectPackage() as any });
    await expectStrictInboxOnly(h, imported.subscription.subscriptionId);
    expect(h.towerRequests.filter((r) => r.url.endsWith('/access-profile')).map((r) => r.auth.tags.find((t: string[]) => t[0] === 'method')?.[1])).toEqual(['GET']);
  });

  test('an existing operator-migrated inbox subscription keeps its explicit rollback', async () => {
    const h = harness();
    const existing = h.store.save({ ...h.store.createDefault({
      managedByNpub: 'npub1manager', workspaceOwnerNpub: 'npub1workspace', backendBaseUrl: 'https://tower.example.com', towerServiceNpub: 'npub1service',
      workspaceId: 'workspace-1', workspaceServiceNpub: 'npub1workspaceone', botNpub, sourceAppNpub: 'npub1sourceapp', agentProfileId: 'wm-one',
    }), sseStatus: 'disabled' });
    h.inboxStore.setMode(existing.subscriptionId, 'inbox_required', `autopilot:${existing.subscriptionId}`);
    expect(h.inboxStore.get(existing.subscriptionId)?.requireNotificationOnly).toBe(false);
    expect((await h.manager.setAgentInboxModeForManager(existing.subscriptionId, 'npub1manager', 'legacy'))?.mode).toBe('legacy');
  });
});
