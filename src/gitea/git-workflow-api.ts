/**
 * Git Workflow API Handler
 *
 * HTTP handler for /api/git/* routes. Provides branch management,
 * worktree operations, merging, and status with workflow context.
 * Follows the same factory pattern as gitea-api.ts.
 */

import type { SessionSnapshot } from "../agents/process-manager";
import type { WingmanConfig } from "../config";
import { buildSessionGitCredentialEnv } from "../git/credential-env";
import type { GiteaOperationConfig } from "./gitea-operations";
import { resolveGiteaCredentials } from "./gitea-user-manager";
import {
  getGitStatus,
  listBranches,
  createBranch,
  switchBranch,
  listWorktrees,
  addWorktree,
  removeWorktree,
  mergeBranch,
  getMergeReport,
} from "./git-workflow-ops";
import { runPushGuard } from "./push-guard";
import { parseBody, jsonError } from "../utils/request-utils";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface GitWorkflowApiDependencies {
  getSession: (sessionId: string) => SessionSnapshot | undefined;
  config: WingmanConfig;
  dataDir: string;
  executeGitCommand: (options: {
    directory: string;
    action: "push" | "pushUpstream";
    remote?: string | null;
    branch?: string | null;
    viewerNpub?: string | null;
    gitEnv?: Record<string, string> | null;
  }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonOk(data: Record<string, unknown>): Response {
  return Response.json(data);
}

function resolveSessionContext(
  deps: GitWorkflowApiDependencies,
  sessionId: string,
): { session: SessionSnapshot; directory: string; opConfig: GiteaOperationConfig } | Response {
  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }

  if (!session.workingDirectory) {
    return jsonError("Session has no working directory", 400);
  }

  const giteaOverride = resolveGiteaCredentials(session.npub, deps.config) ?? undefined;

  const opConfig: GiteaOperationConfig = {
    wingmanConfig: deps.config,
    dataDir: deps.dataDir,
    giteaOverride,
  };

  return { session, directory: session.workingDirectory, opConfig };
}

async function runGit(
  directory: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: directory,
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

async function resolveCurrentBranch(directory: string): Promise<string | null> {
  const result = await runGit(directory, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (result.exitCode !== 0 || !result.stdout || result.stdout === "HEAD") {
    return null;
  }
  return result.stdout;
}

async function remoteExists(directory: string, remote: string): Promise<boolean> {
  const result = await runGit(directory, ["remote", "get-url", remote]);
  return result.exitCode === 0 && result.stdout.length > 0;
}

async function resolvePreferredPushRemote(directory: string, branch: string | null): Promise<string | null> {
  if (branch) {
    const upstreamRemote = await runGit(directory, ["config", `branch.${branch}.remote`]);
    if (upstreamRemote.exitCode === 0 && upstreamRemote.stdout) {
      if (await remoteExists(directory, upstreamRemote.stdout)) {
        return upstreamRemote.stdout;
      }
    }
  }

  if (await remoteExists(directory, "gitea")) {
    return "gitea";
  }

  if (await remoteExists(directory, "origin")) {
    return "origin";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createGitWorkflowApiHandler(deps: GitWorkflowApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/git")) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments: ["api", "git", ...]

    try {
      if (method !== "POST") return jsonError("Method not allowed", 405);

      // POST /api/git/status
      if (segments.length === 3 && segments[2] === "status") {
        return await handleStatus(deps, request);
      }

      // POST /api/git/branches
      if (segments.length === 3 && segments[2] === "branches") {
        return await handleBranches(deps, request);
      }

      // POST /api/git/branch/create
      if (segments.length === 4 && segments[2] === "branch" && segments[3] === "create") {
        return await handleBranchCreate(deps, request);
      }

      // POST /api/git/branch/switch
      if (segments.length === 4 && segments[2] === "branch" && segments[3] === "switch") {
        return await handleBranchSwitch(deps, request);
      }

      // POST /api/git/worktrees
      if (segments.length === 3 && segments[2] === "worktrees") {
        return await handleWorktrees(deps, request);
      }

      // POST /api/git/worktree/add
      if (segments.length === 4 && segments[2] === "worktree" && segments[3] === "add") {
        return await handleWorktreeAdd(deps, request);
      }

      // POST /api/git/worktree/remove
      if (segments.length === 4 && segments[2] === "worktree" && segments[3] === "remove") {
        return await handleWorktreeRemove(deps, request);
      }

      // POST /api/git/merge
      if (segments.length === 3 && segments[2] === "merge") {
        return await handleMerge(deps, request);
      }

      // POST /api/git/push
      if (segments.length === 3 && segments[2] === "push") {
        return await handlePush(deps, request);
      }

      return jsonError("Not found", 404);
    } catch (err) {
      console.error("[git-workflow-api] Error:", err);
      return jsonError((err as Error).message, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleStatus(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const status = await getGitStatus(ctx.directory, ctx.opConfig);
  return jsonOk(status as unknown as Record<string, unknown>);
}

async function handleBranches(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const branches = await listBranches(ctx.directory, ctx.opConfig);
  return jsonOk({ branches });
}

async function handleBranchCreate(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const name = body.name as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);
  if (!name) return jsonError("name is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const result = await createBranch(
    ctx.directory,
    ctx.opConfig,
    name,
    body.baseBranch as string | undefined,
  );

  if (!result.success) {
    return jsonError(result.error || "Failed to create branch", 500);
  }

  return jsonOk({ branch: result.branch });
}

async function handleBranchSwitch(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const branch = body.branch as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);
  if (!branch) return jsonError("branch is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const result = await switchBranch(ctx.directory, ctx.opConfig, branch);

  if (!result.success) {
    return jsonError(result.error || "Failed to switch branch", 500);
  }

  return jsonOk({ branch: result.branch, warning: result.warning });
}

async function handleWorktrees(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const worktrees = await listWorktrees(ctx.directory, ctx.opConfig);
  return jsonOk({ worktrees });
}

async function handleWorktreeAdd(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const name = body.name as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);
  if (!name) return jsonError("name is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const result = await addWorktree(ctx.directory, ctx.opConfig, name);

  if (!result.success) {
    return jsonError(result.error || "Failed to add worktree", 500);
  }

  return jsonOk({ path: result.path, branch: result.branch });
}

async function handleWorktreeRemove(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const name = body.name as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);
  if (!name) return jsonError("name is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const result = await removeWorktree(ctx.directory, ctx.opConfig, name);

  if (!result.success) {
    return jsonError(result.error || "Failed to remove worktree", 500);
  }

  return jsonOk({ removed: true, branchMerged: result.branchMerged });
}

async function handleMerge(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const source = body.source as string | undefined;
  const target = (body.target as string | undefined) || "staging";
  const generateReport = body.report !== false;

  if (!sessionId) return jsonError("sessionId is required", 400);
  if (!source) return jsonError("source branch is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  // Generate pre-merge report if requested
  let report: string | undefined;
  if (generateReport) {
    report = await getMergeReport(ctx.directory, ctx.opConfig, source, target);
  }

  // Perform merge
  const result = await mergeBranch(ctx.directory, ctx.opConfig, source, target);

  if (!result.success) {
    return jsonError(result.error || "Merge failed", 500);
  }

  return jsonOk({
    success: true,
    summary: result.summary,
    report: report || result.report,
  });
}

async function handlePush(
  deps: GitWorkflowApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const guard = await runPushGuard(ctx.directory);
  if (!guard.allowed) {
    return Response.json(
      { error: "Push blocked by safety guard", issues: guard.issues },
      { status: 400 },
    );
  }

  const requestedBranch = typeof body.branch === "string" ? body.branch.trim() : "";
  const branch = requestedBranch || await resolveCurrentBranch(ctx.directory);
  if (!branch) {
    return jsonError("Unable to determine the current branch", 400);
  }

  const remote = await resolvePreferredPushRemote(ctx.directory, branch);
  if (!remote) {
    return jsonError("No push remote is configured for this repository", 400);
  }

  const gitEnv = buildSessionGitCredentialEnv({
    npub: ctx.session.npub,
    dataDir: deps.dataDir,
    giteaConfig: ctx.opConfig.giteaOverride ?? null,
  });

  const action = remote === "gitea" ? "pushUpstream" : "push";
  const result = await deps.executeGitCommand({
    directory: ctx.directory,
    action,
    remote,
    branch,
    viewerNpub: ctx.session.npub ?? null,
    gitEnv,
  });

  if (result.exitCode !== 0) {
    return jsonError(result.stderr || result.stdout || "Push failed", 500);
  }

  return jsonOk({
    remote,
    branch,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}
