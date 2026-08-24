import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';

import type { RequestAuthContext } from '../auth/request-context';
import { AgentDefinitionStore } from '../agent-chat/agent-definition-store';
import { WorkspaceSubscriptionManager } from '../agent-chat/subscription-runtime';
import { BotKeyStore } from '../identity/bot-key-store';
import { signBotProfileEvent } from '../identity/bot-identity-publisher';
import { BrokerKeyVault } from '../signing/broker-key-vault';
import { handleAgentChatApi } from './agent-chat-routes';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-profile-route-'));
  roots.push(root);
  const dbPath = join(root, 'route.sqlite');
  const botKeyStore = new BotKeyStore(dbPath);
  const agentStore = new AgentDefinitionStore(dbPath);
  const vault = new BrokerKeyVault({ dataDir: root });
  const manager = new WorkspaceSubscriptionManager({ agentStore, botKeyStore, brokerKeyVault: vault });
  const ownerSecret = generateSecretKey();
  const ownerNpub = nip19.npubEncode(getPublicKey(ownerSecret));
  ownerSecret.fill(0);
  const auth: RequestAuthContext = { npub: ownerNpub, actorNpub: ownerNpub, session: null, delegatedByBot: false };
  return { dbPath, botKeyStore, agentStore, vault, manager, ownerNpub, auth };
}

function request(ownerNpub: string) {
  return new Request('http://localhost/api/agent-chat/profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileId: 'route-agent', label: 'Route Agent', workingDirectory: '/tmp/route-agent',
      workspaceOwnerNpub: ownerNpub, harness: 'codex', about: 'Route integration',
    }),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('POST /api/agent-chat/profiles integration', () => {
  test('creates, vaults, publishes, and returns only public identity material', async () => {
    const f = fixture();
    const req = request(f.ownerNpub);
    const response = await handleAgentChatApi(req, new URL(req.url), 'POST', f.auth, {
      manager: f.manager,
      agentTypes: [{ id: 'codex', label: 'Codex' }],
      publishAgentProfile: async ({ event }) => {
        expect(verifyEvent(event)).toBe(true);
        return { eventId: event.id, published: 1 };
      },
    });
    const body = await response!.json() as { agent: { botNpub: string } };
    expect(response?.status).toBe(201);
    const record = f.botKeyStore.getActiveKeyForBotNpub(body.agent.botNpub)!;
    expect(f.vault.has(record)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/nsec|private.?key|botSecret|capabilityToken|bunker/i);
  });

  test('classifies publication failure and compensates all local state', async () => {
    const f = fixture();
    const req = request(f.ownerNpub);
    const response = await handleAgentChatApi(req, new URL(req.url), 'POST', f.auth, {
      manager: f.manager,
      agentTypes: [{ id: 'codex', label: 'Codex' }],
      publishAgentProfile: async () => { throw new Error('relay publication unavailable'); },
    });
    const body = await response!.json() as { code: string };
    expect(response?.status).toBe(502);
    expect(body.code).toBe('agent_profile_publication_failed');
    expect(f.agentStore.getByAgentId('route-agent')).toBeNull();
    expect(f.botKeyStore.listActiveKeys()).toHaveLength(0);
  });

  test('edits and republishes with the unchanged vault identity across store reconstruction', async () => {
    const f = fixture();
    const createReq = request(f.ownerNpub);
    const createdResponse = await handleAgentChatApi(createReq, new URL(createReq.url), 'POST', f.auth, {
      manager: f.manager,
      agentTypes: [{ id: 'codex', label: 'Codex', modelOptions: ['default', 'gpt-5.6'] }],
      publishAgentProfile: async () => ({ published: 1 }),
    });
    const created = await createdResponse!.json() as { agent: { botNpub: string } };
    const editReq = new Request('http://localhost/api/agent-chat/profiles/route-agent', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        botNpub: 'npub1tampered', label: 'Route Agent', workingDirectory: '/Users/example/wingmen/Builder21',
        harness: 'codex', model: null, enabled: false, directChatEnabled: true,
        publicProfile: { name: 'Builder', picture: 'https://example.com/Builder.png', about: 'Updated', nip05: 'Builder@example.com' },
      }),
    });
    const response = await handleAgentChatApi(editReq, new URL(editReq.url), 'PATCH', f.auth, {
      manager: f.manager,
      agentTypes: [{ id: 'codex', label: 'Codex', modelOptions: ['default', 'gpt-5.6'] }],
      republishAgentProfile: async (candidate) => {
        const record = f.botKeyStore.getActiveKeyForBotNpub(candidate.botNpub)!;
        return f.vault.withKey(record, (secretKey) => {
          const event = signBotProfileEvent(secretKey, candidate.publicProfile!.name, candidate.publicProfile);
          expect(event.kind).toBe(0);
          expect(verifyEvent(event)).toBe(true);
          expect(nip19.npubEncode(event.pubkey)).toBe(created.agent.botNpub);
          return { eventId: event.id, createdAt: event.created_at, result: { published: 1 } };
        });
      },
    });
    const body = await response!.json() as { agent: { botNpub: string; workingDirectory: string; directChat: { directory: string } }; published: boolean };
    expect(response?.status).toBe(200);
    expect(body.published).toBe(true);
    expect(body.agent.botNpub).toBe(created.agent.botNpub);
    expect(body.agent.workingDirectory).toBe('/Users/example/wingmen/Builder21');
    expect(body.agent.directChat.directory).toBe('/Users/example/wingmen/Builder21');

    const reconstructed = new AgentDefinitionStore(f.dbPath);
    const reloaded = reconstructed.getByAgentId('route-agent');
    expect(reloaded?.botNpub).toBe(created.agent.botNpub);
    expect(reloaded?.workingDirectory).toBe('/Users/example/wingmen/Builder21');
    expect(reloaded?.publicProfileRefresh).toMatchObject({
      sourceEventId: expect.any(String), sourceEventCreatedAt: expect.any(Number), result: 'published', error: null,
    });
  });
});
