/**
 * MCP Tool: git_push
 *
 * Push the current branch to the best available remote for the session.
 * Prefers the branch upstream, then falls back to `gitea`, then `origin`.
 * The server injects host-scoped credentials so GitHub HTTPS remotes and
 * Gitea remotes both work from the user's own account.
 *
 * When the push guard blocks a push, formats actionable instructions
 * so the agent can fix the issue and retry.
 */

import { z } from "zod";

export const gitPushSchema = {
  branch: z
    .string()
    .optional()
    .describe("Branch to push. Defaults to the current branch."),
};

export const gitPushDescription =
  "Push current branch to the session's configured remote. " +
  "Uses Wingman's host-scoped credential helpers for GitHub HTTPS and Gitea remotes.";

interface GitPushParams {
  branch?: string;
}

// ---------------------------------------------------------------------------
// Push guard issue formatting
// ---------------------------------------------------------------------------

interface PushGuardIssue {
  severity: string;
  category: string;
  message: string;
  details?: string[];
}

interface PushGuardResponse {
  error: string;
  issues: PushGuardIssue[];
}

/**
 * Format push guard issues into clear, actionable instructions for the agent.
 */
function formatPushGuardMessage(guard: PushGuardResponse): string {
  const lines: string[] = [
    "## Push Blocked by Safety Guard\n",
    "The push was rejected because the repository has issues that must be fixed first.\n",
  ];

  for (const issue of guard.issues) {
    if (issue.category === "gitignore") {
      lines.push(
        "### Missing .gitignore\n",
        issue.message,
        "\n**To fix:**",
        "1. Create a `.gitignore` file appropriate for your project",
        "2. Include common patterns: `node_modules/`, `.env`, `*.log`, `.DS_Store`",
        "3. `git add .gitignore && git commit -m \"Add .gitignore\"`",
        "4. Retry the push\n",
      );
    } else if (issue.category === "pattern") {
      lines.push(
        "### Dangerous Tracked Files\n",
        issue.message,
      );
      if (issue.details && issue.details.length > 0) {
        lines.push("\nBlocked files:");
        for (const f of issue.details) {
          lines.push(`  - ${f}`);
        }
      }
      lines.push(
        "\n**To fix:**",
        "1. Ensure these patterns are in `.gitignore`",
        "2. Untrack the files (keeps them on disk): `git rm -r --cached <path>`",
        "   For example: `git rm -r --cached dist/` or `git rm --cached .env`",
        "3. Commit the removal: `git commit -m \"Untrack files that should be gitignored\"`",
        "4. Retry the push",
        "\n**Note:** If these files are intentionally tracked (e.g. `dist/` for deployment),",
        "the user may need to adjust the push guard configuration.\n",
      );
    } else if (issue.category === "large-file") {
      lines.push(
        "### Large Files Detected\n",
        issue.message,
      );
      if (issue.details && issue.details.length > 0) {
        lines.push("\nOversized files:");
        for (const f of issue.details) {
          lines.push(`  - ${f}`);
        }
      }
      lines.push(
        "\n**To fix:**",
        "1. Add large files to `.gitignore`",
        "2. Untrack them: `git rm --cached <path>`",
        "3. Consider using Git LFS for large binary files",
        "4. Commit and retry the push\n",
      );
    } else {
      // Unknown category — show raw
      lines.push(`### ${issue.category}\n`, issue.message);
      if (issue.details) {
        for (const d of issue.details) lines.push(`  - ${d}`);
      }
      lines.push("");
    }
  }

  lines.push(
    "---",
    "After fixing the issues above, retry the push with the `git_push` tool.",
  );

  return lines.join("\n");
}

/**
 * Try to parse a push guard error response from the API.
 * Returns null if the response is not a push guard error.
 */
function tryParsePushGuard(responseText: string): PushGuardResponse | null {
  try {
    const parsed = JSON.parse(responseText);
    if (parsed?.error && Array.isArray(parsed?.issues)) {
      return parsed as PushGuardResponse;
    }
  } catch {
    // Not JSON or not the expected shape
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleGitPush(
  params: GitPushParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(`${wingmanUrl}/api/git/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        branch: params.branch,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();

      // Check if this is a push guard rejection — format actionable instructions
      const guard = tryParsePushGuard(errorText);
      if (guard && guard.issues.length > 0) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: formatPushGuardMessage(guard),
            },
          ],
        };
      }

      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Push failed (${response.status}): ${errorText}`,
          },
        ],
      };
    }

    const result = await response.json() as { stdout: string; stderr: string; remote?: string; branch?: string };

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Pushed successfully${result.remote ? ` to ${result.remote}` : ""}${result.branch ? ` (${result.branch})` : ""}.`,
            result.stdout ? `\nOutput:\n${result.stdout}` : "",
            result.stderr ? `\nStderr:\n${result.stderr}` : "",
          ].join(""),
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
