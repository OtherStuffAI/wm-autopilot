/**
 * MCP Tool: manage_app
 *
 * Start, stop, restart, build, or setup an app by ID.
 */

import { z } from "zod";
import { capabilityNip98Fetch } from "../capability-client";

export const manageAppSchema = {
  app_id: z.string().describe("The app ID to manage"),
  owner: z.string().describe("Configured Admin npub that signed the app delegation"),
  action: z
    .enum(["start", "stop", "restart", "build", "setup"])
    .describe("Lifecycle action to perform on the app"),
};

export const manageAppDescription =
  "Start, stop, restart, build, or setup a registered app by its ID. " +
  "Use list_apps first to see available apps and their current status.";

interface ManageAppParams {
  app_id: string;
  owner: string;
  action: string;
}

export async function handleManageApp(
  params: ManageAppParams,
  wingmanUrl: string,
  _sessionId: string,
) {
  const { app_id, action, owner } = params;

  try {
    const url = `${wingmanUrl}/api/owners/${encodeURIComponent(owner)}/apps/${encodeURIComponent(app_id)}/actions`;
    const body = JSON.stringify({ action });
    const response = await capabilityNip98Fetch(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `App action failed (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json() as {
      app?: { status?: { status?: string; running?: boolean }; message?: string };
      status?: string;
      running?: boolean;
      message?: string;
    };
    const status = result.status ?? result.app?.status?.status ?? "unknown";
    const running = result.running ?? result.app?.status?.running ?? false;
    const message = result.message ?? result.app?.message;
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `App "${app_id}" — ${action} completed`,
            `Status: ${status}`,
            `Running: ${running}`,
            message ? `Message: ${message}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
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
