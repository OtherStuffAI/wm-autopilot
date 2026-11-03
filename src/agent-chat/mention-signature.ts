import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * Canonical hash of a message's structured mentions for the kind-33358 `mentions_sha256` tag (Tower contract): lowercase
 * hex SHA-256 of the UTF-8 bytes of JSON.stringify([{type, npub}, ...]) with lowercase values, entries without both
 * dropped, deduped, sorted by npub then type (code point). An empty list hashes "[]".
 * Sent only for a deliberate self-address; ordinary messages carry no tag.
 */
export function canonicalMentionsSha256(mentions: unknown): string {
  const seen = new Map<string, { type: string; npub: string }>();
  for (const entry of Array.isArray(mentions) ? mentions : []) {
    if (!entry || typeof entry !== 'object') continue;
    const type = String((entry as Record<string, unknown>).type ?? '').toLowerCase();
    const npub = String((entry as Record<string, unknown>).npub ?? '').toLowerCase();
    if (!type || !npub) continue;
    seen.set(`${npub}\u0000${type}`, { type, npub });
  }
  const sorted = [...seen.values()].sort((a, b) => (a.npub < b.npub ? -1 : a.npub > b.npub ? 1 : a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(sorted.map(({ type, npub }) => ({ type, npub }))))));
}

/** Whether structured mentions address the author itself as an agent (a deliberate self-address). */
export function mentionsAddressSelf(mentions: unknown, selfNpub: string): boolean {
  const self = selfNpub.toLowerCase();
  return (Array.isArray(mentions) ? mentions : []).some((entry) => Boolean(entry && typeof entry === 'object'
    && String((entry as Record<string, unknown>).type ?? '').toLowerCase() === 'agent'
    && String((entry as Record<string, unknown>).npub ?? '').toLowerCase() === self));
}
