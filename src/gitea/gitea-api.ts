/**
 * Gitea API Handler
 *
 * HTTP handler for /api/gitea/* routes. Provides programmatic git
 * operations (set-remote, push, pull, commit-and-push) scoped to
 * the Gitea remote. Follows the same factory pattern as ngit-api.ts.
 *
 * Supports per-user Gitea credentials: if the session's npub has a
 * provisioned Gitea account, operations use that user's token/owner.
 * Otherwise falls back to the configured service administrator credentials.
 */

import type { SessionSnapshot } from "../agents/process-manager";
import type { WingmanConfig } from "../config";
import {
  setGiteaRemote,
  pushToGitea,
  pullFromGitea,
  commitAndPushToGitea,
  type GiteaOperationConfig,
} from "./gitea-operations";
import { resolveGiteaCredentials } from "./gitea-user-manager";
import { runPushGuard } from "./push-guard";
import { browserSubscribers } from "../mcp/browser-subscribers";
import { parseBody, jsonError } from "../utils/request-utils";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface GiteaApiDependencies {
  getSession: (sessionId: string) => SessionSnapshot | undefined;
  config: WingmanConfig;
  dataDir: string;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonOk(data: Record<string, unknown>): Response {
  return Response.json(data);
}

/**
 * Resolve session → working directory, plus build the GiteaOperationConfig
 * with per-user credential override when available.
 */
function resolveSessionContext(
  deps: GiteaApiDependencies,
  sessionId: string,
): { directory: string; opConfig: GiteaOperationConfig } | Response {
  if (!deps.config.giteaUrl || !deps.config.giteaApiToken || !deps.config.giteaOwner) {
    return jsonError("Gitea is not configured (set GITEA_URL, GITEA_API_TOKEN, GITEA_OWNER)", 503);
  }

  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }

  if (!session.workingDirectory) {
    return jsonError("Session has no working directory", 400);
  }

  // Resolve per-user credentials (falls back to admin)
  const giteaOverride = resolveGiteaCredentials(session.npub, deps.config) ?? undefined;

  const opConfig: GiteaOperationConfig = {
    wingmanConfig: deps.config,
    dataDir: deps.dataDir,
    giteaOverride,
  };

  return { directory: session.workingDirectory, opConfig };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createGiteaApiHandler(deps: GiteaApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/gitea")) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments: ["api", "gitea", ...]

    try {
      // POST /api/gitea/set-remote
      if (segments.length === 3 && segments[2] === "set-remote" && method === "POST") {
        return await handleSetRemote(deps, request);
      }

      // POST /api/gitea/push
      if (segments.length === 3 && segments[2] === "push" && method === "POST") {
        return await handlePush(deps, request);
      }

      // POST /api/gitea/pull
      if (segments.length === 3 && segments[2] === "pull" && method === "POST") {
        return await handlePull(deps, request);
      }

      // POST /api/gitea/commit-and-push
      if (segments.length === 3 && segments[2] === "commit-and-push" && method === "POST") {
        return await handleCommitAndPush(deps, request);
      }

      // GET /api/gitea/remote-url?sessionId=...
      if (segments.length === 3 && segments[2] === "remote-url" && method === "GET") {
        return await handleGetRemoteUrl(deps, url);
      }

      return jsonError("Not found", 404);
    } catch (err) {
      console.error("[gitea-api] Error:", err);
      return jsonError((err as Error).message, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/gitea/set-remote
 *
 * Create Gitea repo and add/update the "gitea" remote.
 * Body: { sessionId, projectName? }
 */
async function handleSetRemote(
  deps: GiteaApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const result = await setGiteaRemote({
    directory: ctx.directory,
    opConfig: ctx.opConfig,
    projectName: body.projectName as string | undefined,
  });

  if (!result.success) {
    return jsonError(result.stderr || "Set remote failed", 500);
  }

  console.log(`[gitea-api] Set remote for session ${sessionId}: ${result.cloneUrl}`);

  return jsonOk({
    stdout: result.stdout,
    stderr: result.stderr,
    cloneUrl: result.cloneUrl,
    repoCreated: result.repoCreated,
  });
}

/**
 * POST /api/gitea/push
 *
 * Push to the "gitea" remote.
 * Body: { sessionId, branch? }
 */
async function handlePush(
  deps: GiteaApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  // Run push safety guard
  const guard = await runPushGuard(ctx.directory);
  if (!guard.allowed) {
    // Notify browser via SSE so the user sees why
    const session = deps.getSession(sessionId);
    if (session?.npub) {
      browserSubscribers.send(session.npub, {
        type: "pushguard:blocked",
        issues: guard.issues,
      });
    }
    return Response.json(
      { error: "Push blocked by safety guard", issues: guard.issues },
      { status: 400 },
    );
  }

  const result = await pushToGitea({
    directory: ctx.directory,
    opConfig: ctx.opConfig,
    branch: body.branch as string | undefined,
  });

  if (!result.success) {
    return jsonError(result.stderr || "Push failed", 500);
  }

  console.log(`[gitea-api] Push for session ${sessionId}: ${result.stdout || "ok"}`);

  return jsonOk({ stdout: result.stdout, stderr: result.stderr });
}

/**
 * POST /api/gitea/pull
 *
 * Pull from the "gitea" remote.
 * Body: { sessionId, branch? }
 */
async function handlePull(
  deps: GiteaApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  const result = await pullFromGitea({
    directory: ctx.directory,
    opConfig: ctx.opConfig,
    branch: body.branch as string | undefined,
  });

  if (!result.success) {
    return jsonError(result.stderr || "Pull failed", 500);
  }

  console.log(`[gitea-api] Pull for session ${sessionId}: ${result.stdout || "ok"}`);

  return jsonOk({ stdout: result.stdout, stderr: result.stderr });
}

/**
 * POST /api/gitea/commit-and-push
 *
 * Stage all, commit, and push to the "gitea" remote.
 * Body: { sessionId, message? }
 */
async function handleCommitAndPush(
  deps: GiteaApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  if (!sessionId) return jsonError("sessionId is required", 400);

  const ctx = resolveSessionContext(deps, sessionId);
  if (ctx instanceof Response) return ctx;

  // Run push safety guard
  const guard = await runPushGuard(ctx.directory);
  if (!guard.allowed) {
    // Notify browser via SSE so the user sees why
    const session = deps.getSession(sessionId);
    if (session?.npub) {
      browserSubscribers.send(session.npub, {
        type: "pushguard:blocked",
        issues: guard.issues,
      });
    }
    return Response.json(
      { error: "Push blocked by safety guard", issues: guard.issues },
      { status: 400 },
    );
  }

  const result = await commitAndPushToGitea({
    directory: ctx.directory,
    opConfig: ctx.opConfig,
    message: body.message as string | undefined,
  });

  if (!result.success) {
    return jsonError(result.stderr || "Commit and push failed", 500);
  }

  console.log(`[gitea-api] Commit+push for session ${sessionId}: ${result.stdout || "ok"}`);

  return jsonOk({ stdout: result.stdout, stderr: result.stderr });
}

/**
 * GET /api/gitea/remote-url?sessionId=...
 *
 * Returns the "gitea" remote URL and a web-browsable link for the repo.
 * Reads from `git remote get-url gitea` in the session's working directory.
 */
async function handleGetRemoteUrl(
  deps: GiteaApiDependencies,
  url: URL,
): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return jsonError("sessionId query param is required", 400);

  const session = deps.getSession(sessionId);
  if (!session) return jsonError("Unknown session", 404);
  if (!session.workingDirectory) return jsonError("Session has no working directory", 400);

  try {
    const proc = Bun.spawn(["git", "remote", "get-url", "gitea"], {
      cwd: session.workingDirectory,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    if (proc.exitCode !== 0) {
      return jsonOk({ configured: false, error: stderr.trim() || "No gitea remote found" });
    }

    const cloneUrl = stdout.trim();

    // Convert clone URL to a web-browsable URL
    // e.g. https://gitea.example.com/user/repo.git → https://gitea.example.com/user/repo
    const webUrl = cloneUrl.replace(/\.git$/, "");

    return jsonOk({ configured: true, cloneUrl, webUrl });
  } catch (err) {
    return jsonError(`Failed to read git remote: ${(err as Error).message}`, 500);
  }
}
