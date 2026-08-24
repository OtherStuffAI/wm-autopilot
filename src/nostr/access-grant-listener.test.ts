import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { generateSecretKey, getPublicKey } from 'nostr-tools';

import { SBIP0009_ACCESS_GRANT_KIND } from '../access-grants/sbip0009';
import { createAccessGrantListener } from './access-grant-listener';

describe('Access grant listener', () => {
  test('contains no work-session or scheduler sink', () => {
    const source = readFileSync(import.meta.path.replace(/\.test\.ts$/, '.ts'), 'utf8');
    expect(source).not.toContain('createSession');
    expect(source).not.toContain('addPrompt');
    expect(source).not.toContain('dispatchPrompt');
    expect(source).not.toContain('executeJob');
  });

  test('replays current addressable grants without a startup since filter before live subscription', async () => {
    const calls: Array<{ type: string; filter: Record<string, unknown> }> = [];
    const fakePool = {
      async querySync(_relays: string[], filter: Record<string, unknown>) {
        calls.push({ type: 'query', filter });
        return [];
      },
      subscribe(_relays: string[], filter: Record<string, unknown>) {
        calls.push({ type: 'subscribe', filter });
        return { close() {} };
      },
      close() {},
    };
    const recipientSecret = generateSecretKey();
    const recipientPubkeyHex = getPublicKey(recipientSecret);
    const listener = createAccessGrantListener({
      relays: ['wss://relay.example'],
      subscriptionManager: { importAgentConnectPackage: async () => ({}) },
      pool: fakePool,
      replayTimeoutMs: 1,
    });

    listener.subscribe('npub1manager', recipientSecret, recipientPubkeyHex);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls.map((call) => call.type)).toEqual(['query', 'subscribe']);
    expect(calls[0]?.filter).toEqual({
      kinds: [SBIP0009_ACCESS_GRANT_KIND],
      '#p': [recipientPubkeyHex],
    });
    expect(calls[0]?.filter.since).toBeUndefined();
    expect(calls[1]?.filter.since).toBeUndefined();
    listener.shutdown();
  });
});
