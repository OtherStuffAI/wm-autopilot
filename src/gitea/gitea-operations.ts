/**
 * Gitea Git Operations
 *
 * Core git operations (set-remote, push, pull, commit-and-push) that
 * inject Gitea credential-helper env vars per-command so they only
 * apply to the Gitea URL — never interfering with GitHub/origin.
 *
 * Used by both the HTTP API (gitea-api.ts) and MCP tool (git-push.ts).
 */

import { ensureCredentialHelper, getGiteaGitEnv } from "./credential-helper";
import { repoExists, createRepo, isGiteaConfigured, type GiteaConfig } from "./gitea-client";
import { deriveRepoName } from "./name-generator";
import type { WingmanConfig } from "../config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GiteaOperationConfig {
  /** Full WingmanConfig — used to extract Gitea settings + credential env. */
  wingmanConfig: WingmanConfig;
  /** Path to the data directory (for the credential helper script). */
  dataDir: string;
  /** Per-user Gitea credentials override. When set, used instead of config. */
  giteaOverride?: GiteaConfig;
}

export interface GiteaOperationResult {
  success: boolean;
  stdout: string;
  stderr: string;
  /** Clone URL of the Gitea remote (set-remote only). */
  cloneUrl?: string;
  /** Whether the repo was newly created (set-remote only). */
  repoCreated?: boolean;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Build the Gitea config object — uses per-user override if present,
 * otherwise falls back to extracting from WingmanConfig.
 */
function resolveGiteaConfig(opConfig: GiteaOperationConfig): GiteaConfig | null {
  if (opConfig.giteaOverride) return opConfig.giteaOverride;

  const partial = {
    url: opConfig.wingmanConfig.giteaUrl ?? undefined,
    apiToken: opConfig.wingmanConfig.giteaApiToken ?? undefined,
    owner: opConfig.wingmanConfig.giteaOwner ?? undefined,
  };
  return isGiteaConfigured(partial) ? partial : null;
}

/**
 * Build the environment for a git subprocess that includes the Gitea
 * credential helper. Returns null if Gitea is not configured.
 */
function buildGiteaEnv(
  opConfig: GiteaOperationConfig,
): Record<string, string | undefined> | null {
  const giteaConfig = resolveGiteaConfig(opConfig);
  if (!giteaConfig) return null;

  const helperPath = ensureCredentialHelper(opConfig.dataDir);
  if (!helperPath) return null;

  const giteaEnv = getGiteaGitEnv(giteaConfig, helperPath);
  return { ...process.env, ...giteaEnv };
}

/**
 * Run a git command in a given directory with Gitea credentials injected.
 */
export async function runGiteaGit(
  args: string[],
  directory: string,
  opConfig: GiteaOperationConfig,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = buildGiteaEnv(opConfig);
  if (!env) {
    return { exitCode: 1, stdout: "", stderr: "Gitea is not configured" };
  }

  const proc = Bun.spawn(["git", ...args], {
    cwd: directory,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Detect the current branch name.
 */
export async function getCurrentBranch(
  directory: string,
  opConfig: GiteaOperationConfig,
): Promise<string> {
  const result = await runGiteaGit(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    directory,
    opConfig,
  );
  return result.stdout || "main";
}

/**
 * Ensure the directory has its own git repo. If the directory is inside a
 * parent repo (or has no repo at all), run `git init` so that all
 * subsequent operations are scoped to this directory — not a parent.
 *
 * Returns true if a new repo was initialised, false if one already existed.
 */
async function ensureGitRepo(
  directory: string,
  opConfig: GiteaOperationConfig,
): Promise<boolean> {
  const toplevel = await runGiteaGit(
    ["rev-parse", "--show-toplevel"],
    directory,
    opConfig,
  );

  // Normalise paths for comparison (strip trailing slashes)
  const normalise = (p: string) => p.replace(/\/+$/, "");
  const isOwnRepo =
    toplevel.exitCode === 0 &&
    normalise(toplevel.stdout) === normalise(directory);

  if (isOwnRepo) return false;

  // Either no repo or a parent repo — init a fresh one here
  await runGiteaGit(["init"], directory, opConfig);
  return true;
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Create a Gitea repo (if needed) and add/update the "gitea" remote.
 */
export async function setGiteaRemote(opts: {
  directory: string;
  opConfig: GiteaOperationConfig;
  projectName?: string;
}): Promise<GiteaOperationResult> {
  const { directory, opConfig, projectName } = opts;

  const giteaConfig = resolveGiteaConfig(opConfig);
  if (!giteaConfig) {
    return { success: false, stdout: "", stderr: "Gitea is not configured" };
  }

  // Make sure this directory has its own git repo — not a parent's
  await ensureGitRepo(directory, opConfig);

  // If the repo is a shallow clone (e.g. cloned from GitHub with --depth 1),
  // unshallow it now so Gitea won't reject the push later.
  const shallowCheck = await runGiteaGit(
    ["rev-parse", "--is-shallow-repository"],
    directory,
    opConfig,
  );
  if (shallowCheck.stdout.trim() === "true") {
    await runGiteaGit(["fetch", "--unshallow"], directory, opConfig);
  }

  // Derive repo name from project name or directory basename
  const repoName = deriveRepoName(projectName, directory);

  // Check if a repo with this name already exists
  let cloneUrl: string;
  let repoCreated: boolean;
  try {
    const existing = await repoExists(giteaConfig, repoName);
    if (existing) {
      return {
        success: false,
        stdout: "",
        stderr: `A Gitea repo named "${repoName}" already exists (${existing.htmlUrl}). ` +
          `Pass a different projectName to use a different name.`,
      };
    }

    const repo = await createRepo(giteaConfig, {
      name: repoName,
      description: projectName ? `Wingman: ${projectName}` : `Wingman: ${repoName}`,
    });
    cloneUrl = repo.cloneUrl;
    repoCreated = true;
  } catch (err) {
    return {
      success: false,
      stdout: "",
      stderr: `Failed to create Gitea repo: ${(err as Error).message}`,
    };
  }

  // Check if "gitea" remote already exists
  const remoteCheck = await runGiteaGit(
    ["remote", "get-url", "gitea"],
    directory,
    opConfig,
  );

  if (remoteCheck.exitCode === 0) {
    // Remote exists — update it
    const setUrl = await runGiteaGit(
      ["remote", "set-url", "gitea", cloneUrl],
      directory,
      opConfig,
    );
    if (setUrl.exitCode !== 0) {
      return { success: false, stdout: setUrl.stdout, stderr: setUrl.stderr };
    }
  } else {
    // Remote doesn't exist — add it
    const addRemote = await runGiteaGit(
      ["remote", "add", "gitea", cloneUrl],
      directory,
      opConfig,
    );
    if (addRemote.exitCode !== 0) {
      return { success: false, stdout: addRemote.stdout, stderr: addRemote.stderr };
    }
  }

  return {
    success: true,
    stdout: `Remote "gitea" set to ${cloneUrl}${repoCreated ? " (repo created)" : ""}`,
    stderr: "",
    cloneUrl,
    repoCreated,
  };
}

/**
 * Push the current (or specified) branch to the "gitea" remote.
 */
export async function pushToGitea(opts: {
  directory: string;
  opConfig: GiteaOperationConfig;
  branch?: string;
}): Promise<GiteaOperationResult> {
  const { directory, opConfig } = opts;
  const branch = opts.branch || await getCurrentBranch(directory, opConfig);

  const result = await runGiteaGit(
    ["push", "gitea", branch],
    directory,
    opConfig,
  );

  return {
    success: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Pull the current (or specified) branch from the "gitea" remote.
 */
export async function pullFromGitea(opts: {
  directory: string;
  opConfig: GiteaOperationConfig;
  branch?: string;
}): Promise<GiteaOperationResult> {
  const { directory, opConfig } = opts;
  const branch = opts.branch || await getCurrentBranch(directory, opConfig);

  const result = await runGiteaGit(
    ["pull", "gitea", branch],
    directory,
    opConfig,
  );

  return {
    success: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Stage all changes, commit with a message, and push to "gitea" remote.
 */
export async function commitAndPushToGitea(opts: {
  directory: string;
  opConfig: GiteaOperationConfig;
  message?: string;
}): Promise<GiteaOperationResult> {
  const { directory, opConfig } = opts;
  const commitMessage = opts.message || "updates";

  // Make sure this directory has its own git repo — not a parent's
  await ensureGitRepo(directory, opConfig);

  // Stage all changes
  const add = await runGiteaGit(["add", "."], directory, opConfig);
  if (add.exitCode !== 0) {
    return { success: false, stdout: add.stdout, stderr: `git add failed: ${add.stderr}` };
  }

  // Check if there's anything to commit
  const status = await runGiteaGit(["status", "--porcelain"], directory, opConfig);
  if (status.stdout.length === 0) {
    // Nothing to commit — just push
    const branch = await getCurrentBranch(directory, opConfig);
    const push = await runGiteaGit(["push", "gitea", branch], directory, opConfig);
    return {
      success: push.exitCode === 0,
      stdout: "Nothing to commit. " + push.stdout,
      stderr: push.stderr,
    };
  }

  // Commit
  const commit = await runGiteaGit(
    ["commit", "-m", commitMessage],
    directory,
    opConfig,
  );
  if (commit.exitCode !== 0) {
    return { success: false, stdout: commit.stdout, stderr: `git commit failed: ${commit.stderr}` };
  }

  // Push
  const branch = await getCurrentBranch(directory, opConfig);
  const push = await runGiteaGit(
    ["push", "gitea", branch],
    directory,
    opConfig,
  );

  return {
    success: push.exitCode === 0,
    stdout: [commit.stdout, push.stdout].filter(Boolean).join("\n"),
    stderr: push.stderr,
  };
}
