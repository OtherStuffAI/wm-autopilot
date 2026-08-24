/**
 * MCP Tool: read_logs
 *
 * Read logs from a session or app.
 */

import { z } from "zod";

export const readLogsSchema = {
  source: z
    .enum(["session", "app"])
    .describe("Log source: 'session' for agent session logs, 'app' for app process logs"),
  id: z.string().describe("The session ID or app ID to read logs from"),
  lines: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(100)
    .describe("Number of log lines to return (default 100, max 500)"),
};

export const readLogsDescription =
  "Read logs from a session (agent conversation/terminal output) or " +
  "an app (process stdout/stderr). Use list_sessions or list_apps to " +
  "find the ID to pass here.";

interface ReadLogsParams {
  source: string;
  id: string;
  lines?: number;
}

export async function handleReadLogs(
  params: ReadLogsParams,
  wingmanUrl: string,
  sessionId: string,
) {
  const { source, id, lines = 100 } = params;

  try {
    const qs = new URLSearchParams({
      sessionId,
      source,
      id,
      lines: String(lines),
    });

    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/logs?${qs.toString()}`,
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to read logs (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json() as { logs?: string[] };
    const logLines: string[] = result.logs ?? [];

    if (logLines.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No logs available for ${source} "${id}".`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Logs for ${source} "${id}" (${logLines.length} lines):`,
            "",
            ...logLines,
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
