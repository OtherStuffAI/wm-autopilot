/**
 * MCP Tool: git_branch
 *
 * List, create, or switch branches. Create enforces feature/ prefix.
 * Branching model: main=production, staging=pre-deploy, feature/*=development.
 */

import { z } from "zod";

export const gitBranchSchema = {
  action: z
    .enum(["list", "create", "switch"])
    .describe("Branch action: list all branches, create a new feature branch, or switch to an existing branch."),
  name: z
    .string()
    .optional()
    .describe("Branch name. For 'create': name for the new branch (feature/ prefix auto-added). For 'switch': branch to switch to."),
  base_branch: z
    .string()
    .optional()
    .describe("Base branch to create from (defaults to 'staging'). Only used with action=create."),
};

export const gitBranchDescription =
  "Manage git branches within the Wingman branching model. " +
  "Actions: 'list' shows all branches, 'create' makes a new feature/* branch (from staging by default), " +
  "'switch' checks out an existing branch. " +
  "Convention: main=production, staging=pre-deploy, feature/*=development.";

interface GitBranchParams {
  action: "list" | "create" | "switch";
  name?: string;
  base_branch?: string;
}

export async function handleGitBranch(
  params: GitBranchParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    if (params.action === "list") {
      return await handleList(wingmanUrl, sessionId);
    } else if (params.action === "create") {
      if (!params.name) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "name is required for action=create" }],
        };
      }
      return await handleCreate(wingmanUrl, sessionId, params.name, params.base_branch);
    } else if (params.action === "switch") {
      if (!params.name) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "name is required for action=switch" }],
        };
      }
      return await handleSwitch(wingmanUrl, sessionId, params.name);
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

async function handleList(wingmanUrl: string, sessionId: string) {
  const response = await fetch(`${wingmanUrl}/api/git/branches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to list branches (${response.status}): ${errorText}` }],
    };
  }

  const result = await response.json() as {
    branches: Array<{ name: string; shortHash: string; tracking: string; current: boolean }>;
  };

  const lines = ["**Branches:**"];
  for (const b of result.branches) {
    const marker = b.current ? "* " : "  ";
    const tracking = b.tracking ? ` ${b.tracking}` : "";
    lines.push(`${marker}${b.name} (${b.shortHash})${tracking}`);
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

async function handleCreate(
  wingmanUrl: string,
  sessionId: string,
  name: string,
  baseBranch?: string,
) {
  const response = await fetch(`${wingmanUrl}/api/git/branch/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, name, baseBranch }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to create branch (${response.status}): ${errorText}` }],
    };
  }

  const result = await response.json() as { branch: string };

  return {
    content: [{
      type: "text" as const,
      text: `Created and switched to branch: ${result.branch}\n\nThis is a feature branch. When ready, use git_merge to integrate into staging.`,
    }],
  };
}

async function handleSwitch(wingmanUrl: string, sessionId: string, branch: string) {
  const response = await fetch(`${wingmanUrl}/api/git/branch/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, branch }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Failed to switch branch (${response.status}): ${errorText}` }],
    };
  }

  const result = await response.json() as { branch: string; warning?: string };

  let text = `Switched to branch: ${result.branch}`;
  if (result.warning) {
    text += `\n\n${result.warning}`;
  }

  return {
    content: [{ type: "text" as const, text }],
  };
}
