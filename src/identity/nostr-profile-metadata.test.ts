import { describe, expect, test } from 'bun:test';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, type Event } from 'nostr-tools';

import { fetchNewestNostrProfile } from './nostr-profile-metadata';

function profileEvent(secretKey: Uint8Array, createdAt: number, content: unknown): Event {
  return finalizeEvent({ kind: 0, created_at: createdAt, tags: [], content: JSON.stringify(content) }, secretKey);
}

describe('fetchNewestNostrProfile', () => {
  test('selects the newest valid event deterministically and parses all supported fields', async () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const older = profileEvent(secretKey, 10, { name: 'Old' });
    const newer = profileEvent(secretKey, 20, {
      name: 'short-name', display_name: 'Real Agent', picture: 'https://example.com/avatar.png',
      about: 'Full profile', nip05: 'agent@example.com',
    });
    const malformed = {
      ...JSON.parse(JSON.stringify(profileEvent(secretKey, 30, { name: 'Invalid signature' }))),
      sig: '0'.repeat(128),
    } as Event;
    const pool = {
      querySync: async () => [older, malformed, newer],
      close: () => undefined,
    };

    const result = await fetchNewestNostrProfile({
      npub: nip19.npubEncode(pubkey), relays: ['wss://relay.example'], pool,
    });

    expect(result).toEqual({
      eventId: newer.id,
      createdAt: 20,
      profile: {
        name: 'Real Agent', picture: 'https://example.com/avatar.png',
        about: 'Full profile', nip05: 'agent@example.com',
      },
    });
  });
});
