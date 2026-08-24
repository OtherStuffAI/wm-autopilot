/**
 * MCP Tool: nostr_sign_event
 *
 * Sign a policy-approved Nostr event using the stable agent identity.
 * Routes through the server's capability broker so the MCP child
 * process never touches the private key directly.
 */

import { z } from "zod";
import { callCapabilityBroker } from "../capability-client";

export const nostrSignEventSchema = {
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
};

export const nostrSignEventDescription =
  "Sign a policy-approved Nostr event with this session's stable agent identity. " +
  "Returns a fully signed event (with id, pubkey, and sig) ready for relay publishing. " +
  "The signer is the agent/bot identity, not the Wingman instance or human key.";

interface NostrSignEventParams {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
}

export async function handleNostrSignEvent(
  params: NostrSignEventParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const data = await callCapabilityBroker<{
      event: Record<string, unknown>;
      signerPubkey: string;
    }>("/api/mcp/capabilities/nostr-event", { event: {
      kind: params.kind,
      content: params.content,
      tags: params.tags,
      created_at: params.created_at,
    } }, { wingmanUrl, sessionId, capabilityToken: process.env.WINGMAN_CAPABILITY ?? "" });

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Signed by: ${data.signerPubkey} (stable agent identity)`,
            `Event ID: ${data.event.id}`,
            `Kind: ${data.event.kind}`,
            "",
            JSON.stringify(data.event, null, 2),
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
          text: `Nostr event signing failed: ${(err as Error).message}`,
        },
      ],
    };
  }
}
