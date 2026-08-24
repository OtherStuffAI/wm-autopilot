/**
 * API route handlers for system endpoints (restart, cleanup).
 * Extracted from server.ts to reduce file size.
 */

import { stat } from "node:fs/promises";
import type { ProcessManager } from "../agents/process-manager";
import type { AccessAction } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import {
  type WarmRestartMarker,
  warmRestartOutcome,
  warmRestartState,
} from "./bootstrap/warm-restart";
import type { AgentType } from "../config";
import type { MessageStore } from "../storage/message-store";
import type { AppProcessManager } from "../apps/app-process-manager";
import type { AppRegistry } from "../apps/app-registry";
import type { SystemCleanupDeps, SystemCleanupResult } from "./system-cleanup";
import { scheduleRestartWithSessionRecovery } from "./restart-request";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

// ---------- Context supplied by server.ts ----------

export interface SystemRoutesContext {
  restartMarkerPath: string;
  warmRestartManagerScriptPath: string;
  projectRoot: string;
  configPort: number;
  wingmanCoreTmuxSession: string;
  manager: ProcessManager;
  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  AccessActions: { SystemManage: AccessAction };
  isAgentType: (agent: string) => agent is AgentType;
  isTrustedRestartAuthority: (authContext: RequestAuthContext) => boolean;
  launchRestart?: (marker: WarmRestartMarker) => Promise<Response>;
  setSessionsStoppedForRestart: (value: boolean) => void;
  initiateShutdown: (reason: string) => void;
  performSystemCleanup: (deps: SystemCleanupDeps) => Promise<SystemCleanupResult>;
  messageStore: MessageStore;
  appProcessManager: AppProcessManager;
  appRegistry: AppRegistry;
}

async function launchRestartManager(ctx: SystemRoutesContext, marker: WarmRestartMarker): Promise<Response> {
  warmRestartState.inProgress = true;
  warmRestartState.marker = marker;
  warmRestartOutcome.current = null;
  ctx.setSessionsStoppedForRestart(true);

  try {
    await stat(ctx.warmRestartManagerScriptPath);
    Bun.spawn([
      Bun.env.WINGMAN_MANAGER_COMMAND?.trim() || "bun",
      "run",
      ctx.warmRestartManagerScriptPath,
      process.pid.toString(),
      ctx.projectRoot,
      String(ctx.configPort),
      ctx.restartMarkerPath,
      ctx.wingmanCoreTmuxSession,
      "wingman-core",
    ], {
      cwd: ctx.projectRoot,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      detached: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warmRestartState.inProgress = false;
    ctx.setSessionsStoppedForRestart(false);
    return Response.json({ error: `Failed to launch restart: ${message}` }, { status: 500 });
  }

  setTimeout(() => {
    void ctx.initiateShutdown("managed-restart");
  }, 250).unref?.();
  return Response.json({
    status: "scheduled",
    mode: marker.mode ?? "resume-or-fresh",
    sessions: marker.sessionIds ?? [],
  }, { status: 202 });
}

// ---------- Main handler ----------

export async function handleSystemRoutes(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: SystemRoutesContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  // GET /api/system/restart/status
  if (pathname === "/api/system/restart/status" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SystemManage, request, url, authContext);
    if (denied && !ctx.isTrustedRestartAuthority(authContext)) return denied;
    return Response.json({
      inProgress: warmRestartState.inProgress,
      marker: warmRestartState.marker,
      outcome: warmRestartOutcome.current,
    });
  }

  // POST /api/system/restart; the older restart-and-resume path is an alias.
  if (
    (pathname === "/api/system/restart" || pathname === "/api/system/restart-and-resume") &&
    method === "POST"
  ) {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SystemManage, request, url, authContext);
    if (denied && !ctx.isTrustedRestartAuthority(authContext)) return denied;
    if (warmRestartState.inProgress) {
      return Response.json({ error: "Restart already in progress" }, { status: 409 });
    }
    const requestedBy = authContext.actorNpub ?? authContext.npub ?? null;
    return scheduleRestartWithSessionRecovery({
      manager: ctx.manager,
      markerPath: ctx.restartMarkerPath,
      requestedBy,
      reason: pathname === "/api/system/restart-and-resume"
        ? "legacy-api-restart-and-resume"
        : "api-restart",
      isAgentType: ctx.isAgentType,
      preflight: ctx.launchRestart
        ? undefined
        : async () => {
          await stat(ctx.warmRestartManagerScriptPath);
        },
      launch: ctx.launchRestart ?? ((marker) => launchRestartManager(ctx, marker)),
    });
  }

  // POST /api/system/cleanup
  if (pathname === "/api/system/cleanup" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SystemManage, request, url, authContext);
    if (denied) {
      return denied;
    }
    try {
      const result = await ctx.performSystemCleanup({
        manager: ctx.manager,
        messageStore: ctx.messageStore,
        appProcessManager: ctx.appProcessManager,
        appRegistry: ctx.appRegistry,
        requestedBy: authContext.actorNpub ?? authContext.npub ?? null,
      });
      return Response.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[system] cleanup failure: ${message}`);
      return Response.json({ error: `System cleanup failed: ${message}` }, { status: 500 });
    }
  }

  return null;
}
