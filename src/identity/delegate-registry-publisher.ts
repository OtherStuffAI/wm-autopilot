import { nip19 } from 'nostr-tools';

import { publishToRelays, type SignedEvent } from '../ngit/relay-publisher';
import { parseRelays, validateSignedEventFields } from './nostr-event-utils';

interface DelegateRegistryPublishRequest {
  ownerNpub: string;
  signedEvent: unknown;
  expectedDelegatePubkeys: string[];
  requestedRelays?: unknown;
  defaultRelays: string[];
}

function decodeNpubToPubkeyHex(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub') {
    throw new Error('Session identity is not an npub');
  }
  if (typeof decoded.data !== 'string' || !/^[0-9a-fA-F]{64}$/.test(decoded.data)) {
    throw new Error('Invalid npub payload for session identity');
  }
  return decoded.data;
}

function validateSignedDelegateRegistryEvent(
  input: unknown,
  ownerPubkeyHex: string,
  expectedDelegatePubkeys: string[],
): SignedEvent {
  if (!input || typeof input !== 'object') {
    throw new Error('signedEvent must be an object');
  }

  const event = input as Partial<SignedEvent>;
  if (event.kind !== 30078) {
    throw new Error('signedEvent.kind must be 30078');
  }

  const signedEvent = validateSignedEventFields(input, ownerPubkeyHex, 'the authenticated owner');

  const hasDelegatesDTag = signedEvent.tags.some((tag) => tag[0] === 'd' && tag[1] === 'wingman-delegates');
  if (!hasDelegatesDTag) {
    throw new Error('signedEvent must include d-tag wingman-delegates');
  }

  const expected = Array.from(new Set(
    expectedDelegatePubkeys
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => /^[0-9a-f]{64}$/.test(value)),
  ));
  if (expected.length === 0) {
    throw new Error('No expected delegates configured for validation');
  }

  const publishedDelegates = Array.from(new Set(
    signedEvent.tags
      .filter((tag) => tag[0] === 'p' && typeof tag[1] === 'string')
      .map((tag) => String(tag[1]).trim().toLowerCase())
      .filter((value) => /^[0-9a-f]{64}$/.test(value)),
  ));

  if (publishedDelegates.length !== expected.length) {
    throw new Error('signedEvent delegates must match the active bot list exactly');
  }
  const publishedSet = new Set(publishedDelegates);
  const hasMismatch = expected.some((pubkey) => !publishedSet.has(pubkey));
  if (hasMismatch) {
    throw new Error('signedEvent delegates must match the active bot list exactly');
  }

  return signedEvent;
}

export async function publishDelegateRegistryEvent(request: DelegateRegistryPublishRequest) {
  const ownerPubkeyHex = decodeNpubToPubkeyHex(request.ownerNpub);
  const signedEvent = validateSignedDelegateRegistryEvent(
    request.signedEvent,
    ownerPubkeyHex,
    request.expectedDelegatePubkeys,
  );
  const relays = parseRelays(request.requestedRelays, request.defaultRelays);

  if (relays.length === 0) {
    throw new Error('No relays available for publishing');
  }

  const result = await publishToRelays(signedEvent, relays);

  return {
    eventId: signedEvent.id,
    relays,
    ...result,
  };
}
