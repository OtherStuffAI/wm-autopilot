/**
 * MCP Tool: create_session
 *
 * Spawn a new agent session.
 */

import { z } from "zod";
import { AGENT_TYPES, AGENT_TYPE_LIST } from "../../agent-types";

export const createSessionSchema = {
  agent: z
    .enum(AGENT_TYPES)
    .describe("The agent type to spawn"),
  directory: z
    .string()
    .optional()
    .describe("Working directory for the new session (defaults to server default)"),
  name: z
    .string()
    .optional()
    .describe("Human-readable name for the session"),
  nightwatch: z
    .object({
      enabled: z.boolean().optional().describe("Enable Night Watch on session start"),
      prompt: z.string().optional().describe("Prompt/instructions sent on each Night Watch check-in"),
      intervalMinutes: z
        .number()
        .int()
        .min(2)
        .max(60)
        .optional()
        .describe("Minutes between Night Watch check-ins"),
      maxCycles: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of Night Watch check-ins before auto-stop"),
    })
    .optional()
    .describe("Optional Night Watch configuration to apply when the session starts"),
};

export const createSessionDescription =
  `Spawn a new agent session. Choose the agent type (${AGENT_TYPE_LIST}) and optionally set a working directory ` +
  "and name. Optionally enable Night Watch with a custom prompt and interval. Returns the new session details including ID and port.";

interface CreateSessionParams {
  agent: string;
  directory?: string;
  name?: string;
  nightwatch?: {
    enabled?: boolean;
    prompt?: string;
    intervalMinutes?: number;
    maxCycles?: number;
  };
}

export async function handleCreateSession(
  params: CreateSessionParams,
  wingmanUrl: string,
  sessionId: string,
) {
  const { agent, directory, name, nightwatch } = params;

  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          agent,
          directory,
          name,
          nightwatch,
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
            text: `Failed to create session (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json() as {
      agent: string;
      id: string;
      name: string;
      port: number;
      workingDirectory: string;
      status: string;
      nightwatch?: { enabled?: boolean; intervalMinutes?: number; prompt?: string };
    };
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Session created successfully`,
            `  Agent: ${result.agent}`,
            `  ID: ${result.id}`,
            `  Name: ${result.name}`,
            `  Port: ${result.port}`,
            `  Dir: ${result.workingDirectory}`,
            `  Status: ${result.status}`,
            ...(result.nightwatch?.enabled
              ? [
                  `  Night Watch: enabled`,
                  result.nightwatch.intervalMinutes
                    ? `  Night Watch Interval: ${result.nightwatch.intervalMinutes} min`
                    : null,
                  result.nightwatch.prompt
                    ? `  Night Watch Prompt: ${result.nightwatch.prompt}`
                    : null,
                ].filter(Boolean)
              : []),
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
