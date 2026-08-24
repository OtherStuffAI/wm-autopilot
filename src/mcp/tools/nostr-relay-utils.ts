/**
 * Nostr Relay Utilities for MCP Tools
 *
 * Provides relay querying helpers that run directly in the MCP child
 * process. Uses SimplePool from nostr-tools for lightweight reads.
 */

import { SimplePool } from "nostr-tools";

// ---------------------------------------------------------------------------
// Default relays for reading profiles & notes
// ---------------------------------------------------------------------------

const DEFAULT_READ_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "ws://127.0.0.1:4869",
];

const QUERY_TIMEOUT_MS = 10_000;

/**
 * Resolve relay list: use provided relays, fall back to CONNECT_RELAYS
 * env var, then to the default read relays.
 */
export function resolveRelays(provided?: string[]): string[] {
  if (provided && provided.length > 0) return provided;

  const envRelays = process.env.CONNECT_RELAYS;
  if (envRelays) {
    const parsed = envRelays
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.startsWith("wss://") || r.startsWith("ws://"));
    if (parsed.length > 0) return parsed;
  }

  return DEFAULT_READ_RELAYS;
}

/**
 * Query relays for events matching a filter. Thin wrapper around
 * SimplePool.querySync with a timeout guard.
 */
export async function queryNostrEvents(
  relays: string[],
  filter: {
    kinds?: number[];
    authors?: string[];
    limit?: number;
    since?: number;
    until?: number;
  },
): Promise<NostrEvent[]> {
  if (relays.length === 0) return [];

  const pool = new SimplePool();
  try {
    const events = await Promise.race([
      pool.querySync(relays, filter),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Relay query timeout")), QUERY_TIMEOUT_MS),
      ),
    ]);
    return events as unknown as NostrEvent[];
  } finally {
    pool.close(relays);
  }
}

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}
