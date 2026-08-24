/**
 * MCP Tool: list_caprover_apps
 *
 * Lists tracked CapRover apps with deploy status and URLs.
 */

import { z } from "zod";

export const listCaproverAppsSchema = {};

export const listCaproverAppsDescription =
  "List tracked CapRover apps with deploy status, live URLs, and " +
  "version information. Use this to see what is deployed.";

export async function handleListCaproverApps(
  _params: Record<string, never>,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/caprover/apps?sessionId=${encodeURIComponent(sessionId)}`,
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to list CapRover apps (${response.status}): ${error}`,
          },
        ],
      };
    }

    const { apps } = await response.json() as {
      apps?: Array<{
        id: string;
        caproverName: string;
        liveUrl?: string;
        customDomain?: string;
        hasSsl?: boolean;
        deployedVersion?: number | null;
        appId?: string;
      }>;
    };

    if (!apps || apps.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No CapRover apps tracked. Add apps via the Wingman UI.",
          },
        ],
      };
    }

    const lines = ["Tracked CapRover Apps:", ""];
    for (const app of apps) {
      lines.push(`${app.caproverName} (${app.id})`);
      if (app.liveUrl) {
        lines.push(`  URL: ${app.liveUrl}`);
      }
      if (app.customDomain) {
        lines.push(`  Domain: ${app.customDomain}`);
      }
      lines.push(`  SSL: ${app.hasSsl ? "yes" : "no"}`);
      lines.push(`  Version: ${app.deployedVersion ?? "never deployed"}`);
      if (app.appId) {
        lines.push(`  Local App: ${app.appId}`);
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
