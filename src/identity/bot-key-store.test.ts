import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BotKeyStore } from './bot-key-store';

describe('BotKeyStore sovereign profiles', () => {
  test('keeps multiple active identities for one managing owner and routes by bot npub', () => {
    const store = new BotKeyStore(join(tmpdir(), `bot-key-profiles-${randomUUID()}.sqlite`));
    const create = (botNpub: string) => store.createKey({
      userNpub: 'npub1owner',
      botPubkeyHex: botNpub.padEnd(64, '0').slice(0, 64),
      botNpub,
      displayName: botNpub,
      encryptedToUser: 'encrypted-user',
      encryptedEscrow: 'encrypted-vault',
      escrowUuid: randomUUID(),
    });
    const exampleAgent = create('npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg');
    const Builder = create('npub1Builder');

    expect(store.listActiveKeysForUser('npub1owner').map((row) => row.botNpub).sort()).toEqual(['npub1Builder', 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg']);
    expect(store.getActiveKeyForBotNpub(Builder.botNpub)?.id).toBe(Builder.id);
    expect([exampleAgent.id, Builder.id].includes(store.getActiveKeyForUser('npub1owner')?.id ?? '')).toBe(true);
  });
});
