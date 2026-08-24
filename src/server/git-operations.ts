/**
 * Git utility functions extracted from server.ts.
 * Handles git command execution, repository inspection, and worktree management.
 */

import { dirname, isAbsolute, join, normalize } from "node:path";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { readStreamToString } from "./bootstrap/warm-restart";
import { getGitHubGitEnvForUser } from "../git/github-credential-helper";
import {
  buildGitHostMismatchMessage,
  buildGitHubHttpsRequiredMessage,
  describeGitRemote,
} from "../git/remote-auth";

/** Resolved path to the project data directory (e.g. for git credential helpers). */
const wingmanDataDir = new URL("../../data", import.meta.url).pathname;

// ---------- Types ----------

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type GitWorktreeSummary = {
  path: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  primary: boolean;
};

export type GitRepositorySummary = {
  isRepository: true;
  repoRoot: string;
  isRepoRoot: boolean;
  hasGitMetadata: boolean;
  gitDir: string | null;
  currentBranch: string | null;
  headRef: string | null;
  worktrees: GitWorktreeSummary[];
  worktreeBase: string;
  worktreeError: string | null;
};

export type GitCommandAction =
  | "init"
  | "addAll"
  | "commit"
  | "push"
  | "pushUpstream"
  | "pull"
  | "status"
  | "switchBranch"
  | "listRemotes"
  | "setRemote";

export type CreateWorktreeOptions = {
  directory: string;
  branch: string;
  startPoint: string | null;
};

export type CreateWorktreeResult = {
  branch: string;
  path: string;
  repository: GitRepositorySummary | null;
};

// ---------- Internal helpers ----------

