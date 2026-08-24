/**
 * MCP Tool: nostr_get_feed
 *
 * Fetches recent Nostr notes (kind 1) for Wingman's own pubkey or a
 * specified pubkey. Lets the agent read its own posts to understand
 * what it has published and what it's about.
 */

import { z } from "zod";
import { getBotPubkey } from "./nip44-utils";
import { resolveRelays, queryNostrEvents } from "./nostr-relay-utils";

export const nostrGetFeedSchema = {
  pubkey: z
    .string()
    .optional()
    .describe(
      "Hex pubkey to fetch notes for. If omitted, uses your bot key's pubkey.",
    ),
  limit: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of notes to return (default 20, max 50)."),
  relays: z
    .array(z.string())
    .optional()
    .describe("Nostr relay URLs to query. Defaults to common public relays."),
};

export const nostrGetFeedDescription =
  "Fetch recent Nostr notes (kind 1) from relays for a given pubkey. " +
  "If no pubkey is provided, fetches your bot key's notes — useful for " +
  "understanding what you have posted, your tone, topics, and interests. " +
  "Returns note content, timestamps, and any referenced events or tags. " +
  "This is a read-only operation — no signing grant required.";

interface NostrGetFeedParams {
  pubkey?: string;
  limit?: number;
  relays?: string[];
}

export async function handleNostrGetFeed(params: NostrGetFeedParams) {
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

    const limit = params.limit ?? 20;
    const relays = resolveRelays(params.relays);

    // Query for kind 1 (text note) events
    const events = await queryNostrEvents(relays, {
      kinds: [1],
      authors: [targetPubkey],
      limit,
    });

    if (events.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: isSelf
              ? `No notes found for your bot key pubkey (${targetPubkey}). ` +
                `This identity may not have published any kind 1 events yet.`
              : `No notes found for pubkey ${targetPubkey}.`,
          },
        ],
      };
    }

    // Sort by newest first
    const sorted = events.sort((a, b) => b.created_at - a.created_at);

    const lines: string[] = [];
    if (isSelf) {
      lines.push(`# Your Nostr Feed (${sorted.length} notes)`);
    } else {
      lines.push(`# Nostr Feed for ${targetPubkey.slice(0, 12)}... (${sorted.length} notes)`);
    }
    lines.push("");

    for (const note of sorted) {
      const date = new Date(note.created_at * 1000).toISOString();
      lines.push(`---`);
      lines.push(`Date: ${date}`);
      lines.push(`ID: ${note.id}`);

      // Extract notable tags
      const replyTo = note.tags.find((t) => t[0] === "e" && t[3] === "reply");
      const rootRef = note.tags.find((t) => t[0] === "e" && t[3] === "root");
      const mentions = note.tags.flatMap((tag) =>
        tag[0] === "p" && tag[1] ? [`${tag[1].slice(0, 12)}...`] : []
      );
      const hashtags = note.tags.flatMap((tag) =>
        tag[0] === "t" && tag[1] ? [tag[1]] : []
      );

      if (rootRef) lines.push(`Thread root: ${rootRef[1]}`);
      if (replyTo) lines.push(`Reply to: ${replyTo[1]}`);
      if (mentions.length > 0) lines.push(`Mentions: ${mentions.join(", ")}`);
      if (hashtags.length > 0) lines.push(`Tags: ${hashtags.join(", ")}`);

      lines.push("");
      lines.push(note.content);
      lines.push("");
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to fetch Nostr feed: ${(err as Error).message}`,
        },
      ],
    };
  }
}
