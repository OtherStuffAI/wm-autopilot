/**
 * MCP Tool: get_pinned_artifact
 *
 * Check what file is currently pinned as an artifact in the Wingman UI.
 */

export const getPinnedArtifactSchema = {};

export const getPinnedArtifactDescription =
  "Check what file is currently pinned as an artifact in the Wingman UI. " +
  "Returns the file path or null if nothing is pinned.";

export async function handleGetPinnedArtifact(
  _params: Record<string, never>,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/artifact/pin?sessionId=${encodeURIComponent(sessionId)}`,
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to get pinned artifact (${response.status}): ${error}`,
          },
        ],
      };
    }

    const { pinnedFile } = await response.json() as { pinnedFile?: string | null };

    if (!pinnedFile) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No file is currently pinned as an artifact.",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Currently pinned artifact: ${pinnedFile}`,
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
