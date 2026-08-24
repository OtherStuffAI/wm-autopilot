/**
 * MCP Tool: nostr_get_profile
 *
 * Fetches the Nostr profile (kind 0 metadata) for Wingman's own pubkey
 * or a specified pubkey. Returns name, about, picture URL, and other
 * NIP-01 profile fields so the agent can understand its own identity.
 */

import { z } from "zod";
import { getBotPubkey } from "./nip44-utils";
import { resolveRelays, queryNostrEvents } from "./nostr-relay-utils";

export const nostrGetProfileSchema = {
  pubkey: z
    .string()
    .optional()
    .describe(
      "Hex pubkey to fetch the profile for. If omitted, uses your bot key's pubkey.",
    ),
  relays: z
    .array(z.string())
    .optional()
    .describe("Nostr relay URLs to query. Defaults to common public relays."),
};

export const nostrGetProfileDescription =
  "Fetch a Nostr profile (kind 0 metadata) from relays. " +
  "If no pubkey is provided, fetches your bot key's profile — useful for " +
  "understanding your name, bio, avatar, and other identity details. " +
  "Returns parsed profile fields including name, about, picture, nip05, " +
  "banner, lud16 (Lightning address), and more. " +
  "This is a read-only operation — no signing grant required.";

interface NostrGetProfileParams {
  pubkey?: string;
  relays?: string[];
}

interface ProfileMetadata {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  nip05?: string;
  lud16?: string;
  lud06?: string;
  website?: string;
  [key: string]: unknown;
}

export async function handleNostrGetProfile(params: NostrGetProfileParams) {
  try {
    // Resolve target pubkey
    let targetPubkey = params.pubkey;
    let isSelf = false;

    if (!targetPubkey) {
      const botPubkey = getBotPubkey();
      if (!botPubkey) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "No pubkey provided and bot key identity is not available. " +
                "Provide a pubkey parameter, or ensure the session has a bot key configured.",
            },
          ],
        };
      }
      targetPubkey = botPubkey;
      isSelf = true;
    }

    const relays = resolveRelays(params.relays);

    // Query for kind 0 (metadata) events
    const events = await queryNostrEvents(relays, {
      kinds: [0],
      authors: [targetPubkey],
      limit: 1,
    });

    if (events.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: isSelf
              ? `No Nostr profile found for your bot key pubkey (${targetPubkey}). ` +
                `This pubkey may not have published a kind 0 event yet.`
              : `No Nostr profile found for pubkey ${targetPubkey}.`,
          },
        ],
      };
    }

    // Use the most recent kind 0 event
    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
    if (!latest) {
      throw new Error("Nostr profile event disappeared after relay lookup");
    }
    let metadata: ProfileMetadata;

    try {
      metadata = JSON.parse(latest.content);
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Found a kind 0 event but content is not valid JSON: ${latest.content.slice(0, 200)}`,
          },
        ],
      };
    }

    // Build readable output
    const lines: string[] = [];

    if (isSelf) {
      lines.push("# Your Nostr Profile (Wingman Identity)");
    } else {
      lines.push(`# Nostr Profile`);
    }

    lines.push(`Pubkey: ${targetPubkey}`);
    lines.push("");

    if (metadata.display_name) lines.push(`Display Name: ${metadata.display_name}`);
    if (metadata.name) lines.push(`Name: ${metadata.name}`);
    if (metadata.about) lines.push(`\nBio:\n${metadata.about}`);
    if (metadata.picture) lines.push(`\nAvatar: ${metadata.picture}`);
    if (metadata.banner) lines.push(`Banner: ${metadata.banner}`);
    if (metadata.nip05) lines.push(`NIP-05: ${metadata.nip05}`);
    if (metadata.website) lines.push(`Website: ${metadata.website}`);
    if (metadata.lud16) lines.push(`Lightning: ${metadata.lud16}`);
    if (metadata.lud06) lines.push(`LNURL: ${metadata.lud06}`);

    // Include any extra fields
    const knownKeys = new Set([
      "name", "display_name", "about", "picture", "banner",
      "nip05", "website", "lud16", "lud06",
    ]);
    const extraFields = Object.entries(metadata).filter(
      ([k, v]) => !knownKeys.has(k) && v !== undefined && v !== null && v !== "",
    );
    if (extraFields.length > 0) {
      lines.push("\nAdditional fields:");
      for (const [k, v] of extraFields) {
        lines.push(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
      }
    }

    lines.push(`\nLast updated: ${new Date(latest.created_at * 1000).toISOString()}`);
    lines.push(`Event ID: ${latest.id}`);

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to fetch Nostr profile: ${(err as Error).message}`,
        },
      ],
    };
  }
}
