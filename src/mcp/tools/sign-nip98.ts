/**
 * MCP Tool: sign_nip98
 *
 * Requests a signed NIP-98 token from the Wingman server.
 * Tier 1 signs with the session's stable agent identity through the broker.
 * Tier 2 delegates to the logged-in user (requires active browser session).
 */

import { z } from "zod";
import { callCapabilityBroker } from "../capability-client";

export const signNip98Schema = {
  url: z.string().url().describe("Full URL to authenticate against"),
  method: z
    .enum(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
    .describe("HTTP method for the request"),
  body_hash: z
    .string()
    .optional()
    .describe("SHA-256 hex hash of the request body (required for POST/PUT)"),
  tier: z
    .enum(["1", "2"])
    .optional()
    .default("1")
    .describe("1 = stable agent identity (default), 2 = human delegation"),
};

export const signNip98Description =
  "Get a signed NIP-98 authentication token for an HTTP request. " +
  "Tier 1 uses this session's stable agent identity through a scoped capability. " +
  "Tier 2 uses the logged-in user's identity (requires an active browser session and an approved grant). " +
  "Returns an Authorization header value you can use directly.\n\n" +
  "IMPORTANT: NIP-98 tokens are valid for ~60 seconds from creation. " +
  "You can reuse a token for multiple requests to the same URL and method within that window — " +
  "do NOT request a new token for every call. " +
  "Batch your requests or reuse the Authorization header when making repeated calls to the same endpoint. " +
  "Only request a fresh token when the URL, method, or body changes, or when more than 50 seconds have passed.";

interface SignNip98Params {
  url: string;
  method: string;
  body_hash?: string;
  tier?: string;
}

export async function handleSignNip98(
  params: SignNip98Params,
  wingmanUrl: string,
  sessionId: string,
) {
  const { url, method, body_hash, tier = "1" } = params;

  try {
    if (tier === "1") {
      const result = await callCapabilityBroker<{ token: string; signedBy: string }>(
        "/api/mcp/capabilities/nip98",
        { url, method, bodyHash: body_hash },
        { wingmanUrl, sessionId, capabilityToken: process.env.WINGMAN_CAPABILITY ?? "" },
      );
      return {
        content: [{
          type: "text" as const,
          text: `NIP-98 token signed by stable agent identity ${result.signedBy}\n\nAuthorization: ${result.token}`,
        }],
      };
    }

    const response = await fetch(`${wingmanUrl}/api/mcp/nip98/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        url,
        method,
        bodyHash: body_hash,
        tier: 2,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `NIP-98 signing failed (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json() as { signedBy: string; token: string };
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `NIP-98 token signed by ${result.signedBy}`,
            "",
            `Authorization: ${result.token}`,
            "",
            "Use the above Authorization header in your HTTP request.",
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
          text: `Failed to reach Wingman server: ${(err as Error).message}`,
        },
      ],
    };
  }
}
