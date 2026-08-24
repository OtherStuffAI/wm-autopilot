/**
 * MCP Tool: request_api_access
 *
 * Requests user permission to access an API domain with NIP-98 auth.
 * This triggers a consent modal in the user's browser. Once approved,
 * a time-limited grant is created that allows sign_nip98 tier 2 calls.
 */

import { z } from "zod";

export const requestAccessSchema = {
  domain: z
    .string()
    .describe('Target API domain, e.g. "api.example.invalid"'),
  reason: z
    .string()
    .describe("Explain why you need access to this API"),
  duration_hours: z
    .number()
    .min(1)
    .max(168)
    .optional()
    .default(24)
    .describe("How long to request access in hours (default: 24, max: 168)"),
  endpoints: z
    .array(
      z.object({
        method: z.enum(["GET", "POST", "PUT", "DELETE", "*"]),
        path: z.string(),
      }),
    )
    .optional()
    .describe("Specific endpoints you plan to access (optional)"),
};

export const requestAccessDescription =
  "Request user permission to access an API with NIP-98 authentication on their behalf (Tier 2). " +
  "This shows a consent modal in the user's browser. Once approved, you can use sign_nip98 with tier=2 " +
  "to sign requests as the user for the specified domain and duration.";

interface RequestAccessParams {
  domain: string;
  reason: string;
  duration_hours?: number;
  endpoints?: Array<{ method: string; path: string }>;
}

export async function handleRequestAccess(
  params: RequestAccessParams,
  wingmanUrl: string,
  sessionId: string,
) {
  const { domain, reason, duration_hours = 24, endpoints } = params;

  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/nip98/request-grant`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          domain,
          reason,
          durationHours: duration_hours,
          endpoints,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Grant request failed (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json() as {
      granted: boolean;
      grantId?: string;
      error?: string;
    };

    if (result.granted) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Access granted for ${domain}`,
              `Grant ID: ${result.grantId}`,
              `Expires in ${duration_hours} hours`,
              "",
              "You can now use sign_nip98 with tier=2 for this domain.",
            ].join("\n"),
          },
        ],
      };
    }

    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: result.error ?? "Access request was denied by the user.",
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
