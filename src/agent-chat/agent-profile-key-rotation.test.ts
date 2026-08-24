import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, test } from 'bun:test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

import { BotKeyStore, type BotKeyRecord } from '../identity/bot-key-store';
import { BrokerKeyVault } from '../signing/broker-key-vault';
import { AgentDefinitionStore } from './agent-definition-store';
import { AgentProfilePolicyStore } from './agent-profile-policy-store';
import { ChatInterceptStateStore } from './chat-intercept-state-store';
import { DispatchRouteStore } from './dispatch-pipelines/route-store';
import { WorkspaceSubscriptionStore } from './workspace-subscription-store';
import { AgentProfileKeyRotation } from './agent-profile-key-rotation';
import { SchedulerStore } from '../scheduler/scheduler-store';

const roots: string[] = [];

function fixture(fetchImpl?: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), 'wm-key-rotation-'));
  roots.push(root);
  const dbPath = join(root, 'agent-chat.db');
  const botStore = new BotKeyStore(join(root, 'bot-keys.db'));
  const vault = new BrokerKeyVault({ dataDir: root });
  const agentStore = new AgentDefinitionStore(dbPath);
  new AgentProfilePolicyStore(dbPath);
  new ChatInterceptStateStore(dbPath);
  new DispatchRouteStore(dbPath);
  new WorkspaceSubscriptionStore(dbPath);
  const managerSecret = generateSecretKey();
  const managerNpub = nip19.npubEncode(getPublicKey(managerSecret));
  managerSecret.fill(0);
  let oldRecord: BotKeyRecord | null = null;
  const oldIdentity = (() => {
    const secret = generateSecretKey();
    try {
      const pubkey = getPublicKey(secret);
      const npub = nip19.npubEncode(pubkey);
      oldRecord = botStore.createKey({ userNpub: managerNpub, botPubkeyHex: pubkey, botNpub: npub, displayName: 'Builder', encryptedToUser: '', encryptedEscrow: '', escrowUuid: '' });
      vault.provision(oldRecord, secret);
      return npub;
    } finally { secret.fill(0); }
  })();
  agentStore.save({
    agentId: 'Builder', label: 'Builder', botNpub: oldIdentity, workspaceOwnerNpub: managerNpub,
    groupNpubs: [], workingDirectory: '/tmp/Builder', harness: 'codex', model: 'gpt-5.5',
    publicProfile: { name: 'Builder', picture: null, about: 'Builder', nip05: null }, capabilities: ['chat_intercept'],
    directChat: { enabled: true, sessionAgent: 'codex', directory: '/tmp/Builder', model: 'gpt-5.5', idleRetentionMinutes: 60 },
    enabled: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', managedByNpub: managerNpub,
  });
  let revoked = '';
  const events: string[] = [];
  const rotation = new AgentProfileKeyRotation({
    dbPath,
    botKeyStore: {
      getActiveKeyForBotNpub: (npub) => botStore.getActiveKeyForBotNpub(npub),
      createKey: (record) => botStore.createKey(record),
      deactivateKey: (id) => { events.push('deactivate-old-lookup'); botStore.deactivateKey(id); },
      deleteKey: (id) => botStore.deleteKey(id),
    },
    brokerKeyVault: {
      provision: (record, key) => vault.provision(record, key),
      withKey: (record, callback) => vault.withKey(record, callback),
      remove: async (record) => { events.push(record.botNpub === oldIdentity ? 'remove-old-envelope' : 'remove-staged-envelope'); await vault.remove(record); },
    },
    revokeCapabilitiesForBotNpub: (npub) => { events.push('revoke-old-capabilities'); revoked = npub; return 2; },
    publish: async () => ({ relays: 2 }),
    fetchImpl,
  });
  return { dbPath, botStore, vault, agentStore, managerNpub, oldIdentity, oldRecord: oldRecord!, rotation, revoked: () => revoked, events };
}

