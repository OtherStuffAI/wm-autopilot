import { afterEach, describe, expect, test } from 'bun:test';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';

import { AgentActivityPublisher } from './agent-activity-publisher';
import { AgentActivityPublicationStore } from './agent-activity-publication-store';
import { setLiveSubscriptionIdentityResolver } from './agent-activity-identity';
import { signFlightDeckPgBotRequest } from './tower-client';
import type { RuntimeBotIdentity } from './types';

// Synthetic fixture identities only.
function fixtureIdentity(): RuntimeBotIdentity {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return { botNpub: nip19.npubEncode(pubkey), botPubkeyHex: pubkey, botSecret: secret };
}

const baseContext = (identity: RuntimeBotIdentity) => ({
  subscriptionId: 'sub-1', backendBaseUrl: 'https://tower.test', workspaceId: 'workspace-1', appNpub: 'npub1app',
  botIdentity: identity, channelId: 'channel-1', threadId: 'thread-1', triggerMessageId: 'message-1',
  sessionId: 'session-1', agentNpub: identity.botNpub, turnId: 'turn-1',
});

/** Tower stand-in that verifies the NIP-98 signature each request really carries. */
function authorizingTower() {
  const signers: string[] = [];
  const authorize = async (input: { botIdentity: RuntimeBotIdentity; backendBaseUrl: string }) => {
    const header = await signFlightDeckPgBotRequest({ botIdentity: input.botIdentity, url: `${input.backendBaseUrl}/activity`, method: 'PUT', body: {} });
    const event = JSON.parse(Buffer.from(header.replace(/^Nostr /, ''), 'base64').toString('utf8'));
    expect(verifyEvent(event)).toBe(true);
    signers.push(event.pubkey);
  };
  return {
    signers,
    deliver: (async (input: any) => { await authorize(input); return { agent_activity: { contract_version: 2 } }; }) as any,
    deliverLease: (async (input: any) => {
      await authorize(input);
      return { status: 200, body: { agent_activity: { lease_epoch: 1, lease_sequence: 1 } } };
    }) as any,
  };
}

const quietLog = { error: () => undefined, info: () => undefined };
afterEach(() => setLiveSubscriptionIdentityResolver(null));

/** Mimics the subscription runtime: refresh swaps in a new identity and zeroes the old buffer. */
function liveSubscription(initial: RuntimeBotIdentity) {
  const state: { identity: RuntimeBotIdentity | null } = { identity: initial };
  setLiveSubscriptionIdentityResolver((subscriptionId, botNpub) =>
    subscriptionId === 'sub-1' && state.identity?.botNpub === botNpub ? state.identity : null);
  return {
    refresh(next: RuntimeBotIdentity) { state.identity?.botSecret.fill(0); state.identity = next; },
    remove() { state.identity?.botSecret.fill(0); state.identity = null; },
  };
}

const publisherFor = (identity: RuntimeBotIdentity, tower: ReturnType<typeof authorizingTower>) =>
  new AgentActivityPublisher(baseContext(identity), tower.deliver, 0, undefined, quietLog,
    new AgentActivityPublicationStore(':memory:'), undefined, tower.deliverLease);

describe('activity signer across subscription identity refresh', () => {
  test('captured identity zeroed by a refresh cannot sign (the original failure)', async () => {
    const stale = fixtureIdentity();
    const tower = authorizingTower();
    // Old behavior: every signature uses the buffer captured when the turn started.
    setLiveSubscriptionIdentityResolver(() => stale);
    const publisher = publisherFor(stale, tower);
    await publisher.publish('working', 'before refresh');
    stale.botSecret.fill(0);
    expect(await publisher.heartbeat()).toBe('failed');
    await publisher.publish('working', 'after refresh');
    expect(tower.signers).toEqual([stale.botPubkeyHex]);
  });

  test('commentary, repeated renewals and completion keep signing as the exact bot after refresh', async () => {
    const original = fixtureIdentity();
    const tower = authorizingTower();
    const sub = liveSubscription(original);
    const publisher = publisherFor(original, tower);
    await publisher.publish('accepted');
    expect(await publisher.heartbeat()).toBe('renewed');
    // Same bot, fresh buffer: identity refresh/reconnect mid-turn.
    sub.refresh({ ...original, botSecret: Uint8Array.from(original.botSecret) });
    original.botSecret.fill(0);
    await publisher.publish('working', 'Mid-turn commentary after refresh.');
    expect(await publisher.heartbeat()).toBe('renewed');
    expect(await publisher.heartbeat()).toBe('renewed');
    await publisher.publish('completed');
    expect(tower.signers.length).toBe(6);
    expect(new Set(tower.signers)).toEqual(new Set([original.botPubkeyHex]));
  });

  test('a refresh landing during async URL preparation still signs with the new buffer', async () => {
    const original = fixtureIdentity();
    const tower = authorizingTower();
    const sub = liveSubscription(original);
    const publisher = publisherFor(original, tower);
    await publisher.publish('working', 'first');
    // Refresh while the request is between "identity chosen" and "signature made".
    const racing = (async (input: any) => {
      const pending = signFlightDeckPgBotRequest({ botIdentity: input.botIdentity, url: `${input.backendBaseUrl}/activity`, method: 'PUT', body: {} });
      sub.refresh({ ...original, botSecret: Uint8Array.from(original.botSecret) });
      original.botSecret.fill(0);
      const event = JSON.parse(Buffer.from((await pending).replace(/^Nostr /, ''), 'base64').toString('utf8'));
      expect(verifyEvent(event)).toBe(true);
      tower.signers.push(event.pubkey);
      return { agent_activity: { contract_version: 2 } };
    }) as any;
    const racer = new AgentActivityPublisher(baseContext(original), racing, 0, undefined, quietLog, new AgentActivityPublicationStore(':memory:'),
      undefined, tower.deliverLease);
    await racer.publish('working', 'raced');
    expect(tower.signers).toEqual([original.botPubkeyHex, original.botPubkeyHex]);
  });

  test('subscription-bound activity fails closed when no live resolver is installed', async () => {
    const original = fixtureIdentity();
    const tower = authorizingTower();
    const publisher = publisherFor(original, tower);
    expect(await publisher.heartbeat()).toBe('failed');
    await publisher.publish('working', 'nothing');
    expect(tower.signers).toEqual([]);
  });

  test('removed subscription fails closed and never signs', async () => {
    const original = fixtureIdentity();
    const tower = authorizingTower();
    const sub = liveSubscription(original);
    const publisher = publisherFor(original, tower);
    await publisher.publish('working', 'first');
    sub.remove();
    expect(await publisher.heartbeat()).toBe('failed');
    await publisher.publish('working', 'second');
    await publisher.publish('completed');
    expect(tower.signers.length).toBe(1);
  });

  test('a subscription that changed bot is never used to sign for the old bot', async () => {
    const original = fixtureIdentity();
    const other = fixtureIdentity();
    const tower = authorizingTower();
    const sub = liveSubscription(original);
    const publisher = publisherFor(original, tower);
    await publisher.publish('working', 'first');
    sub.refresh(other);
    expect(await publisher.heartbeat()).toBe('failed');
    await publisher.publish('working', 'second');
    expect(tower.signers).toEqual([original.botPubkeyHex]);
  });
});
