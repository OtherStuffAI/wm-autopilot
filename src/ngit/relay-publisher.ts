/**
 * Nostr Relay Publisher
 *
 * Publishes signed Nostr events to a set of relays using SimplePool
 * from nostr-tools. Returns per-relay success/failure results.
 */

import { SimplePool } from "nostr-tools";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignedEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface PublishResult {
  /** Number of relays that accepted the event. */
  successes: number;
  /** Number of relays that rejected or timed out. */
  failures: number;
  /** Per-relay results. */
  results: RelayResult[];
}

export interface RelayResult {
  relay: string;
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

const PUBLISH_TIMEOUT_MS = 10_000;

/**
 * Publish a signed event to the specified relays.
 *
 * Uses nostr-tools SimplePool. Each relay gets an individual
 * publish attempt with a timeout. The pool is closed after all
 * attempts complete.
 */
export async function publishToRelays(
  event: SignedEvent,
  relays: string[],
): Promise<PublishResult> {
  if (relays.length === 0) {
    return { successes: 0, failures: 0, results: [] };
  }

  const pool = new SimplePool();
  const results: RelayResult[] = [];

  try {
    const promises = relays.map(async (relay) => {
      try {
        await Promise.race([
          pool.publish([relay], event as Parameters<typeof pool.publish>[1]),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Publish timeout")), PUBLISH_TIMEOUT_MS),
          ),
        ]);
        results.push({ relay, ok: true });
      } catch (err) {
        results.push({
          relay,
          ok: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    });

    await Promise.allSettled(promises);
  } finally {
    pool.close(relays);
  }

  const successes = results.filter((r) => r.ok).length;
  return {
    successes,
    failures: results.length - successes,
    results,
  };
}

/**
 * Query relays for events matching a filter.
 *
 * Thin wrapper around SimplePool.querySync for reading NIP-34 events.
 */
export async function queryRelays(
  relays: string[],
  filter: { kinds?: number[]; authors?: string[]; "#d"?: string[]; "#a"?: string[]; limit?: number },
): Promise<SignedEvent[]> {
  if (relays.length === 0) return [];

  const pool = new SimplePool();
  try {
    const events = await pool.querySync(relays, filter);
    return events as unknown as SignedEvent[];
  } finally {
    pool.close(relays);
  }
}