function input(f: ReturnType<typeof fixture>) {
  return { requestId: 'rotation-request-1', profileId: 'Builder', managedByNpub: f.managerNpub, expectedCurrentNpub: f.oldIdentity, confirmationProfileId: 'Builder', confirmationCurrentNpub: f.oldIdentity };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('AgentProfileKeyRotation', () => {
  test('rotates locally, preserves profile settings, revokes old capabilities, and is idempotent', async () => {
    const f = fixture();
    const scheduler = new SchedulerStore(f.dbPath);
    const scheduled = scheduler.createJob({
      name: 'Builder scheduled work', userNpub: f.managerNpub, botNpub: f.oldIdentity,
      wrappedKeyCiphertext: 'legacy-ciphertext', wrappedKeyNonce: 'legacy-nonce', agent: 'codex',
      workingDirectory: '/tmp/Builder', initialPrompt: 'Work', nightwatchmanEnabled: false,
      triggerType: 'cron', cronExpression: '0 * * * *', actionType: 'session',
    });
    const before = f.agentStore.getByAgentId('Builder')!;
    const result = await f.rotation.rotate(input(f));
    const retried = await f.rotation.rotate(input(f));
    const after = f.agentStore.getByAgentId('Builder')!;

    expect(result.state).toBe('completed');
    expect(result.newNpub).not.toBe(f.oldIdentity);
    const newNpub = result.newNpub!;
    expect(retried).toEqual(result);
    expect(after).toMatchObject({ agentId: before.agentId, label: before.label, botNpub: result.newNpub, workingDirectory: before.workingDirectory, harness: before.harness, model: before.model, directChat: before.directChat });
    expect(f.revoked()).toBe(f.oldIdentity);
    expect(scheduler.getJob(scheduled.id)?.botNpub).toBe(newNpub);
    expect(result.migrations).toContainEqual(expect.objectContaining({ target: 'scheduled_jobs', status: 'completed' }));
    expect(f.botStore.getActiveKeyForBotNpub(f.oldIdentity)).toBeNull();
    const newRecord = f.botStore.getActiveKeyForBotNpub(newNpub);
    expect(newRecord).not.toBeNull();
    await expect(f.vault.withKey(newRecord!, (key) => nip19.npubEncode(getPublicKey(key)))).resolves.toBe(newNpub);
    expect(JSON.stringify(result)).not.toMatch(/nsec|secretKey|private/i);
  });

  test('fails before generation when Tower actor metadata is unavailable', async () => {
    const f = fixture();
    const db = new (await import('bun:sqlite')).Database(f.dbPath);
    db.query(`INSERT INTO workspace_subscriptions (
      subscription_id, workspace_owner_npub, backend_base_url, bot_npub, source_app_npub,
      managed_by_npub, agent_profile_id, workspace_id, ws_key_status, group_key_status, sse_status, health_status,
      created_at, updated_at
    ) VALUES ('sub-1', ?1, 'https://tower.test', ?2, 'app', ?1, 'Builder', 'workspace-1', 'active', 'active', 'connected', 'healthy', ?3, ?3)`)
      .run(f.managerNpub, f.oldIdentity, new Date().toISOString());
    const result = await f.rotation.rotate(input(f));
    expect(result.state).toBe('failed_before_cutover');
    expect(result.newNpub).toBeNull();
    expect(result.migrations[0]?.detail).toContain('stable actor_id');
    expect(f.agentStore.getByAgentId('Builder')?.botNpub).toBe(f.oldIdentity);
  });

  test('calls Tower once for several memberships and exposes completed migration counts', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const f = fixture((async (url: string | URL | Request, init?: RequestInit) => {
      f.events.push('tower-commit');
      requests.push({ url: String(url), init });
      const body = JSON.parse(String(init?.body));
      return Response.json({
        status: 'completed', actor_id: 'actor-1', old_npub: body.old_npub, new_npub: body.new_npub,
        rotation_id: body.rotation_id, proof_event_id: body.proof.id, completed_at: '2026-08-13T00:00:00.000Z',
        migration_counts: { memberships: 2, routes: 1 }, warnings: [],
      });
    }) as typeof fetch);
    const store = new WorkspaceSubscriptionStore(f.dbPath);
    for (const [subscriptionId, workspaceId] of [['sub-1', 'workspace-1'], ['sub-2', 'workspace-2']]) {
      const record = store.createDefault({ managedByNpub: f.managerNpub, workspaceOwnerNpub: f.managerNpub, backendBaseUrl: 'https://tower.test/', workspaceId, botNpub: f.oldIdentity, sourceAppNpub: 'app', agentProfileId: 'Builder' });
      record.subscriptionId = subscriptionId;
      record.lastAuthResult = { ok: true, code: null, message: 'verified', at: new Date().toISOString(), details: { actor_id: 'actor-1' } };
      store.save(record);
    }
    const result = await f.rotation.rotate(input(f));
    expect(result.state).toBe('completed');
    expect(requests).toHaveLength(1);
    expect(result.tower).toMatchObject({ status: 'completed', actorId: 'actor-1', subscriptionCount: 2, migrationCounts: { memberships: 2, routes: 1 } });
    expect(JSON.stringify(result)).not.toMatch(/nsec|secretKey|private/i);
    expect(f.events).toEqual(['tower-commit', 'revoke-old-capabilities', 'deactivate-old-lookup', 'remove-old-envelope']);
  });

  test('uses the selected profile workspace binding and ignores stale legacy subscriptions sharing the npub', async () => {
    const requests: string[] = [];
    const f = fixture((async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(String(url));
      const body = JSON.parse(String(init?.body));
      return Response.json({
        status: 'completed', actor_id: 'actor-selected', old_npub: body.old_npub, new_npub: body.new_npub,
        rotation_id: body.rotation_id, proof_event_id: body.proof.id, completed_at: '2026-08-13T00:00:00.000Z',
        migration_counts: { memberships: 1 }, warnings: [],
      });
    }) as typeof fetch);
    const store = new WorkspaceSubscriptionStore(f.dbPath);
    const selected = store.createDefault({ managedByNpub: f.managerNpub, workspaceOwnerNpub: f.managerNpub, backendBaseUrl: 'https://selected.tower', workspaceId: 'workspace-selected', botNpub: f.oldIdentity, sourceAppNpub: 'app' });
    selected.lastAuthResult = { ok: true, code: null, message: 'verified', at: new Date().toISOString(), details: { actor_id: 'actor-selected' } };
    store.save(selected);
    const stale = store.createDefault({ managedByNpub: f.managerNpub, workspaceOwnerNpub: f.managerNpub, backendBaseUrl: 'https://stale.tower', workspaceId: 'workspace-gone', botNpub: f.oldIdentity, sourceAppNpub: 'app' });
    stale.lastAuthResult = { ok: false, code: 'flightdeck_pg_access_failed', message: 'workspace not found', at: new Date().toISOString(), details: { detailCode: 'workspace_not_found' } };
    store.save(stale);
    const db = new (await import('bun:sqlite')).Database(f.dbPath);
    const now = new Date().toISOString();
    db.query('INSERT INTO agent_profiles(profile_id,managed_by_npub,agent_npub,label,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)')
      .run('Builder', f.managerNpub, f.oldIdentity, 'Builder', now);
    db.query(`INSERT INTO agent_profile_workspaces(
      profile_workspace_id,profile_id,managed_by_npub,subscription_id,workspace_owner_npub,source_app_npub,
      backend_base_url,workspace_id,tower_url,connection_health,yoke_sync_status,relay_onboarding_status,created_at,updated_at
    ) VALUES ('binding-1','Builder',?1,?2,?1,'app','https://selected.tower','workspace-selected','https://selected.tower','healthy','idle','complete',?3,?3)`)
      .run(f.managerNpub, selected.subscriptionId, now);

    const result = await f.rotation.rotate(input(f));
    expect(result.state).toBe('completed');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('selected.tower');
    expect(result.tower).toMatchObject({ actorId: 'actor-selected', workspaceId: 'workspace-selected', subscriptionCount: 1 });
  });

  test('retains the staged key on uncertain transport and retries the identical proof without generating again', async () => {
    const bodies: string[] = [];
    let attempt = 0;
    const f = fixture((async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (attempt++ === 0) throw new Error('socket closed');
      const body = JSON.parse(String(init?.body));
      return Response.json({ status: 'idempotent_replay', actor_id: 'actor-1', old_npub: body.old_npub, new_npub: body.new_npub, rotation_id: body.rotation_id, proof_event_id: body.proof.id, completed_at: '2026-08-13T00:00:00.000Z', migration_counts: { memberships: 1 }, warnings: [] });
    }) as typeof fetch);
    const store = new WorkspaceSubscriptionStore(f.dbPath);
    const record = store.createDefault({ managedByNpub: f.managerNpub, workspaceOwnerNpub: f.managerNpub, backendBaseUrl: 'https://tower.test', workspaceId: 'workspace-1', botNpub: f.oldIdentity, sourceAppNpub: 'app', agentProfileId: 'Builder' });
    record.lastAuthResult = { ok: true, code: null, message: 'verified', at: new Date().toISOString(), details: { actor_id: 'actor-1' } };
    store.save(record);
    const uncertain = await f.rotation.rotate(input(f));
    const retried = await f.rotation.rotate(input(f));
    expect(uncertain.state).toBe('tower_commit_uncertain');
    expect(retried.state).toBe('completed');
    expect(retried.tower.status).toBe('idempotent_replay');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[1]!).new_npub).toBe(uncertain.newNpub);
  });

  test('rejects distinct Tower actors before generation', async () => {
    const f = fixture();
    const store = new WorkspaceSubscriptionStore(f.dbPath);
    for (const actorId of ['actor-1', 'actor-2']) {
      const record = store.createDefault({ managedByNpub: f.managerNpub, workspaceOwnerNpub: f.managerNpub, backendBaseUrl: 'https://tower.test', workspaceId: `workspace-${actorId}`, botNpub: f.oldIdentity, sourceAppNpub: 'app', agentProfileId: 'Builder' });
      record.lastAuthResult = { ok: true, code: null, message: 'verified', at: new Date().toISOString(), details: { actor_id: actorId } };
      store.save(record);
    }
    const result = await f.rotation.rotate(input(f));
    expect(result.state).toBe('failed_before_cutover');
    expect(result.newNpub).toBeNull();
    expect(result.migrations[0]?.detail).toContain('distinct Tower services or stable actors');
  });

  for (const [code, status] of [['invalid_proof', 400], ['stale_identity', 409], ['conflict', 409], ['unsupported_records', 422]] as const) {
    test(`keeps the old identity active and removes the staged key on ${code}`, async () => {
      const f = fixture((async () => Response.json({ code, error: `Tower ${code}` }, { status })) as typeof fetch);
      const store = new WorkspaceSubscriptionStore(f.dbPath);
      const record = store.createDefault({ managedByNpub: f.managerNpub, workspaceOwnerNpub: f.managerNpub, backendBaseUrl: 'https://tower.test', workspaceId: 'workspace-1', botNpub: f.oldIdentity, sourceAppNpub: 'app', agentProfileId: 'Builder' });
      record.lastAuthResult = { ok: true, code: null, message: 'verified', at: new Date().toISOString(), details: { actor_id: 'actor-1' } };
      store.save(record);
      const result = await f.rotation.rotate(input(f));
      expect(result.state).toBe('failed_before_cutover');
      expect(result.tower).toMatchObject({ status: 'failed', errorCode: code });
      expect(f.agentStore.getByAgentId('Builder')?.botNpub).toBe(f.oldIdentity);
      expect(f.botStore.getActiveKeyForBotNpub(f.oldIdentity)).not.toBeNull();
      expect(result.newNpub && f.botStore.getActiveKeyForBotNpub(result.newNpub)).toBeNull();
    });
  }

  test('rejects stale or mismatched confirmation', async () => {
    const f = fixture();
    await expect(f.rotation.rotate({ ...input(f), confirmationProfileId: 'other' })).rejects.toThrow('confirmation does not match');
    await expect(f.rotation.rotate({ ...input(f), expectedCurrentNpub: 'npub1stale', confirmationCurrentNpub: 'npub1stale', requestId: 'rotation-request-2' })).rejects.toThrow('identity changed');
  });
});
