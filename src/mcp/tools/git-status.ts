/**
 * MCP Tool: git_status
 *
 * Shows current branch, clean/dirty state, staged/unstaged files,
 * recent commit, and workflow context (branch role + suggested actions).
 */

import { z } from "zod";

export const gitStatusSchema = {};

export const gitStatusDescription =
  "Get git status with workflow context. Shows current branch, clean/dirty state, " +
  "staged/unstaged/untracked files, last commit, and ahead/behind counts. " +
  "Includes workflow context explaining the branch role in the branching model: " +
  "main=production (warn before changes), staging=pre-deploy testing, feature/*=development.";

export async function handleGitStatus(
  _params: Record<string, never>,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(`${wingmanUrl}/api/git/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Git status failed (${response.status}): ${errorText}` }],
      };
    }

    const result = await response.json() as {
      branch: string;
      clean: boolean;
      staged: string[];
      unstaged: string[];
      untracked: string[];
      lastCommit: string;
      ahead: number;
      behind: number;
      workflowContext: string;
    };

    const lines: string[] = [
      `**Branch:** ${result.branch}`,
      `**Status:** ${result.clean ? "Clean" : "Dirty"}`,
      `**Last commit:** ${result.lastCommit}`,
    ];

    if (result.ahead > 0 || result.behind > 0) {
      lines.push(`**Ahead/Behind:** +${result.ahead} / -${result.behind}`);
    }

    if (result.staged.length > 0) {
      lines.push(`\n**Staged (${result.staged.length}):**`);
      for (const f of result.staged) lines.push(`  - ${f}`);
    }

    if (result.unstaged.length > 0) {
      lines.push(`\n**Unstaged (${result.unstaged.length}):**`);
      for (const f of result.unstaged) lines.push(`  - ${f}`);
    }

    if (result.untracked.length > 0) {
      lines.push(`\n**Untracked (${result.untracked.length}):**`);
      for (const f of result.untracked) lines.push(`  - ${f}`);
    }

    lines.push("", result.workflowContext);

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
