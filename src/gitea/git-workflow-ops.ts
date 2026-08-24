/**
 * Git Workflow Operations
 *
 * Higher-level git operations for branch management, worktrees, merging,
 * and workflow context. Built on top of runGiteaGit from gitea-operations.ts.
 *
 * Branching model:
 *   main       — production (warn before changes)
 *   staging    — pre-deploy testing
 *   feature/*  — new work, created from staging
 */

import { runGiteaGit, getCurrentBranch, type GiteaOperationConfig } from "./gitea-operations";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitStatusResult {
  branch: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  lastCommit: string;
  ahead: number;
  behind: number;
  workflowContext: string;
}

export interface BranchInfo {
  name: string;
  shortHash: string;
  tracking: string;
  current: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
}

export interface MergeResult {
  success: boolean;
  summary: string;
  report?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Workflow context
// ---------------------------------------------------------------------------

export function buildWorkflowContext(branch: string): string {
  const lines: string[] = ["## Workflow Context"];

  if (branch === "main") {
    lines.push(
      `Branch: ${branch} (production)`,
      "Note: You are on the production branch.",
    );
  } else if (branch === "staging") {
    lines.push(
      `Branch: ${branch} (pre-deploy)`,
      "Role: Pre-deploy testing — quick fixes OK, feature merges land here.",
      "Target: main (after testing)",
      "Tip: Merge feature branches here with git_merge.",
    );
  } else if (branch.startsWith("feature/")) {
    lines.push(
      `Branch: ${branch} (feature branch)`,
      "Role: Development — merge to staging when ready.",
      "Target: staging",
      "Tip: Use git_merge to integrate into staging when complete.",
    );
  } else {
    lines.push(
      `Branch: ${branch}`,
      "Role: Unknown branch type.",
      "Convention: main=production, staging=pre-deploy, feature/*=development.",
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function getGitStatus(
  directory: string,
  opConfig: GiteaOperationConfig,
): Promise<GitStatusResult> {
  const [branchResult, statusResult, logResult] = await Promise.all([
    runGiteaGit(["rev-parse", "--abbrev-ref", "HEAD"], directory, opConfig),
    runGiteaGit(["status", "--porcelain"], directory, opConfig),
    runGiteaGit(["log", "--oneline", "-1"], directory, opConfig),
  ]);

  const branch = branchResult.stdout || "main";

  // Parse porcelain status
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of statusResult.stdout.split("\n").filter(Boolean)) {
    const x = line[0];
    const y = line[1];
    const file = line.slice(3);

    if (x === "?") {
      untracked.push(file);
    } else {
      if (x !== " " && x !== "?") staged.push(file);
      if (y !== " " && y !== "?") unstaged.push(file);
    }
  }

  // Ahead/behind
  let ahead = 0;
  let behind = 0;
  const aheadResult = await runGiteaGit(
    ["rev-list", "--count", `@{upstream}..HEAD`],
    directory,
    opConfig,
  );
  if (aheadResult.exitCode === 0) {
    ahead = parseInt(aheadResult.stdout, 10) || 0;
  }
  const behindResult = await runGiteaGit(
    ["rev-list", "--count", `HEAD..@{upstream}`],
    directory,
    opConfig,
  );
  if (behindResult.exitCode === 0) {
    behind = parseInt(behindResult.stdout, 10) || 0;
  }

  return {
    branch,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    staged,
    unstaged,
    untracked,
    lastCommit: logResult.stdout || "(no commits)",
    ahead,
    behind,
    workflowContext: buildWorkflowContext(branch),
  };
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export async function listBranches(
  directory: string,
  opConfig: GiteaOperationConfig,
): Promise<BranchInfo[]> {
  const result = await runGiteaGit(
    ["branch", "-a", "--format=%(HEAD) %(refname:short) %(objectname:short) %(upstream:track)"],
    directory,
    opConfig,
  );

  if (result.exitCode !== 0) return [];

  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const current = line.startsWith("*");
    const parts = line.slice(2).split(/\s+/);
    return {
      name: parts[0] || "",
      shortHash: parts[1] || "",
      tracking: parts.slice(2).join(" "),
      current,
    };
  });
}

export async function createBranch(
  directory: string,
  opConfig: GiteaOperationConfig,
  name: string,
  baseBranch?: string,
): Promise<{ success: boolean; branch: string; error?: string }> {
  // Enforce feature/ prefix
  const branchName = name.startsWith("feature/") ? name : `feature/${name}`;
  const base = baseBranch || "staging";

  const result = await runGiteaGit(
    ["checkout", "-b", branchName, base],
    directory,
    opConfig,
  );

  if (result.exitCode !== 0) {
    // If staging doesn't exist, try from current branch
    if (result.stderr.includes("not a valid") || result.stderr.includes("did not match")) {
      const fallback = await runGiteaGit(
        ["checkout", "-b", branchName],
        directory,
        opConfig,
      );
      if (fallback.exitCode !== 0) {
        return { success: false, branch: branchName, error: fallback.stderr };
      }
      return { success: true, branch: branchName };
    }
    return { success: false, branch: branchName, error: result.stderr };
  }

  return { success: true, branch: branchName };
}

export async function switchBranch(
  directory: string,
  opConfig: GiteaOperationConfig,
  branch: string,
): Promise<{ success: boolean; branch: string; warning?: string; error?: string }> {
  const result = await runGiteaGit(["checkout", branch], directory, opConfig);

  if (result.exitCode !== 0) {
    return { success: false, branch, error: result.stderr };
  }

  const warning = branch === "main"
    ? "WARNING: You are now on the production branch. Direct changes are discouraged."
    : undefined;

  return { success: true, branch, warning };
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

/**
 * Ensure .worktrees/ is in .gitignore.
 */
export function ensureWorktreeGitignore(directory: string): void {
  const gitignorePath = join(directory, ".gitignore");

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (content.includes(".worktrees/") || content.includes(".worktrees")) {
      return; // Already present
    }
    appendFileSync(gitignorePath, "\n# Git worktrees\n.worktrees/\n");
  } else {
    appendFileSync(gitignorePath, "# Git worktrees\n.worktrees/\n");
  }
}

export async function listWorktrees(
  directory: string,
  opConfig: GiteaOperationConfig,
): Promise<WorktreeInfo[]> {
  const result = await runGiteaGit(["worktree", "list", "--porcelain"], directory, opConfig);

  if (result.exitCode !== 0) return [];

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push(current as WorktreeInfo);
      current = { path: line.slice(9), bare: false };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "" && current.path) {
      worktrees.push(current as WorktreeInfo);
      current = {};
    }
  }

