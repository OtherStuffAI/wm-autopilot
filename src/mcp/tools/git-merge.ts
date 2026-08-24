/**
 * MCP Tool: git_merge
 *
 * Merge branches with optional report generation. The integration
 * manager tool — merges feature branches into staging (or staging into main).
 * Includes merge summary, change log, and auto-generated test plan.
 */

import { z } from "zod";

export const gitMergeSchema = {
  source_branch: z
    .string()
    .describe("The branch to merge from (e.g. 'feature/auth')."),
  target_branch: z
    .string()
    .optional()
    .describe("The branch to merge into (defaults to 'staging'). Use 'main' for production releases."),
  generate_report: z
    .boolean()
    .optional()
    .describe("Generate a detailed merge report with commit list, file changes, and test plan (defaults to true)."),
};

export const gitMergeDescription =
  "Merge a source branch into a target branch (defaults to staging). " +
  "This is the integration manager tool for the Wingman branching model. " +
  "Generates a merge report with: commit summary, files changed with diff stats, " +
  "and an auto-generated test plan based on affected areas. " +
  "Merge conflicts are detected and reported — the merge is aborted cleanly if conflicts occur.";

interface GitMergeParams {
  source_branch: string;
  target_branch?: string;
  generate_report?: boolean;
}

export async function handleGitMerge(
  params: GitMergeParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const target = params.target_branch || "staging";

    const response = await fetch(`${wingmanUrl}/api/git/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        source: params.source_branch,
        target,
        report: params.generate_report !== false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();

      // Parse error for structured messages
      let errorMessage: string;
      try {
        const parsed = JSON.parse(errorText);
        errorMessage = parsed.error || errorText;
      } catch {
        errorMessage = errorText;
      }

      return {
        isError: true,
        content: [{ type: "text" as const, text: `Merge failed: ${errorMessage}` }],
      };
    }

    const result = await response.json() as {
      success: boolean;
      summary: string;
      report?: string;
    };

    const lines: string[] = [];

    if (result.report) {
      lines.push(result.report);
    } else {
      lines.push(`Merged ${params.source_branch} into ${target} successfully.`);
      if (result.summary) {
        lines.push("", result.summary);
      }
    }

    if (target === "main") {
      lines.push(
        "",
        "---",
        "This was a production merge. Consider:",
        "- [ ] Verify deployment pipeline triggered",
        "- [ ] Monitor application health after deploy",
        "- [ ] Tag this release if appropriate",
      );
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to reach Wingman server: ${(err as Error).message}` }],
    };
  }
}
