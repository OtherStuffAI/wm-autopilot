import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { finalizeEvent, generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';

import { AgentDefinitionStore } from './agent-definition-store';
import { WorkspaceSubscriptionManager } from './subscription-runtime';
import { BotKeyStore } from '../identity/bot-key-store';
import { BrokerKeyVault } from '../signing/broker-key-vault';

const roots: string[] = [];

function fixture(overrides: { provision?: BrokerKeyVault['provision'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-profile-create-'));
  roots.push(root);
  const dbPath = join(root, 'profiles.sqlite');
  const botKeyStore = new BotKeyStore(dbPath);
  const agentStore = new AgentDefinitionStore(dbPath);
  const vault = new BrokerKeyVault({ dataDir: root });
  if (overrides.provision) vault.provision = overrides.provision;
  const manager = new WorkspaceSubscriptionManager({
    agentStore,
    botKeyStore,
    brokerKeyVault: vault,
  });
  const ownerSecret = generateSecretKey();
  const managedByNpub = nip19.npubEncode(getPublicKey(ownerSecret));
  ownerSecret.fill(0);
  return { root, botKeyStore, agentStore, vault, manager, managedByNpub };
}

function createInput(managedByNpub: string) {
  return {
    managedByNpub,
    agentId: 'fresh-agent',
    label: 'Fresh Agent',
    workspaceOwnerNpub: managedByNpub,
    workingDirectory: '/tmp/fresh-agent',
    harness: 'codex',
    publicProfile: { name: 'Fresh Agent', picture: null, about: 'Sovereign', nip05: null },
    capabilities: ['chat_intercept' as const],
    enabled: true,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('sovereign Agent Profile creation', () => {
  test('creates a fresh brokered identity without Key Teleport and survives restart', async () => {
    const prior = process.env.KEYTELEPORT_PRIVKEY;
    delete process.env.KEYTELEPORT_PRIVKEY;
    try {
      const f = fixture();
      const created = await f.manager.createAgentProfileForManager(createInput(f.managedByNpub));
      const record = f.botKeyStore.getActiveKeyForBotNpub(created.agent.botNpub)!;
      expect(record.encryptedToUser).toBe('');
      expect(record.encryptedEscrow).toBe('');
      expect(f.vault.has(record)).toBe(true);
      expect(created.signedProfileEvent.pubkey).toBe(record.botPubkeyHex);
      expect(verifyEvent(created.signedProfileEvent)).toBe(true);
      expect(JSON.stringify(created)).not.toMatch(/nsec|private.?key|secret|capability/i);

      f.vault.destroy();
      const reconstructed = new BrokerKeyVault({ dataDir: f.root });
      const signed = await reconstructed.withKey(record, (key) => finalizeEvent({
        kind: 1, content: 'after restart', tags: [], created_at: 1,
      }, key));
      expect(signed.pubkey).toBe(record.botPubkeyHex);
      expect(verifyEvent(signed)).toBe(true);

      const otherSecret = generateSecretKey();
      const otherRecord = { ...record, botPubkeyHex: getPublicKey(otherSecret), botNpub: nip19.npubEncode(getPublicKey(otherSecret)) };
      otherSecret.fill(0);
      await expect(reconstructed.withKey(otherRecord, () => undefined)).rejects.toThrow(/identity binding/);
    } finally {
      if (prior === undefined) delete process.env.KEYTELEPORT_PRIVKEY;
      else process.env.KEYTELEPORT_PRIVKEY = prior;
    }
  });

  test('removes metadata when vault provisioning fails', async () => {
    const f = fixture({ provision: () => { throw new Error('vault offline'); } });
    await expect(f.manager.createAgentProfileForManager(createInput(f.managedByNpub))).rejects.toThrow('vault offline');
    expect(f.botKeyStore.listActiveKeys()).toHaveLength(0);
    expect(f.agentStore.getByAgentId('fresh-agent')).toBeNull();
  });

  test('compensates agent, metadata, and envelope after a later failure', async () => {
    const f = fixture();
    const created = await f.manager.createAgentProfileForManager(createInput(f.managedByNpub));
    const record = f.botKeyStore.getActiveKeyForBotNpub(created.agent.botNpub)!;
    await f.manager.rollbackCreatedAgentProfile(created.agent.agentId, record);
    expect(f.agentStore.getByAgentId(created.agent.agentId)).toBeNull();
    expect(f.botKeyStore.getActiveKeyForBotNpub(created.agent.botNpub)).toBeNull();
    expect(f.vault.has(record)).toBe(false);
  });
});
