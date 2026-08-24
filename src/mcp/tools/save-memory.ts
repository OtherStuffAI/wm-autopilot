/**
 * MCP Tool: save_memory
 *
 * Persist a memory note with optional tags. Project, directory, and npub
 * context are auto-populated from the session.
 */

import { z } from "zod";

export const saveMemorySchema = {
  content: z.string().describe("The memory content to save"),
  tags: z
    .string()
    .optional()
    .describe("Comma-separated free-form tags (e.g. 'auth,jwt,bugfix')"),
};

export const saveMemoryDescription =
  "Save a memory note that persists across sessions. " +
  "Provide the content and optional comma-separated tags. " +
  "Project, directory, and identity context are auto-populated from your session.";

interface SaveMemoryParams {
  content: string;
  tags?: string;
}

export async function handleSaveMemory(
  params: SaveMemoryParams,
  wingmanUrl: string,
  sessionId: string,
) {
  const { content, tags } = params;

  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/memory`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, content, tags }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to save memory (${response.status}): ${error}`,
          },
        ],
      };
    }

    const { memory } = await response.json() as {
      memory: { id: string; content: string; tags?: string; project?: string; workingDir?: string };
    };

    const lines = [
      `Memory saved (${memory.id})`,
      `  Content: ${memory.content.slice(0, 120)}${memory.content.length > 120 ? "..." : ""}`,
    ];

    if (memory.tags) {
      lines.push(`  Tags: ${memory.tags}`);
    }
    if (memory.project) {
      lines.push(`  Project: ${memory.project}`);
    }
    if (memory.workingDir) {
      lines.push(`  Directory: ${memory.workingDir}`);
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
