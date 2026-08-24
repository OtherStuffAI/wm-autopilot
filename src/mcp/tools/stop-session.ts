/**
 * MCP Tool: stop_session
 *
 * Stop an agent session by ID. Only sessions belonging to the same
 * owner (npub) as the calling session can be stopped.
 */

import { z } from "zod";

export const stopSessionSchema = {
  target_session_id: z
    .string()
    .describe("The ID of the session to stop"),
};

export const stopSessionDescription =
  "Stop a running agent session by its ID. The target session must belong " +
  "to the same owner as the calling session, and must have metadata.AGENT=true. " +
  "Cannot stop the calling session itself. Returns the stopped session details.";

interface StopSessionParams {
  target_session_id: string;
}

export async function handleStopSession(
  params: StopSessionParams,
  wingmanUrl: string,
  sessionId: string,
) {
  const { target_session_id } = params;

  if (target_session_id === sessionId) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: "Cannot stop your own session. Ask the human operator to stop this session if needed.",
        },
      ],
    };
  }

  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/sessions/stop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          targetSessionId: target_session_id,
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
            text: `Failed to stop session (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = (await response.json()) as Record<string, unknown>;
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Session stopped successfully`,
            `  ID: ${result.id}`,
            `  Agent: ${result.agent}`,
            `  Name: ${result.name}`,
            `  Status: ${result.status}`,
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