export const runCommand = async (
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CommandResult> => {
  let subprocess: ReturnType<typeof Bun.spawn>;
  try {
    subprocess = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 127, stdout: "", stderr: message };
  }

  const [stdout, stderr, exited] = await Promise.all([
    readStreamToString(subprocess.stdout),
    readStreamToString(subprocess.stderr),
    subprocess.exited,
  ]);

  return {
    exitCode: exited ?? 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
};

const resolveGitDirectoryPath = (gitDir: string, cwd: string): string => {
  const normalized = gitDir.trim();
  if (!normalized) {
    return normalize(join(cwd, ".git"));
  }
  return normalize(isAbsolute(normalized) ? normalized : join(cwd, normalized));
};

export const resolveRealPath = async (input: string): Promise<string> => {
  const normalized = normalize(input);
  try {
    return normalize(await realpath(normalized));
  } catch {
    return normalized;
  }
};

// ---------- Exported git functions ----------

export const executeGitCommand = async (options: {
  directory: string;
  action: GitCommandAction;
  message?: string | null;
  remote?: string | null;
  remoteUrl?: string | null;
  branch?: string | null;
  viewerNpub?: string | null;
  gitEnv?: Record<string, string> | null;
  expectedRemoteHost?: string | null;
}): Promise<CommandResult> => {
  const directory = options.directory;
  const action = options.action;

  switch (action) {
    case "init":
      return runCommand("git", ["init"], { cwd: directory });
    case "addAll":
      return runCommand("git", ["add", "."], { cwd: directory });
    case "status":
      return runCommand("git", ["status", "--short", "--branch"], { cwd: directory });
    case "commit": {
      const message = options.message?.trim();
      if (!message) {
        throw new Error("Commit message is required");
      }
      const commandGitEnv = await resolveGitCommandEnv({
        directory,
        action,
        remote: null,
        viewerNpub: options.viewerNpub,
        gitEnv: options.gitEnv,
        expectedRemoteHost: options.expectedRemoteHost,
      });
      return runCommand("git", ["commit", "-m", message], { cwd: directory, env: commandGitEnv ?? undefined });
    }
    case "switchBranch": {
      const branch = options.branch?.trim();
      if (!branch) {
        throw new Error("Branch name is required");
      }
      return runCommand("git", ["switch", branch], { cwd: directory });
    }
    case "listRemotes":
      return runCommand("git", ["remote", "-v"], { cwd: directory });
    case "setRemote": {
      const remote = options.remote?.trim();
      const remoteUrl = options.remoteUrl?.trim();
      if (!remote) {
        throw new Error("Remote name is required");
      }
      if (!remoteUrl) {
        throw new Error("Remote URL is required");
      }
      const existingRemoteUrl = await resolveRemoteUrl(directory, remote);
      if (existingRemoteUrl) {
        return runCommand("git", ["remote", "set-url", remote, remoteUrl], { cwd: directory });
      }
      return runCommand("git", ["remote", "add", remote, remoteUrl], { cwd: directory });
    }
    case "push": {
      const remote = options.remote?.trim();
      const branch = options.branch?.trim();
      const remoteName = remote || null;
      const commandGitEnv = await resolveGitCommandEnv({
        directory,
        action,
        remote: remoteName,
        viewerNpub: options.viewerNpub,
        gitEnv: options.gitEnv,
        expectedRemoteHost: options.expectedRemoteHost,
      });
      const args = ["push"];
      if (remote) {
        args.push(remote);
        if (branch) {
          args.push(branch);
        }
      }
      return runCommand("git", args, { cwd: directory, env: commandGitEnv ?? undefined });
    }
    case "pushUpstream": {
      const remote = options.remote?.trim() || "origin";
      const branch = options.branch?.trim();
      if (!branch) {
        throw new Error("Branch name is required to set upstream");
      }
      const commandGitEnv = await resolveGitCommandEnv({
        directory,
        action,
        remote,
        viewerNpub: options.viewerNpub,
        gitEnv: options.gitEnv,
        expectedRemoteHost: options.expectedRemoteHost,
      });
      return runCommand("git", ["push", "-u", remote, branch], { cwd: directory, env: commandGitEnv ?? undefined });
    }
    case "pull": {
      const remote = options.remote?.trim();
      const branch = options.branch?.trim();
      const remoteName = remote || null;
      const commandGitEnv = await resolveGitCommandEnv({
        directory,
        action,
        remote: remoteName,
        viewerNpub: options.viewerNpub,
        gitEnv: options.gitEnv,
        expectedRemoteHost: options.expectedRemoteHost,
      });
      const args = ["pull"];
      if (remote) {
        args.push(remote);
        if (branch) {
          args.push(branch);
        }
      }
      return runCommand("git", args, { cwd: directory, env: commandGitEnv ?? undefined });
    }
    default:
      throw new Error("Unsupported git command");
  }
};

async function resolveRemoteUrl(directory: string, remote: string): Promise<string | null> {
  const result = await runCommand("git", ["remote", "get-url", remote], { cwd: directory });
  if (result.exitCode !== 0 || !result.stdout) {
    return null;
  }
  return result.stdout.trim();
}

async function resolveGitCommandEnv(options: {
  directory: string;
  action: GitCommandAction;
  remote: string | null;
  viewerNpub?: string | null;
  gitEnv?: Record<string, string> | null;
  expectedRemoteHost?: string | null;
}): Promise<Record<string, string> | null> {
  const remoteName = options.remote?.trim() || null;
  const githubEnv = getGitHubGitEnvForUser(options.viewerNpub, wingmanDataDir);
  const fallbackEnv = options.gitEnv ?? githubEnv ?? null;

  if (!remoteName) {
    return fallbackEnv;
  }

  const remoteUrl = await resolveRemoteUrl(options.directory, remoteName);
  if (!remoteUrl) {
    if (options.expectedRemoteHost) {
      throw new Error(`Remote '${remoteName}' is not configured in this repository`);
    }
    return fallbackEnv;
  }

  const remoteDescriptor = describeGitRemote(remoteName, remoteUrl);

  if (options.expectedRemoteHost && remoteDescriptor.host !== options.expectedRemoteHost) {
    throw new Error(
      buildGitHostMismatchMessage(remoteName, options.expectedRemoteHost, remoteDescriptor.host),
    );
  }

  if (remoteDescriptor.isGithub && remoteDescriptor.usesSsh) {
    throw new Error(buildGitHubHttpsRequiredMessage(remoteName, remoteUrl));
  }

  if (remoteDescriptor.isGithub) {
    if ((options.action === "push" || options.action === "pushUpstream") && !githubEnv) {
      throw new Error("GitHub credentials are not configured for this user. Open Settings -> GitHub and save a token first.");
    }
    return githubEnv ?? fallbackEnv;
  }

  return fallbackEnv;
}

const parseGitWorktreeList = (output: string, repoRoot: string): GitWorktreeSummary[] => {
  if (!output || output.trim().length === 0) {
    return [];
  }

  const entries: GitWorktreeSummary[] = [];
  const lines = output.split(/\r?\n/);
  let current: { path: string; branch: string | null; bare: boolean; detached: boolean } | null = null;

  const pushCurrent = () => {
    if (!current) return;
    const resolvedPath = normalize(current.path);
    entries.push({
      path: resolvedPath,
      branch: current.branch,
      bare: current.bare,
      detached: current.detached,
      primary: resolvedPath === normalize(repoRoot),
    });
    current = null;
  };

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("worktree ")) {
      pushCurrent();
      const path = line.slice("worktree ".length).trim();
      current = { path, branch: null, bare: false, detached: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      const branch =
        ref === "" || ref === "HEAD"
          ? null
          : ref.startsWith("refs/heads/")
            ? ref.slice("refs/heads/".length)
            : ref;
      current.branch = branch;
      continue;
    }
    if (line.startsWith("bare")) {
      current.bare = true;
      continue;
    }
    if (line.startsWith("detached")) {
      current.detached = true;
      continue;
    }
  }

  pushCurrent();
  return entries;
};

