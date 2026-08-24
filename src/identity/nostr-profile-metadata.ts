import { SimplePool, nip19, verifyEvent, type Event } from 'nostr-tools';

export interface NostrPublicProfile {
  name: string;
  picture: string | null;
  about: string | null;
  nip05: string | null;
}

export interface NostrProfileMetadata {
  eventId: string;
  createdAt: number;
  profile: NostrPublicProfile;
}

function decodeNpub(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub' || typeof decoded.data !== 'string') throw new Error('Invalid npub');
  return decoded.data;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function parseNostrProfileEvent(event: Event, pubkey: string): NostrProfileMetadata | null {
  if (event.kind !== 0 || event.pubkey !== pubkey || !verifyEvent(event)) return null;
  try {
    const content = JSON.parse(event.content) as unknown;
    if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
    const metadata = content as Record<string, unknown>;
    const name = optionalText(metadata.display_name) ?? optionalText(metadata.name);
    if (!name) return null;
    return {
      eventId: event.id,
      createdAt: event.created_at,
      profile: {
        name,
        picture: optionalText(metadata.picture) ?? optionalText(metadata.image),
        about: optionalText(metadata.about),
        nip05: optionalText(metadata.nip05),
      },
    };
  } catch {
    return null;
  }
}

export async function fetchNewestNostrProfile(input: {
  npub: string;
  relays: string[];
  timeoutMs?: number;
  pool?: Pick<SimplePool, 'querySync' | 'close'>;
}): Promise<NostrProfileMetadata | null> {
  const pubkey = decodeNpub(input.npub);
  const pool = input.pool ?? new SimplePool();
  const relays = [...new Set(input.relays.map((relay) => relay.trim()).filter(Boolean))].sort();
  if (relays.length === 0) throw new Error('No relays configured for profile lookup');
  try {
    const events = await pool.querySync(relays, { kinds: [0], authors: [pubkey] }, {
      maxWait: input.timeoutMs ?? 4_500,
    });
    return events
      .map((event) => parseNostrProfileEvent(event, pubkey))
      .filter((event): event is NostrProfileMetadata => event !== null)
      .sort((left, right) => right.createdAt - left.createdAt || right.eventId.localeCompare(left.eventId))[0] ?? null;
  } finally {
    pool.close(relays);
  }
}
