import { describe, expect, test } from 'bun:test';
import { createDirectChatProfileIdentityRunner } from './direct-chat-profile-identity';

const turn = { turnId: 'turn', agentId: 'Builder', agentNpub: 'npub1Builder' } as any;
const profile = { agentId: 'Builder', botNpub: 'npub1Builder', enabled: true, archived: false } as any;

describe('direct chat profile identity binding', () => {
  test('resolves the exact enabled profile selected by the durable turn', async () => {
    const runner = createDirectChatProfileIdentityRunner({
      agentStore: { getByAgentId: (id) => id === 'Builder' ? profile : null },
      withBotIdentity: async (agent, operation) => operation({ botNpub: agent.botNpub,
        botPubkeyHex: '00'.repeat(32), botSecret: new Uint8Array(32) }),
    });
    expect(await runner(turn, async (identity) => identity.botNpub)).toBe('npub1Builder');
  });

  test('fails closed for unknown, disabled, and cross-agent profile bindings', async () => {
    for (const candidate of [null, { ...profile, enabled: false }, { ...profile, botNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' }]) {
      const runner = createDirectChatProfileIdentityRunner({
        agentStore: { getByAgentId: () => candidate },
        withBotIdentity: async (_agent, operation) => operation({ botNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg',
          botPubkeyHex: '00'.repeat(32), botSecret: new Uint8Array(32) }),
      });
      await expect(runner(turn, async () => 'published')).rejects.toMatchObject({
        integrityClass: candidate?.enabled === false || candidate === null ? 'profile_unavailable' : 'profile_turn_identity_mismatch',
      });
    }
  });
});
