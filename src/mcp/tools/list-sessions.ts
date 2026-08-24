/**
 * MCP Tool: list_sessions
 *
 * Lists all active agent sessions with status.
 */

import { z } from "zod";

export const listSessionsSchema = {};

export const listSessionsDescription =
  "List active agent sessions with status, agent type, name, and " +
  "working directory. Use this to see what agents are running.";

export async function handleListSessions(
  _params: Record<string, never>,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/sessions?sessionId=${encodeURIComponent(sessionId)}`,
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to list sessions (${response.status}): ${error}`,
          },
        ],
      };
    }

    const { sessions } = await response.json() as {
      sessions?: Array<{
        id: string;
        agent: string;
        name?: string;
        status: string;
        workingDirectory: string;
        port: number;
        pid?: number;
        startedAt: string;
      }>;
    };

    if (!sessions || sessions.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No active sessions.",
          },
        ],
      };
    }

    const lines = ["Active Sessions:", ""];
    for (const s of sessions) {
      const statusIcon =
        s.status === "running" ? "[running]" :
        s.status === "starting" ? "[starting]" :
        s.status === "error" ? "[error]" :
        "[stopped]";
      lines.push(`${statusIcon} ${s.name || s.id} (${s.agent})`);
      lines.push(`  ID: ${s.id}`);
      lines.push(`  Dir: ${s.workingDirectory}`);
      lines.push(`  Port: ${s.port}`);
      if (s.pid) {
        lines.push(`  PID: ${s.pid}`);
      }
      lines.push(`  Started: ${s.startedAt}`);
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
