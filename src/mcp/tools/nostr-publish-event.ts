/**
 * MCP Tool: nostr_publish_event
 *
 * Sign a Nostr event with the user's bot key (via server API) and
 * publish it to relays directly from the MCP child process.
 *
 * Two-step flow:
 *   1. POST to the scoped capability broker → get signed event
 *   2. Publish signed event and await matching NIP-01 OK responses
 *
 * This avoids opening WebSocket connections in the main Wingman server,
 * which caused unhandled promise rejections on relay timeouts that
 * crashed the process and killed agent sessions.
 */

import { z } from "zod";
import { publishToRelays, type SignedEvent } from "../../ngit/relay-publisher";
import { resolveRelays, type NostrEvent } from "./nostr-relay-utils";
import { callCapabilityBroker } from "../capability-client";

const PUBLISH_TIMEOUT_MS = 8_000;

export const nostrPublishEventSchema = {
  kind: z
    .number()
    .int()
    .min(0)
    .describe("Nostr event kind number (e.g. 1 for short text note)"),
  content: z
    .string()
    .describe("Event content string"),
  tags: z
    .array(z.array(z.string()))
    .describe("Event tags — array of string arrays (e.g. [[\"p\", \"<pubkey>\"], [\"e\", \"<id>\"]])"),
  created_at: z
    .number()
    .int()
    .optional()
    .describe("Unix timestamp in seconds. Defaults to current time if omitted."),
  relays: z
    .array(z.string())
    .optional()
    .describe("Relay URLs to publish to. Defaults to popular public relays if omitted."),
};

export const nostrPublishEventDescription =
  "Sign a Nostr event with the user's bot key and publish it to relays. " +
  "Returns the signed event plus per-relay publish results. " +
  "If no relays are specified, publishes to default public relays.";

interface NostrPublishEventParams {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
  relays?: string[];
}

export async function handleNostrPublishEvent(
  params: NostrPublishEventParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    // ---- Step 1: Sign the event via server API (bot key lives there) ----
    const signData = await callCapabilityBroker<{
      event: NostrEvent;
      signerPubkey: string;
    }>("/api/mcp/capabilities/nostr-event", { event: {
      kind: params.kind,
      content: params.content,
      tags: params.tags,
      created_at: params.created_at,
    } }, { wingmanUrl, sessionId, capabilityToken: process.env.WINGMAN_CAPABILITY ?? "" });

    const signedEvent = signData.event;

    // ---- Step 2: Publish from MCP process directly ----
    const relays = resolveRelays(params.relays);
    const publishResults = await publishToRelays(signedEvent as SignedEvent, relays, {
      timeoutMs: PUBLISH_TIMEOUT_MS,
    });

    const relayLines = publishResults.results.map(
      (r) => `  ${r.ok ? "OK" : "FAIL"} ${r.relay}${r.error ? ` — ${r.error}` : ""}`,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Signed by: ${signData.signerPubkey} (bot key)`,
            `Event ID: ${signedEvent.id}`,
            `Kind: ${signedEvent.kind}`,
            `Published: ${publishResults.successes}/${publishResults.results.length} relays`,
            "",
            "Relay results:",
            ...relayLines,
            "",
            JSON.stringify(signedEvent, null, 2),
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Nostr event publish failed: ${(err as Error).message}`,
        },
      ],
    };
  }
}