  if (current.path) worktrees.push(current as WorktreeInfo);

  return worktrees;
}

export async function addWorktree(
  directory: string,
  opConfig: GiteaOperationConfig,
  name: string,
): Promise<{ success: boolean; path: string; branch: string; error?: string }> {
  const worktreePath = join(directory, ".worktrees", name);
  const branchName = name.startsWith("feature/") ? name : `feature/${name}`;
  const cleanName = branchName.replace("feature/", "");

  // Ensure .worktrees/ is gitignored
  ensureWorktreeGitignore(directory);

  const result = await runGiteaGit(
    ["worktree", "add", join(".worktrees", cleanName), "-b", branchName],
    directory,
    opConfig,
  );

  if (result.exitCode !== 0) {
    // Branch might already exist — try without -b
    if (result.stderr.includes("already exists")) {
      const retry = await runGiteaGit(
        ["worktree", "add", join(".worktrees", cleanName), branchName],
        directory,
        opConfig,
      );
      if (retry.exitCode !== 0) {
        return { success: false, path: worktreePath, branch: branchName, error: retry.stderr };
      }
      return { success: true, path: join(directory, ".worktrees", cleanName), branch: branchName };
    }
    return { success: false, path: worktreePath, branch: branchName, error: result.stderr };
  }

  return { success: true, path: join(directory, ".worktrees", cleanName), branch: branchName };
}

