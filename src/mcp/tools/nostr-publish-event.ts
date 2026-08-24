/**
 * MCP Tool: nostr_publish_event
 *
 * Sign a Nostr event with the user's bot key (via server API) and
 * publish it to relays directly from the MCP child process.
 *
 * Two-step flow:
 *   1. POST to the scoped capability broker → get signed event
 *   2. Publish signed event to relays using SimplePool (local)
 *
 * This avoids opening WebSocket connections in the main Wingman server,
 * which caused unhandled promise rejections on relay timeouts that
 * crashed the process and killed agent sessions.
 */

import { z } from "zod";
import { SimplePool } from "nostr-tools";
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
    const publishResults = await publishEventToRelays(signedEvent, relays);

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

// ---------------------------------------------------------------------------
// Local relay publisher — runs in MCP child process
// ---------------------------------------------------------------------------

interface RelayResult {
  relay: string;
  ok: boolean;
  error?: string;
}

async function publishEventToRelays(
  event: NostrEvent,
  relays: string[],
): Promise<{ successes: number; failures: number; results: RelayResult[] }> {
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
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Publish timeout")), PUBLISH_TIMEOUT_MS);
            // Ensure timer doesn't keep the process alive
            if (typeof timer === "object" && "unref" in timer) {
              (timer as NodeJS.Timeout).unref();
            }
          }),
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
    // Swallow errors from pool.close — stale connections may throw
    try {
      pool.close(relays);
    } catch {
      // ignore
    }
  }

  const successes = results.filter((r) => r.ok).length;
  return { successes, failures: results.length - successes, results };
}
