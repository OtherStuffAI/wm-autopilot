/**
 * MCP Tool: delete_memory
 *
 * Remove a persisted memory by its ID.
 */

import { z } from "zod";

export const deleteMemorySchema = {
  id: z.string().describe("The memory ID to delete"),
};

export const deleteMemoryDescription =
  "Delete a persisted memory by its ID. " +
  "Use search_memory first to find the ID of the memory you want to remove.";

interface DeleteMemoryParams {
  id: string;
}

export async function handleDeleteMemory(
  params: DeleteMemoryParams,
  wingmanUrl: string,
  sessionId: string,
) {
  const { id } = params;

  try {
    const qs = new URLSearchParams();
    qs.set("sessionId", sessionId);
    qs.set("id", id);

    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/memory?${qs.toString()}`,
      { method: "DELETE" },
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to delete memory (${response.status}): ${error}`,
          },
        ],
      };
    }

    const { deleted } = await response.json() as { deleted: boolean };

    return {
      content: [
        {
          type: "text" as const,
          text: deleted
            ? `Memory ${id} deleted successfully.`
            : `Memory ${id} not found (may have already been deleted).`,
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
