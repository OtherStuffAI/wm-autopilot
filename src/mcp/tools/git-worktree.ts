/**
 * MCP Tool: git_worktree
 *
 * Manage git worktrees for parallel branch development.
 * Worktrees live in .worktrees/<name> with feature/<name> branches.
 * The .worktrees/ directory is auto-gitignored.
 */

import { z } from "zod";

export const gitWorktreeSchema = {
  action: z
    .enum(["list", "add", "remove"])
    .describe("Worktree action: list all worktrees, add a new one, or remove an existing one."),
  name: z
    .string()
    .optional()
    .describe("Worktree name (e.g. 'auth'). For 'add': creates .worktrees/<name> with feature/<name> branch. For 'remove': removes .worktrees/<name>."),
};

export const gitWorktreeDescription =
  "Manage git worktrees for parallel branch development. " +
  "Worktrees allow multiple branches checked out simultaneously in .worktrees/<name>. " +
  "'add' creates a worktree with a feature/<name> branch and auto-gitignores .worktrees/. " +
  "'list' shows all active worktrees. " +
  "'remove' cleans up a worktree after merging. " +
  "Flow: add worktree → work in .worktrees/<name> → commit → push → merge to staging → remove worktree.";

interface GitWorktreeParams {
  action: "list" | "add" | "remove";
  name?: string;
}

export async function handleGitWorktree(
  params: GitWorktreeParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    if (params.action === "list") {
      return await handleWorktreeList(wingmanUrl, sessionId);
    } else if (params.action === "add") {
      if (!params.name) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "name is required for action=add" }],
        };
      }
      return await handleWorktreeAdd(wingmanUrl, sessionId, params.name);
    } else if (params.action === "remove") {
      if (!params.name) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "name is required for action=remove" }],
        };
      }
      return await handleWorktreeRemove(wingmanUrl, sessionId, params.name);
    }

    return {
      isError: true,
      content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to reach Wingman server: ${(err as Error).message}` }],
    };
  }
}

async function handleWorktreeList(wingmanUrl: string, sessionId: string) {
  const response = await fetch(`${wingmanUrl}/api/git/worktrees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to list worktrees (${response.status}): ${errorText}` }],
    };
  }

  const result = await response.json() as {
    worktrees: Array<{ path: string; branch: string; head: string; bare: boolean }>;
  };

  if (result.worktrees.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No worktrees found. Use action=add to create one." }],
    };
  }

  const lines = ["**Worktrees:**"];
  for (const wt of result.worktrees) {
    lines.push(`  - ${wt.path}`);
    lines.push(`    Branch: ${wt.branch || "(detached)"}`);
    lines.push(`    HEAD: ${wt.head?.slice(0, 8) || "unknown"}`);
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

async function handleWorktreeAdd(wingmanUrl: string, sessionId: string, name: string) {
  const response = await fetch(`${wingmanUrl}/api/git/worktree/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, name }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to add worktree (${response.status}): ${errorText}` }],
    };
  }

  const result = await response.json() as { path: string; branch: string };

  return {
    content: [{
      type: "text" as const,
      text: [
        `Worktree created successfully.`,
        `  Path: ${result.path}`,
        `  Branch: ${result.branch}`,
        ``,
        `The .worktrees/ directory has been added to .gitignore.`,
        `Work in ${result.path}, commit changes, then use git_merge to integrate into staging.`,
      ].join("\n"),
    }],
  };
}

async function handleWorktreeRemove(wingmanUrl: string, sessionId: string, name: string) {
  const response = await fetch(`${wingmanUrl}/api/git/worktree/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, name }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to remove worktree (${response.status}): ${errorText}` }],
    };
  }

  const result = await response.json() as { removed: boolean; branchMerged?: boolean };

  let text = `Worktree removed successfully.`;
  if (result.branchMerged) {
    text += `\nThe feature branch was fully merged into staging.`;
  } else {
    text += `\nNote: The feature branch may not be fully merged yet. Check before deleting.`;
  }

  return {
    content: [{ type: "text" as const, text }],
  };
}
