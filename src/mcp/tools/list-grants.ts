/**
 * MCP Tool: list_active_grants
 *
 * Lists all active NIP-98 grants available to the current agent session.
 */

import { z } from "zod";

export const listGrantsSchema = {};

export const listGrantsDescription =
  "List your active NIP-98 access grants. Shows which domains you " +
  "currently have permission to sign Tier 2 requests for, along with " +
  "expiration times.";

export async function handleListGrants(
  _params: Record<string, never>,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/nip98/grants?sessionId=${encodeURIComponent(sessionId)}`,
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to list grants (${response.status}): ${error}`,
          },
        ],
      };
    }

    const { grants } = await response.json() as {
      grants?: Array<{
        id: string;
        domain: string;
        signerType: string;
        expiresAt: number;
        reason: string;
        endpoints?: unknown;
      }>;
    };

    if (!grants || grants.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No active NIP-98 grants. Use request_api_access to request user permission for a domain.",
          },
        ],
      };
    }

    const lines = ["Active NIP-98 Grants:", ""];
    for (const grant of grants) {
      const expiresIn = Math.max(0, Math.round((grant.expiresAt - Date.now()) / 60000));
      lines.push(`Domain: ${grant.domain}`);
      lines.push(`  Grant ID: ${grant.id}`);
      lines.push(`  Signer: ${grant.signerType}`);
      lines.push(`  Expires in: ${expiresIn} minutes`);
      lines.push(`  Reason: ${grant.reason}`);
      if (grant.endpoints) {
        lines.push(`  Endpoints: ${JSON.stringify(grant.endpoints)}`);
      }
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
          text: `Failed to reach Wingman server: ${(err as Error).message}`,
        },
      ],
    };
  }
}
