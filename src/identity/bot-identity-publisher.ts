/**
 * Bot Identity Publisher
 *
 * Creates signed Nostr events for bot identity:
 *   - Kind 0: Bot profile (signed by bot key)
 *   - Kind 30078: Delegate registry (unsigned — browser signs with owner NIP-07)
 *
 * Events are signed server-side but returned for the browser to publish.
 * This keeps relay WebSocket connections out of the main server process.
 */

import { finalizeEvent } from "nostr-tools";

import { generateBotWordId } from "./bot-word-id";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignedNostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface DelegateRegistryEntry {
  pubkey: string;
  name: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Kind 0 — Bot Profile
// ---------------------------------------------------------------------------

/**
 * Build and sign a kind 0 profile event for a bot.
 * Must be called while the bot's secret key is still in memory.
 *
 * @param botSecretKey - Raw 32-byte secret key (Uint8Array)
 * @param displayName - Word-id display name (e.g. "bold-oak-kite-wingman")
 * @returns Signed kind 0 event ready for relay publishing
 */
export function signBotProfileEvent(
  botSecretKey: Uint8Array,
  displayName: string,
  metadata: { picture?: string | null; about?: string | null; nip05?: string | null } = {},
): SignedNostrEvent {
  const profile = {
    name: displayName,
    about: metadata.about?.trim() || "Wingman agent",
    ...(metadata.picture?.trim() ? { picture: metadata.picture.trim() } : {}),
    ...(metadata.nip05?.trim() ? { nip05: metadata.nip05.trim() } : {}),
    bot: true,
  };

  const template = {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(profile),
  };

  const signed = finalizeEvent(template, botSecretKey);

  return {
    id: signed.id,
    pubkey: signed.pubkey,
    created_at: signed.created_at,
    kind: signed.kind,
    tags: signed.tags,
    content: signed.content,
    sig: signed.sig,
  };
}

// ---------------------------------------------------------------------------
// Kind 30078 — Delegate Registry (unsigned template)
// ---------------------------------------------------------------------------

/**
 * Build an unsigned kind 30078 delegate registry event template.
 * The browser signs this with the owner's key via NIP-07.
 *
 * Uses "p" tags for each delegate bot — enables relay-side filtering
 * without content parsing.
 *
 * @param delegates - Array of delegate entries to include
 * @returns Unsigned event template for NIP-07 signing
 */
export function buildDelegateRegistryTemplate(
  delegates: DelegateRegistryEntry[],
): Omit<SignedNostrEvent, "id" | "pubkey" | "sig"> {
  const tags: string[][] = [
    ["d", "wingman-delegates"],
  ];

  for (const d of delegates) {
    tags.push(["p", d.pubkey, d.name]);
  }

  return {
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify({
      version: 1,
      updated_at: new Date().toISOString(),
    }),
  };
}

/**
 * Generate the display name for a bot from its pubkey.
 * Format: "word-word-word-wingman"
 */
export function getBotDisplayName(pubkeyHex: string): string {
  return `${generateBotWordId(pubkeyHex)}-wingman`;
}