export const describeGitRepository = async (directory: string): Promise<GitRepositorySummary | null> => {
  const topLevel = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: directory });
  if (topLevel.exitCode !== 0 || !topLevel.stdout) {
    return null;
  }

  const repoRoot = normalize(topLevel.stdout);
  const [effectiveRepoRoot, effectiveDirectory] = await Promise.all([
    resolveRealPath(repoRoot),
    resolveRealPath(directory),
  ]);
  const isRepoRoot = effectiveDirectory === effectiveRepoRoot;

  const gitDirResult = await runCommand("git", ["rev-parse", "--git-dir"], { cwd: directory });
  const gitDir =
    gitDirResult.exitCode === 0 && gitDirResult.stdout ? resolveGitDirectoryPath(gitDirResult.stdout, directory) : null;

  let hasGitMetadata = false;
  if (isRepoRoot) {
    try {
      const gitStats = await stat(join(repoRoot, ".git"));
      hasGitMetadata = gitStats.isDirectory() || gitStats.isFile();
    } catch {
      hasGitMetadata = false;
    }
  } else {
    try {
      const gitStats = await stat(join(directory, ".git"));
      hasGitMetadata = gitStats.isDirectory() || gitStats.isFile();
    } catch {
      hasGitMetadata = false;
    }
  }

  const branchResult = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: directory });
  const headRef = branchResult.exitCode === 0 && branchResult.stdout ? branchResult.stdout : null;
  const currentBranch = headRef && headRef !== "HEAD" ? headRef : null;

  const worktreeList = await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const worktrees =
    worktreeList.exitCode === 0 ? parseGitWorktreeList(worktreeList.stdout, repoRoot) : [];
  const worktreeError =
    worktreeList.exitCode === 0 ? null : worktreeList.stderr || worktreeList.stdout || null;

  const worktreeBase = normalize(join(repoRoot, ".worktrees"));

  return {
    isRepository: true,
    repoRoot,
    isRepoRoot,
    hasGitMetadata,
    gitDir,
    currentBranch,
    headRef,
    worktrees,
    worktreeBase,
    worktreeError,
  };
};

export const ensureBranchNameValid = async (repoRoot: string, branch: string) => {
  const trimmed = branch.trim();
  if (!trimmed) {
    throw new Error("Branch name is required");
  }
  const check = await runCommand("git", ["check-ref-format", "--branch", trimmed], { cwd: repoRoot });
  if (check.exitCode !== 0) {
    const message = check.stderr || check.stdout || "Invalid branch name";
    throw new Error(message);
  }
};

export const branchExists = async (repoRoot: string, branch: string): Promise<boolean> => {
  const result = await runCommand("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot });
  return result.exitCode === 0;
};

export const ensureStartPointResolvable = async (repoRoot: string, reference: string) => {
  const result = await runCommand("git", ["rev-parse", "--verify", "--quiet", reference], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    const message = result.stderr || result.stdout || `Cannot resolve start point '${reference}'`;
    throw new Error(message);
  }
};

export const createGitWorktree = async ({ directory, branch, startPoint }: CreateWorktreeOptions): Promise<CreateWorktreeResult> => {
  const repository = await describeGitRepository(directory);
  if (!repository) {
    throw new Error("Git repository not detected in the selected directory");
  }

  if (!repository.isRepoRoot) {
    throw new Error("Worktrees can only be created from the repository root");
  }

  if (!repository.hasGitMetadata) {
    throw new Error("The selected directory does not contain a .git folder");
  }

  const repoRoot = repository.repoRoot;
  const branchName = branch.trim();

  await ensureBranchNameValid(repoRoot, branchName);

  const expectedWorktreePath = normalize(join(repoRoot, ".worktrees", branchName));

  const existingWorktree = repository.worktrees.find(
    (worktree) => worktree.branch === branchName || worktree.path === expectedWorktreePath,
  );
  if (existingWorktree) {
    throw new Error(`Branch '${branchName}' is already in use by a worktree at ${existingWorktree.path}`);
  }

  try {
    const stats = await stat(expectedWorktreePath);
    if (stats.isDirectory() || stats.isFile()) {
      throw new Error(`A path already exists at ${expectedWorktreePath}`);
    }
  } catch {
    // ignore ENOENT
  }

  await mkdir(dirname(expectedWorktreePath), { recursive: true });

  const exists = await branchExists(repoRoot, branchName);
  const baseRef =
    exists && startPoint ? startPoint.trim() : startPoint?.trim() || repository.currentBranch || repository.headRef || "HEAD";

  if (!exists) {
    await ensureStartPointResolvable(repoRoot, baseRef);
  }

  const args = ["worktree", "add"];
  if (!exists) {
    args.push("-b", branchName);
  }
  args.push(expectedWorktreePath);
  if (!exists) {
    args.push(baseRef);
  } else {
    args.push(branchName);
  }

  const result = await runCommand("git", args, { cwd: repoRoot });
  if (result.exitCode !== 0) {
    await rm(expectedWorktreePath, { recursive: true, force: true }).catch(() => undefined);
    const message = result.stderr || result.stdout || "Failed to create worktree";
    throw new Error(message);
  }

  const updated = await describeGitRepository(repoRoot);
  return {
    branch: branchName,
    path: expectedWorktreePath,
    repository: updated,
  };
};
