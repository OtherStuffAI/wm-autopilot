import { describe, expect, test } from 'bun:test';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';

import { canonicalMentionsSha256, mentionsAddressSelf } from './mention-signature';
import { createFlightDeckPgChannelMessage } from './tower-client';

describe('canonical structured mentions hash (Tower contract vectors)', () => {
  test('empty and non-list inputs hash "[]"', () => {
    const empty = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
    for (const value of [[], null, undefined, 'x', [null, 5, { type: 'agent' }, { npub: 'npub1x' }]]) expect(canonicalMentionsSha256(value)).toBe(empty);
  });

  test('order, case, labels and duplicates do not change the hash', () => {
    const vector = 'fd225e3addfc26114048437e8cb451fa6e13294aecdf7cabdf026c8cd41537a5';
    expect(canonicalMentionsSha256([{ type: 'agent', npub: 'npub1zzz', label: 'Z' }, { type: 'agent', npub: 'npub1aaa' }])).toBe(vector);
    expect(canonicalMentionsSha256([{ npub: 'NPUB1AAA', type: 'AGENT' }, { type: 'agent', npub: 'npub1zzz' }, { type: 'agent', npub: 'npub1aaa', label: 'dup' }])).toBe(vector);
    expect(canonicalMentionsSha256([{ type: 'person', npub: 'npub1aaa' }, { type: 'agent', npub: 'npub1zzz' }])).not.toBe(vector);
  });

  test('self-address is an agent mention of the author only', () => {
    expect(mentionsAddressSelf([{ type: 'agent', npub: 'NPUB1SELF' }], 'npub1self')).toBe(true);
    expect(mentionsAddressSelf([{ type: 'person', npub: 'npub1self' }, { type: 'agent', npub: 'npub1other' }], 'npub1self')).toBe(false);
    expect(mentionsAddressSelf(undefined, 'npub1self')).toBe(false);
  });
});

describe('chat message instruction signature', () => {
  const secret = generateSecretKey();
  const botNpub = nip19.npubEncode(getPublicKey(secret));
  function send(selfAddress?: { originNotificationId: string; mentions: unknown[] }) {
    const requests: Array<Record<string, any>> = [];
    const botIdentity = {
      botNpub, botPubkeyHex: getPublicKey(secret), botSecret: new Uint8Array(secret),
      towerTransport: { prepare: async (url: string) => url, fetch: async (_url: string | URL, init: RequestInit) => { requests.push(JSON.parse(String(init.body))); return Response.json({ message: { id: 'm-1' } }); } },
    };
    const mentions = [{ type: 'agent', npub: botNpub, label: 'Self' }];
    return createFlightDeckPgChannelMessage({
      backendBaseUrl: 'https://tower.example', workspaceId: 'ws-1', channelId: 'ch-1', threadId: 'th-1', appNpub: 'npub1app',
      botIdentity: botIdentity as any, body: 'Continue', metadata: { mentions }, ...(selfAddress ? { selfAddress } : {}),
    }).then(() => ({ request: requests[0]!, mentions }));
  }

  test('ordinary messages are unchanged: no origin field and no mentions tag', async () => {
    const { request } = await send();
    expect(request.origin_notification_id).toBeUndefined();
    const event = request.message_signature.nostr_event;
    expect(event.tags.map((tag: string[]) => tag[0])).toEqual(['protocol', 'body_sha256', 'workspace_id', 'channel_id', 'thread_id']);
    expect(verifyEvent(event)).toBe(true);
  });

  test('a self-address names the origin and signs the canonical mentions hash', async () => {
    const { request, mentions } = await send({ originNotificationId: '9d1f7d2e-1111-4a2b-8c3d-0123456789ab', mentions: [{ type: 'agent', npub: botNpub, label: 'Self' }] });
    expect(request.origin_notification_id).toBe('9d1f7d2e-1111-4a2b-8c3d-0123456789ab');
    const event = request.message_signature.nostr_event;
    expect(event.tags).toContainEqual(['mentions_sha256', canonicalMentionsSha256(mentions)]);
    expect(event.tags).toContainEqual(['thread_id', 'th-1']);
    expect(verifyEvent(event)).toBe(true);
  });
});
