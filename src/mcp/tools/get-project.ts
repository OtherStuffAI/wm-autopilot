/**
 * MCP Tool: get_project
 *
 * Returns project details (directory, task board URL, linked app, etc.)
 * for the current session's working directory.
 */

export const getProjectSchema = {};

export const getProjectDescription =
  "Get project details for this session's working directory. " +
  "Returns the project name, directory path, task board URL, linked app ID, " +
  "and other metadata. Useful for looking up external task boards or project context.";

export async function handleGetProject(
  _params: Record<string, never>,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/project?sessionId=${encodeURIComponent(sessionId)}`,
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to get project details (${response.status}): ${error}`,
          },
        ],
      };
    }

    const { project, directory } = await response.json() as {
      project?: {
        id: string;
        name: string;
        directoryPath: string;
        taskBoardUrl?: string;
        appId?: string;
        worktreeName?: string;
        sessionCount: number;
        lastUsedAt: string;
      } | null;
      directory?: string;
    };

    if (!project) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No project found for directory: ${directory}`,
          },
        ],
      };
    }

    const lines = [
      `Project: ${project.name}`,
      `  Directory: ${project.directoryPath}`,
    ];

    if (project.taskBoardUrl) {
      lines.push(`  Task Board: ${project.taskBoardUrl}`);
    }

    if (project.appId) {
      lines.push(`  Linked App: ${project.appId}`);
    }

    if (project.worktreeName) {
      lines.push(`  Worktree: ${project.worktreeName}`);
    }

    lines.push(`  Sessions: ${project.sessionCount}`);
    lines.push(`  Last Used: ${project.lastUsedAt}`);

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