export async function removeWorktree(
  directory: string,
  opConfig: GiteaOperationConfig,
  name: string,
): Promise<{ success: boolean; branchMerged?: boolean; error?: string }> {
  const cleanName = name.replace("feature/", "");
  const worktreePath = join(".worktrees", cleanName);

  const result = await runGiteaGit(
    ["worktree", "remove", worktreePath],
    directory,
    opConfig,
  );

  if (result.exitCode !== 0) {
    // Try force removal if there are untracked files
    if (result.stderr.includes("untracked") || result.stderr.includes("modified")) {
      const force = await runGiteaGit(
        ["worktree", "remove", "--force", worktreePath],
        directory,
        opConfig,
      );
      if (force.exitCode !== 0) {
        return { success: false, error: force.stderr };
      }
    } else {
      return { success: false, error: result.stderr };
    }
  }

  // Check if the branch was fully merged
  const branchName = name.startsWith("feature/") ? name : `feature/${name}`;
  const mergeCheck = await runGiteaGit(
    ["branch", "--merged", "staging"],
    directory,
    opConfig,
  );
  const branchMerged = mergeCheck.stdout.includes(branchName);

  return { success: true, branchMerged };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export async function mergeBranch(
  directory: string,
  opConfig: GiteaOperationConfig,
  sourceBranch: string,
  targetBranch: string,
): Promise<MergeResult> {
  // Save current branch
  const currentBranch = await getCurrentBranch(directory, opConfig);

  // Checkout target
  const checkout = await runGiteaGit(["checkout", targetBranch], directory, opConfig);
  if (checkout.exitCode !== 0) {
    return { success: false, summary: "", error: `Failed to checkout ${targetBranch}: ${checkout.stderr}` };
  }

  // Merge
  const merge = await runGiteaGit(
    ["merge", sourceBranch, "--no-edit"],
    directory,
    opConfig,
  );

  if (merge.exitCode !== 0) {
    // Abort the merge to leave the repo clean
    await runGiteaGit(["merge", "--abort"], directory, opConfig);
    // Return to original branch
    await runGiteaGit(["checkout", currentBranch], directory, opConfig);
    return {
      success: false,
      summary: "",
      error: `Merge conflict merging ${sourceBranch} into ${targetBranch}. Resolve conflicts manually.\n\n${merge.stdout}\n${merge.stderr}`,
    };
  }

  // Get diff stats for the merge
  const diffStat = await runGiteaGit(
    ["diff", "--stat", `${targetBranch}@{1}..${targetBranch}`],
    directory,
    opConfig,
  );

  return {
    success: true,
    summary: merge.stdout || `Merged ${sourceBranch} into ${targetBranch}`,
    report: diffStat.stdout,
  };
}

export async function getMergeReport(
  directory: string,
  opConfig: GiteaOperationConfig,
  sourceBranch: string,
  targetBranch: string,
): Promise<string> {
  const [logResult, diffStatResult, diffNumstatResult] = await Promise.all([
    runGiteaGit(
      ["log", "--oneline", `${targetBranch}..${sourceBranch}`],
      directory,
      opConfig,
    ),
    runGiteaGit(
      ["diff", "--stat", `${targetBranch}...${sourceBranch}`],
      directory,
      opConfig,
    ),
    runGiteaGit(
      ["diff", "--numstat", `${targetBranch}...${sourceBranch}`],
      directory,
      opConfig,
    ),
  ]);

  const commits = logResult.stdout.split("\n").filter(Boolean);
  const files = diffNumstatResult.stdout.split("\n").filter(Boolean);

  // Build test plan from changed files
  const testPlan = buildTestPlan(files);

  const lines: string[] = [
    `## Merge Report: ${sourceBranch} → ${targetBranch}\n`,
    "### Summary",
    `- ${commits.length} commit(s) to merge`,
    diffStatResult.stdout ? `- ${diffStatResult.stdout.split("\n").pop()?.trim() || ""}` : "",
    "",
    "### Commits",
  ];

  for (const commit of commits) {
    lines.push(`- ${commit}`);
  }

  lines.push("", "### Files Changed");
  for (const file of files) {
    const [added, removed, name] = file.split("\t");
    lines.push(`- ${name} (+${added} / -${removed})`);
  }

  lines.push("", "### Suggested Test Plan");
  lines.push("Based on the files changed, verify:");
  for (const item of testPlan) {
    lines.push(`- [ ] ${item}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Test plan generation
// ---------------------------------------------------------------------------

function buildTestPlan(files: string[]): string[] {
  const plan: string[] = [];
  const categories = new Set<string>();

  for (const file of files) {
    const name = file.split("\t")[2] || "";

    if (name.includes("server") || name.includes("api") || name.includes("route")) {
      categories.add("API routes: confirm endpoints respond correctly");
    }
    if (name.includes("auth") || name.includes("login") || name.includes("session")) {
      categories.add("Auth: test protected endpoints and login flow");
    }
    if (name.match(/\.jsx?$/) || name.includes("ui/") || name.includes("component")) {
      categories.add("UI: verify pages render and interactive elements work");
    }
    if (name.includes("config") || name.includes(".env")) {
      categories.add("Config: verify environment variables and settings");
    }
    if (name.includes("store") || name.includes("database") || name.includes("storage")) {
      categories.add("Data: verify persistence and data integrity");
    }
    if (name.includes("test")) {
      categories.add("Tests: run test suite and verify all pass");
    }
    if (name.includes("mcp") || name.includes("tool")) {
      categories.add("MCP tools: test tool invocations from agent sessions");
    }
  }

  if (categories.size === 0) {
    categories.add("General: verify the application starts and basic features work");
  }

  categories.add("Regression: verify existing functionality still works");

  for (const item of categories) {
    plan.push(item);
  }

  return plan;
}
