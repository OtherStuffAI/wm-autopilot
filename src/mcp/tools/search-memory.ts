/**
 * MCP Tool: search_memory
 *
 * Search and retrieve persisted memories by content, tags, project, or any combo.
 */

import { z } from "zod";

export const searchMemorySchema = {
  query: z
    .string()
    .optional()
    .describe("Text to search for in memory content"),
  tags: z
    .string()
    .optional()
    .describe("Comma-separated tags to filter by (e.g. 'auth,jwt')"),
  project: z
    .string()
    .optional()
    .describe("Filter by project name"),
  limit: z
    .number()
    .optional()
    .describe("Max results to return (default 20, max 100)"),
};

export const searchMemoryDescription =
  "Search persisted memories by content text, tags, project name, or any combination. " +
  "Returns matching memories with their metadata. " +
  "Defaults to showing recent memories for the current user if no filters are provided.";

interface SearchMemoryParams {
  query?: string;
  tags?: string;
  project?: string;
  limit?: number;
}

export async function handleSearchMemory(
  params: SearchMemoryParams,
  wingmanUrl: string,
  sessionId: string,
) {
  const { query, tags, project, limit } = params;

  try {
    const qs = new URLSearchParams();
    qs.set("sessionId", sessionId);
    if (query) qs.set("query", query);
    if (tags) qs.set("tags", tags);
    if (project) qs.set("project", project);
    if (limit !== undefined) qs.set("limit", String(limit));

    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/memory?${qs.toString()}`,
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to search memories (${response.status}): ${error}`,
          },
        ],
      };
    }

    const { memories } = await response.json() as {
      memories?: Array<{
        id: string;
        content: string;
        tags?: string;
        project?: string;
        workingDir?: string;
        createdAt: string;
      }>;
    };

    if (!memories || memories.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No memories found matching the search criteria.",
          },
        ],
      };
    }

    const lines = [`Found ${memories.length} memory/memories:`, ""];
    for (const m of memories) {
      lines.push(`[${m.id}]`);
      lines.push(`  ${m.content}`);
      if (m.tags) lines.push(`  Tags: ${m.tags}`);
      if (m.project) lines.push(`  Project: ${m.project}`);
      if (m.workingDir) lines.push(`  Directory: ${m.workingDir}`);
      lines.push(`  Created: ${m.createdAt}`);
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
