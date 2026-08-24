import { verifyEvent } from 'nostr-tools';

import type { SignedEvent } from '../ngit/relay-publisher';

export const RELAY_URL_PATTERN = /^wss?:\/\/.+/i;

export function parseRelays(requestedRelays: unknown, defaultRelays: string[]): string[] {
  if (!Array.isArray(requestedRelays)) {
    return [...defaultRelays];
  }

  const relays = requestedRelays
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0 && RELAY_URL_PATTERN.test(value));

  if (relays.length === 0) {
    return [...defaultRelays];
  }

  return Array.from(new Set(relays));
}

export function isStringArrayArray(value: unknown): value is string[][] {
  if (!Array.isArray(value)) return false;
  return value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'));
}

/**
 * Validates common fields shared by all signed Nostr events.
 * Returns a verified SignedEvent or throws with a descriptive error.
 * Callers should add kind-specific and domain-specific checks before calling this.
 */
export function validateSignedEventFields(
  input: unknown,
  expectedPubkeyHex: string,
  pubkeyErrorLabel: string,
): SignedEvent {
  if (!input || typeof input !== 'object') {
    throw new Error('signedEvent must be an object');
  }

  const event = input as Partial<SignedEvent>;
  if (event.pubkey !== expectedPubkeyHex) {
    throw new Error(`signedEvent.pubkey must match ${pubkeyErrorLabel}`);
  }
  if (typeof event.id !== 'string' || event.id.length === 0) {
    throw new Error('signedEvent.id is required');
  }
  if (typeof event.sig !== 'string' || event.sig.length === 0) {
    throw new Error('signedEvent.sig is required');
  }
  if (!Number.isInteger(event.created_at) || Number(event.created_at) <= 0) {
    throw new Error('signedEvent.created_at must be a positive integer');
  }
  if (typeof event.content !== 'string') {
    throw new Error('signedEvent.content must be a string');
  }
  if (!isStringArrayArray(event.tags)) {
    throw new Error('signedEvent.tags must be an array of string arrays');
  }

  const signedEvent: SignedEvent = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: Number(event.created_at),
    kind: event.kind!,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  };

  if (!verifyEvent(signedEvent)) {
    throw new Error('signedEvent signature verification failed');
  }

  return signedEvent;
}
