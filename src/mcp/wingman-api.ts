/**
 * Wingman Action API Handler
 *
 * HTTP handler for /api/mcp/wingman/* routes.
 * Called by the MCP stdio server (running inside agent processes)
 * to manage apps, sessions, logs, and CapRover deployments.
 *
 * Follows the Nip98Api pattern — factory function returning a
 * (request, url, method) => Response handler.
 * Validated by sessionId (no cookie auth).
 */

import type { SessionOrigin, SessionSnapshot } from "../agents/process-manager";
import type { RuntimeBotIdentity } from "../agent-chat/types";
import {
  acquireFlightDeckPgEditLease,
  createFlightDeckPgChannelDocument,
  createFlightDeckPgChannelMessage,
  createFlightDeckPgDocumentComment,
  createFlightDeckPgTaskComment,
  decodeFlightDeckPgDocumentBody,
  fetchFlightDeckPgDailyScope,
  fetchFlightDeckPgChannelMessages,
  fetchFlightDeckPgDocument,
  fetchFlightDeckPgDocumentComments,
  fetchFlightDeckPgTask,
  fetchFlightDeckPgTaskComments,
  updateFlightDeckPgDocument,
  updateFlightDeckPgTaskState,
  upsertFlightDeckPgDailyScope,
} from "../agent-chat/tower-client";
import { AGENT_TYPES, AGENT_TYPE_LIST, type AgentType } from "../agent-types";
import type { AppRecord, AppLifecycleAction } from "../apps/app-registry";
import type { AppProcessStatus } from "../apps/app-process-manager";
import type { CaproverStore } from "../caprover/caprover-store";
import type { CaproverClient, CaproverTargetClient } from "../caprover/caprover-client";
import { createAppTarball } from "../caprover/tarball";
import { listSkills, loadSkill } from "./skill-loader";
import { generateAndSaveImages } from "./services/image-generator";
import type { UserSettingsStore } from "../storage/user-settings-store";
import type { ArtifactsStore, CreateArtifactInput } from "../storage/artifacts-store";
import type { NpubProjectRecord } from "../projects/npub-project-store";
import type { MemoryStore } from "./memory-store";
import type { PipelineStore, JsonObject } from "../pipelines/pipeline-store";
import { parseBody, jsonError } from "../utils/request-utils";
import type { NightWatchStartOptions } from "../nightwatch/nightwatch-start-config";
import { parseNightWatchStartOptions } from "../nightwatch/nightwatch-start-config";
import {
  type SessionMetadataInput,
  isAgentManagedByMetadataOrOrigin,
} from "../sessions/session-metadata";
import { resolveSessionOwnerNpub } from "../sessions/session-ownership";
import type { DocumentDirectStore } from "../agent-chat/document-direct-runtime";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface WingmanMcpApiDependencies {
  getSession: (sessionId: string) => SessionSnapshot | null;
  listSessions: () => SessionSnapshot[];
  createSession: (
    agent: AgentType,
    workingDirectory?: string,
    name?: string,
    explicitNpub?: string,
    origin?: SessionOrigin | null,
    metadata?: SessionMetadataInput,
  ) => Promise<SessionSnapshot>;
  enableNightWatch: (sessionId: string, options?: Omit<NightWatchStartOptions, "enabled">) => unknown;
  stopSession: (sessionId: string) => Promise<SessionSnapshot | null>;
  scheduleArchive: (sessionId: string) => void;
  getSessionLogs: (sessionId: string) => Promise<string[] | undefined>;
  getSessionMessages: (sessionId: string) => Promise<{ role: string; content: string; createdAt: string }[]>;
  listApps: () => Promise<AppRecord[]>;
  getAppStatus: (appId: string) => Promise<AppProcessStatus>;
  runAppAction: (appId: string, action: AppLifecycleAction) => Promise<AppProcessStatus>;
  tailAppLogs: (appId: string, lines?: number) => Promise<string[]>;
  caproverStore: CaproverStore;
  getCaproverClient: () => CaproverClient | null;
  getCaproverTargets?: () => CaproverTargetClient[];
  userSkillsRoot: string;
  defaultSkillsRoot: string;
  userSettingsStore: UserSettingsStore;
  artifactsStore: ArtifactsStore;
  openRouterApiKey: string | null;
  findProjectByDirectory: (directoryPath: string) => NpubProjectRecord | null;
  memoryStore: MemoryStore;
  getWingmanNpub: () => string | null;
  setPinnedFile: (sessionId: string, filePath: string | null) => SessionSnapshot | null | undefined;
  removePinnedFile: (sessionId: string, filePath: string) => SessionSnapshot | null | undefined;
  setPinnedFiles: (
    sessionId: string,
    filePaths: string[],
    activeFilePath?: string | null,
  ) => SessionSnapshot | null | undefined;
  pipelineStore?: PipelineStore;
  getBotIdentityForSubscription?: (subscriptionId: string) => RuntimeBotIdentity | null;
  documentDirectStore?: DocumentDirectStore;
  getFlightDeckRuntimeContext?: (subscriptionId: string) => {
    backendBaseUrl: string;
    workspaceId: string;
    appNpub: string;
    botIdentity: RuntimeBotIdentity;
  } | null;
  resolveFlightDeckDirectContext?: (input: {
    towerServiceNpub: string;
    workspaceId: string;
    agentNpub: string;
  }) => {
    subscriptionId: string;
    backendBaseUrl: string;
    appNpub: string;
    botIdentity: RuntimeBotIdentity;
  } | null;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonOk(data: unknown): Response {
  return Response.json(data);
}

function requireSessionId(
  deps: WingmanMcpApiDependencies,
  sessionId: string | undefined | null,
): Response | null {
  if (!sessionId) {
    return jsonError("sessionId is required", 400);
  }
  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }
  return null; // valid
}

function normaliseCaproverTargetName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9-]*$/.test(normalized) ? normalized : null;
}

function resolveCaproverTargets(
  deps: WingmanMcpApiDependencies,
  requestedTarget: unknown,
): CaproverTargetClient[] | Response {
  const configuredTargets = deps.getCaproverTargets?.() ?? [];
  const targets = configuredTargets.length > 0
    ? configuredTargets
    : (() => {
        const client = deps.getCaproverClient();
        return client ? [{ name: "primary", serverUrl: "", client }] : [];
      })();

  if (targets.length === 0) {
    return jsonError("CapRover is not configured — set CAPROVER_URL and LOGIN_CODE", 503);
  }

  const requested = requestedTarget === undefined ? "all" : normaliseCaproverTargetName(requestedTarget);
  if (!requested) {
    return jsonError('caproverTarget must be "all" or a configured target name', 400);
  }
  if (requested === "all") {
    return targets;
  }

  const target = targets.find((candidate) => candidate.name === requested);
  if (!target) {
    return jsonError(`Unknown CapRover target: ${requested}`, 400);
  }

  return [target];
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createWingmanMcpApiHandler(deps: WingmanMcpApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/mcp/wingman")) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments: ["api", "mcp", "wingman", ...]

    try {
      // GET /api/mcp/wingman/apps
      if (segments.length === 4 && segments[3] === "apps" && method === "GET") {
        return await handleListApps(deps, url);
      }

      // POST /api/mcp/wingman/apps/action
      if (segments.length === 5 && segments[3] === "apps" && segments[4] === "action" && method === "POST") {
        return jsonError("Use the broker-signed Admin owner-space app route", 410);
      }

      // GET /api/mcp/wingman/logs
      if (segments.length === 4 && segments[3] === "logs" && method === "GET") {
        return await handleReadLogs(deps, url);
      }

      // GET /api/mcp/wingman/sessions
      if (segments.length === 4 && segments[3] === "sessions" && method === "GET") {
        return handleListSessions(deps, url);
      }

      // POST /api/mcp/wingman/sessions
      if (segments.length === 4 && segments[3] === "sessions" && method === "POST") {
        return await handleCreateSession(deps, request);
      }

      // POST /api/mcp/wingman/sessions/stop
      if (segments.length === 5 && segments[3] === "sessions" && segments[4] === "stop" && method === "POST") {
        return await handleStopSession(deps, request);
      }

      // GET /api/mcp/wingman/caprover/apps
      if (segments.length === 5 && segments[3] === "caprover" && segments[4] === "apps" && method === "GET") {
        return handleListCaproverApps(deps, url);
      }

      // POST /api/mcp/wingman/caprover/deploy
      if (segments.length === 5 && segments[3] === "caprover" && segments[4] === "deploy" && method === "POST") {
        return await handleDeployCaproverApp(deps, request);
      }

      // GET /api/mcp/wingman/skills
      if (segments.length === 4 && segments[3] === "skills" && method === "GET") {
        return await handleListSkills(deps, url);
      }

      // GET /api/mcp/wingman/skills/load
      if (segments.length === 5 && segments[3] === "skills" && segments[4] === "load" && method === "GET") {
        return await handleLoadSkill(deps, url);
      }

      // POST /api/mcp/wingman/generate-image
      if (segments.length === 4 && segments[3] === "generate-image" && method === "POST") {
        return await handleGenerateImage(deps, request);
      }

      // GET /api/mcp/wingman/artifacts?sessionId=...
      if (segments.length === 4 && segments[3] === "artifacts" && method === "GET") {
        return handleListArtifacts(deps, url);
      }

      // POST /api/mcp/wingman/artifacts
      if (segments.length === 4 && segments[3] === "artifacts" && method === "POST") {
        return await handleRegisterArtifact(deps, request);
      }

      // GET /api/mcp/wingman/project?sessionId=...
      if (segments.length === 4 && segments[3] === "project" && method === "GET") {
        return handleGetProject(deps, url);
      }

      // GET /api/mcp/wingman/memory?sessionId=...&query=...&tags=...
      if (segments.length === 4 && segments[3] === "memory" && method === "GET") {
        return handleSearchMemory(deps, url);
      }

      // POST /api/mcp/wingman/memory
      if (segments.length === 4 && segments[3] === "memory" && method === "POST") {
        return await handleSaveMemory(deps, request);
      }

      // DELETE /api/mcp/wingman/memory?sessionId=...&id=...
      if (segments.length === 4 && segments[3] === "memory" && method === "DELETE") {
        return handleDeleteMemory(deps, url);
      }

      // POST /api/mcp/wingman/artifact/pin
      if (segments.length === 5 && segments[3] === "artifact" && segments[4] === "pin" && method === "POST") {
        return await handlePinArtifact(deps, request);
      }

      // GET /api/mcp/wingman/artifact/pin?sessionId=...
      if (segments.length === 5 && segments[3] === "artifact" && segments[4] === "pin" && method === "GET") {
        return handleGetPinnedArtifact(deps, url);
      }

      // POST /api/mcp/wingman/flightdeck
      if (segments.length === 4 && segments[3] === "flightdeck" && method === "POST") {
        return await handleFlightDeckHelper(deps, request);
      }

      return jsonError("Not found", 404);
    } catch (err) {
      console.error("[wingman-mcp-api] Error:", err);
      return jsonError((err as Error).message, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/mcp/wingman/apps?sessionId=...
 * List registered apps with their process status.
 */
async function handleListApps(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const apps = await deps.listApps();

  const results = await Promise.all(
    apps.map(async (app) => {
      let status: AppProcessStatus | null = null;
      try {
        status = await deps.getAppStatus(app.id);
      } catch {
        // App may not have a process yet
      }
      return {
        id: app.id,
        label: app.label,
        root: app.root,
        scripts: app.scripts,
        running: status?.running ?? false,
        status: status?.status ?? "unknown",
        pm2Name: app.pm2Name ?? null,
      };
    }),
  );

  return jsonOk({ apps: results });
}

/**
 * POST /api/mcp/wingman/apps/action
 * Body: { sessionId, appId, action }
 */
async function handleManageApp(
  deps: WingmanMcpApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const appId = body.appId as string | undefined;
  const action = body.action as string | undefined;

  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  if (!appId) {
    return jsonError("appId is required", 400);
  }

  const validActions: AppLifecycleAction[] = ["start", "stop", "restart", "build", "setup"];
  if (!action || !validActions.includes(action as AppLifecycleAction)) {
    return jsonError(`action must be one of: ${validActions.join(", ")}`, 400);
  }

  const result = await deps.runAppAction(appId, action as AppLifecycleAction);
  return jsonOk({
    appId,
    action,
    status: result.status,
    running: result.running,
    message: result.message ?? null,
  });
}

/**
 * GET /api/mcp/wingman/logs?sessionId=...&source=session|app&id=...&lines=100
 */
async function handleReadLogs(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const source = url.searchParams.get("source");
  const targetId = url.searchParams.get("id");
  const lines = Math.min(Number(url.searchParams.get("lines") ?? "100"), 500);

  if (!source || !targetId) {
    return jsonError("source and id are required query parameters", 400);
  }

  if (source === "session") {
    const messages = await deps.getSessionMessages(targetId);
    if (messages.length > 0) {
      const formatted = messages.map((m) => {
        const truncated =
          m.content.length > 2000
            ? m.content.slice(0, 2000) + "... [truncated]"
            : m.content;
        return `[${m.role}] ${truncated}`;
      });
      const tail = formatted.slice(-lines);
      return jsonOk({ source, id: targetId, lines: tail.length, logs: tail });
    }
    // Fall back to process logs if no conversation messages available
    const logs = await deps.getSessionLogs(targetId);
    if (!logs) {
      return jsonError("Session not found or has no logs", 404);
    }
    const tail = logs.slice(-lines);
    return jsonOk({ source, id: targetId, lines: tail.length, logs: tail });
  }

  if (source === "app") {
    const logLines = await deps.tailAppLogs(targetId, lines);
    return jsonOk({ source, id: targetId, lines: logLines.length, logs: logLines });
  }

  return jsonError("source must be 'session' or 'app'", 400);
}

/**
 * GET /api/mcp/wingman/sessions?sessionId=...
 */
function handleListSessions(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Response {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const sessions = deps.listSessions().map((s) => ({
    id: s.id,
    agent: s.agent,
    name: s.name,
    status: s.status,
    startedAt: s.startedAt,
    workingDirectory: s.workingDirectory,
    port: s.port,
    pid: s.pid ?? null,
    ownerNpub: resolveSessionOwnerNpub(s.npub ?? null, s.metadata),
    metadata: s.metadata ?? { AGENT: false, billingMode: "subscription" },
  }));

  return jsonOk({ sessions });
}

/**
 * POST /api/mcp/wingman/sessions
 * Body: { sessionId, agent, directory?, name?, nightwatch? }
 */
async function handleCreateSession(
  deps: WingmanMcpApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const agent = body.agent as string | undefined;
  const directory = body.directory as string | undefined;
  const name = body.name as string | undefined;
  let nightWatch: NightWatchStartOptions | null = null;

  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;
  const callerSession = deps.getSession(sessionId!);
  if (!callerSession) {
    return jsonError("Caller session not found", 404);
  }

  if (!agent || !AGENT_TYPES.includes(agent as AgentType)) {
    return jsonError(`agent must be one of: ${AGENT_TYPE_LIST}`, 400);
  }

  try {
    nightWatch = parseNightWatchStartOptions(body.nightwatch ?? null);
  } catch (error) {
    return jsonError((error as Error).message, 400);
  }

  const origin: SessionOrigin = {
    type: "agent-session",
    id: callerSession.id,
    label: callerSession.name || callerSession.id,
  };
  const session = await deps.createSession(
    agent as AgentType,
    directory,
    name,
    callerSession.npub,
    origin,
    { AGENT: true },
  );
  if (nightWatch?.enabled) {
    deps.enableNightWatch(session.id, {
      prompt: nightWatch.prompt,
      intervalMinutes: nightWatch.intervalMinutes,
      maxCycles: nightWatch.maxCycles,
    });
  }
  return jsonOk({
    id: session.id,
    agent: session.agent,
    name: session.name,
    status: session.status,
    port: session.port,
    workingDirectory: session.workingDirectory,
    startedAt: session.startedAt,
    nightwatch: nightWatch?.enabled
      ? {
          enabled: true,
          prompt: nightWatch.prompt ?? null,
          intervalMinutes: nightWatch.intervalMinutes ?? null,
          maxCycles: nightWatch.maxCycles ?? null,
        }
      : null,
  });
}

/**
 * POST /api/mcp/wingman/sessions/stop
 * Body: { sessionId, targetSessionId }
 *
 * Stops another session. The caller's npub must match the target's npub
 * (same-owner constraint). An agent cannot stop its own session.
 */
async function handleStopSession(
  deps: WingmanMcpApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const targetSessionId = body.targetSessionId as string | undefined;

  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  if (!targetSessionId) {
    return jsonError("targetSessionId is required", 400);
  }

  if (targetSessionId === sessionId) {
    return jsonError("Cannot stop your own session", 403);
  }

  const callerSession = deps.getSession(sessionId!);
  if (!callerSession) {
    return jsonError("Caller session not found", 404);
  }

  const targetSession = deps.getSession(targetSessionId);
  if (!targetSession) {
    return jsonError("Target session not found", 404);
  }

  // Same-owner check: caller's npub must match target's npub
  const callerNpub = resolveSessionOwnerNpub(callerSession.npub ?? null, callerSession.metadata);
  const targetNpub = resolveSessionOwnerNpub(targetSession.npub ?? null, targetSession.metadata);
  if (!callerNpub || !targetNpub || callerNpub !== targetNpub) {
    return jsonError("Cannot stop sessions belonging to another user", 403);
  }

  if (!isAgentManagedByMetadataOrOrigin(targetSession.metadata, targetSession.origin)) {
    return jsonError("Agents can only stop sessions with metadata.AGENT=true", 403);
  }

  console.log(
    `[wingman-mcp-api] Agent session ${sessionId} (${callerSession.name ?? "unnamed"}) ` +
    `stopping session ${targetSessionId} (${targetSession.name ?? "unnamed"})`,
  );

  const stopped = await deps.stopSession(targetSessionId);
  if (!stopped) {
    return jsonError("Failed to stop session", 500);
  }

  // Schedule archive like the normal DELETE endpoint does
  deps.scheduleArchive(targetSessionId);

  return jsonOk({
    id: stopped.id,
    agent: stopped.agent,
    name: stopped.name,
    status: stopped.status,
    stoppedBy: sessionId,
  });
}

/**
 * GET /api/mcp/wingman/caprover/apps?sessionId=...
 */
function handleListCaproverApps(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Response {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const apps = deps.caproverStore.listApps().map((app) => ({
    id: app.id,
    caproverName: app.caproverName,
    liveUrl: app.liveUrl ?? null,
    customDomain: app.customDomain ?? null,
    hasSsl: app.hasSsl ?? false,
    deployedVersion: app.deployedVersion ?? null,
    appId: app.appId ?? null,
    projectId: app.projectId ?? null,
  }));

  return jsonOk({ apps });
}

/**
 * POST /api/mcp/wingman/caprover/deploy
 * Body: { sessionId, appId, dockerImage?, gitHash? }
 *
 * When dockerImage is provided, deploys from that image.
 * When omitted, creates a tarball from the linked local app directory
 * and uploads it to CapRover for building.
 */
async function handleDeployCaproverApp(
  deps: WingmanMcpApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const appId = body.appId as string | undefined;
  const dockerImage = body.dockerImage as string | undefined;
  const gitHash = body.gitHash as string | undefined;
  const caproverTarget = body.caproverTarget ?? body.targetName;
  const enableHttps = body.enableHttps === true;

  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  if (!appId) {
    return jsonError("appId is required (CapRover app tracking ID)", 400);
  }

  const app = deps.caproverStore.getApp(appId);
  if (!app) {
    return jsonError("CapRover app not found", 404);
  }

  const targets = resolveCaproverTargets(deps, caproverTarget);
  if (!Array.isArray(targets)) {
    return targets;
  }

  // Docker image deployment
  if (dockerImage) {
    const results = [];
    for (const target of targets) {
      const deployment = deps.caproverStore.createDeployment({
        caproverAppId: appId,
        targetName: target.name,
        deployMethod: "docker_image",
        dockerImage,
        gitHash: gitHash ?? null,
      });

      try {
        await target.client.deployFromImage(app.caproverName, dockerImage);

        const remoteApp = await target.client.getApp(app.caproverName);
        const version = remoteApp?.deployedVersion ?? null;
        let httpsEnabled = false;
        let httpsError: string | null = null;

        if (enableHttps) {
          try {
            await target.client.enableSsl(app.caproverName);
            httpsEnabled = true;
          } catch (httpsFailure) {
            httpsError = (httpsFailure as Error).message;
          }
        }

        deps.caproverStore.updateDeployment(deployment.id, {
          status: "success",
          version,
          completedAt: new Date().toISOString(),
        });

        deps.caproverStore.updateApp(appId, {
          deployedVersion: version,
          ...(httpsEnabled ? { hasSsl: true } : {}),
        });
        results.push({ targetName: target.name, success: true, deployedVersion: version, httpsEnabled, httpsError, error: null });
      } catch (err) {
        const message = (err as Error).message;
        deps.caproverStore.updateDeployment(deployment.id, {
          status: "failed",
          completedAt: new Date().toISOString(),
          errorMessage: message,
        });
        results.push({ targetName: target.name, success: false, deployedVersion: null, httpsEnabled: false, httpsError: null, error: message });
      }
    }

    if (!results.some((result) => result.success)) {
      return jsonError(`Deployment failed: ${results.map((result) => `${result.targetName}: ${result.error}`).join("; ")}`, 502);
    }

    return jsonOk({
      success: true,
      appId,
      caproverName: app.caproverName,
      deployMethod: "docker_image",
      dockerImage,
      targets: results,
      deployedVersion: results.find((result) => result.success)?.deployedVersion ?? null,
    });
  }

  // Tarball deployment from linked local app
  if (!app.appId) {
    return jsonError(
      "No dockerImage provided and no local app linked. Either pass dockerImage or link a local app to this CapRover app.",
      400,
    );
  }

  const allApps = await deps.listApps();
  const localApp = allApps.find((a) => a.id === app.appId);
  if (!localApp) {
    return jsonError(`Linked local app ${app.appId} not found in app registry`, 404);
  }

  const appRoot = localApp.root;

  // Create tarball
  let tarResult;
  try {
    tarResult = await createAppTarball(appRoot);
  } catch (err) {
    return jsonError(`Failed to create tarball from ${appRoot}: ${(err as Error).message}`, 400);
  }

  const results = [];
  for (const target of targets) {
    const deployment = deps.caproverStore.createDeployment({
      caproverAppId: appId,
      targetName: target.name,
      deployMethod: "tar_upload",
      dockerImage: null,
      gitHash: gitHash ?? null,
    });

    try {
      await target.client.deployFromTarball(app.caproverName, tarResult.buffer, gitHash);

      const remoteApp = await target.client.getApp(app.caproverName);
      const version = remoteApp?.deployedVersion ?? null;
      let httpsEnabled = false;
      let httpsError: string | null = null;

      if (enableHttps) {
        try {
          await target.client.enableSsl(app.caproverName);
          httpsEnabled = true;
        } catch (httpsFailure) {
          httpsError = (httpsFailure as Error).message;
        }
      }

      deps.caproverStore.updateDeployment(deployment.id, {
        status: "success",
        version,
        completedAt: new Date().toISOString(),
      });

      deps.caproverStore.updateApp(appId, {
        deployedVersion: version,
        ...(httpsEnabled ? { hasSsl: true } : {}),
      });
      results.push({ targetName: target.name, success: true, deployedVersion: version, httpsEnabled, httpsError, error: null });
    } catch (err) {
      const message = (err as Error).message;
      deps.caproverStore.updateDeployment(deployment.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: message,
      });
      results.push({ targetName: target.name, success: false, deployedVersion: null, httpsEnabled: false, httpsError: null, error: message });
    }
  }

  if (!results.some((result) => result.success)) {
    return jsonError(`Tarball deployment failed: ${results.map((result) => `${result.targetName}: ${result.error}`).join("; ")}`, 502);
  }

  return jsonOk({
    success: true,
    appId,
    caproverName: app.caproverName,
    deployMethod: "tar_upload",
    fileCount: tarResult.fileCount,
    targets: results,
    deployedVersion: results.find((result) => result.success)?.deployedVersion ?? null,
  });
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * GET /api/mcp/wingman/skills?sessionId=...&app=...
 * List available skills, optionally filtered by app folder.
 */
async function handleListSkills(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const app = url.searchParams.get("app") ?? undefined;
  const skills = await listSkills(deps.userSkillsRoot, deps.defaultSkillsRoot, app);
  return jsonOk({ skills });
}

/**
 * GET /api/mcp/wingman/skills/load?sessionId=...&app=...&name=...
 * Load a specific skill's content.
 */
async function handleLoadSkill(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const app = url.searchParams.get("app");
  const name = url.searchParams.get("name");

  if (!app || !name) {
    return jsonError("app and name are required query parameters", 400);
  }

  const skill = await loadSkill(deps.userSkillsRoot, deps.defaultSkillsRoot, app, name);
  if (!skill) {
    return jsonError(`Skill not found: ${app}/${name}`, 404);
  }

  return jsonOk({ skill });
}

// ---------------------------------------------------------------------------
// Image Generation + Artifacts
// ---------------------------------------------------------------------------

/**
 * POST /api/mcp/wingman/generate-image
 * Body: { sessionId, prompt, filename?, model? }
 */
async function handleGenerateImage(
  deps: WingmanMcpApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const prompt = body.prompt as string | undefined;
  const filename = body.filename as string | undefined;
  const model = body.model as string | undefined;

  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  if (!prompt) {
    return jsonError("prompt is required", 400);
  }

  const session = deps.getSession(sessionId!);
  if (!session) {
    return jsonError("Session not found", 404);
  }

  // Resolve API key: per-user setting > env var
  let apiKey: string | null = null;
  if (session.npub) {
    apiKey = deps.userSettingsStore.get(session.npub, "openrouter_api_key");
  }
  if (!apiKey) {
    apiKey = deps.openRouterApiKey;
  }
  if (!apiKey) {
    return jsonError(
      "No OpenRouter API key configured. Set one in Settings or set the OPENROUTER_API environment variable.",
      400,
    );
  }

  const directory = session.workingDirectory;
  if (!directory) {
    return jsonError("Session has no working directory", 400);
  }

  const result = await generateAndSaveImages(prompt, directory, apiKey, {
    model,
    filename,
  });

  // Register artifacts
  const artifacts = result.images.map((img) =>
    deps.artifactsStore.add({
      sessionId: sessionId!,
      type: "image",
      label: filename || prompt.slice(0, 60),
      filePath: img.path,
      mimeType: img.mimeType,
    }),
  );

  return jsonOk({
    content: result.content,
    images: result.images,
    artifacts: artifacts.map((a) => ({
      id: a.id,
      type: a.type,
      label: a.label,
      filePath: a.filePath,
      mimeType: a.mimeType,
    })),
  });
}

/**
 * GET /api/mcp/wingman/artifacts?sessionId=...
 * List artifacts for a session (called by MCP tool).
 */
function handleListArtifacts(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Response {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const artifacts = deps.artifactsStore.listBySession(sessionId!);
  return jsonOk({ artifacts });
}

/**
 * POST /api/mcp/wingman/artifacts
 * Body: { sessionId, type, label, filePath, url?, mimeType? }
 * Register a new artifact (for agents to register non-image artifacts).
 */
async function handleRegisterArtifact(
  deps: WingmanMcpApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const type = body.type as string | undefined;
  const label = body.label as string | undefined;
  const filePath = body.filePath as string | undefined;
  const url = body.url as string | undefined;
  const mimeType = body.mimeType as string | undefined;

  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  if (!type || !label || !filePath) {
    return jsonError("type, label, and filePath are required", 400);
  }

  const validTypes = ["image", "document", "webview", "file"];
  if (!validTypes.includes(type)) {
    return jsonError(`type must be one of: ${validTypes.join(", ")}`, 400);
  }

  const artifact = deps.artifactsStore.add({
    sessionId: sessionId!,
    type: type as "image" | "document" | "webview" | "file",
    label,
    filePath,
    url,
    mimeType,
  });

  return jsonOk({ artifact });
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/**
 * GET /api/mcp/wingman/project?sessionId=...
 * Returns the project details for the calling session's working directory.
 */
function handleGetProject(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Response {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const session = deps.getSession(sessionId!);
  if (!session) {
    return jsonError("Session not found", 404);
  }

  const directory = session.workingDirectory;
  if (!directory) {
    return jsonError("Session has no working directory", 400);
  }

  const project = deps.findProjectByDirectory(directory);
  if (!project) {
    return jsonOk({ project: null, directory });
  }

  return jsonOk({
    project: {
      id: project.id,
      name: project.name,
      directoryPath: project.directoryPath,
      taskBoardUrl: project.taskBoardUrl,
      appId: project.appId,
      worktreeName: project.worktreeName,
      sessionCount: project.sessionCount,
      lastUsedAt: project.lastUsedAt,
    },
    directory,
  });
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * GET /api/mcp/wingman/memory?sessionId=...&query=...&tags=...&project=...&limit=...
 * Search memories. Falls back to listing recent memories for the user.
 */
function handleSearchMemory(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Response {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const session = deps.getSession(sessionId!);
  if (!session) {
    return jsonError("Session not found", 404);
  }

  const query = url.searchParams.get("query") ?? undefined;
  const tags = url.searchParams.get("tags") ?? undefined;
  const project = url.searchParams.get("project") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;

  const wingmanNpub = deps.getWingmanNpub() ?? undefined;
  const userNpub = session.npub ?? undefined;

  // If no specific filters, list recent memories for the user
  const hasFilters = query || tags || project;
  if (!hasFilters && userNpub) {
    const memories = deps.memoryStore.listMemories(userNpub, wingmanNpub, limit);
    return jsonOk({ memories });
  }

  const memories = deps.memoryStore.searchMemories({
    query,
    tags,
    project,
    userNpub,
    wingmanNpub,
    limit,
  });

  return jsonOk({ memories });
}

/**
 * POST /api/mcp/wingman/memory
 * Body: { sessionId, content, tags? }
 * Auto-populates wingman_npub, user_npub, project, working_dir, project_metadata.
 */
async function handleSaveMemory(
  deps: WingmanMcpApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const content = body.content as string | undefined;
  const tags = body.tags as string | undefined;

  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  if (!content) {
    return jsonError("content is required", 400);
  }

  const session = deps.getSession(sessionId!);
  if (!session) {
    return jsonError("Session not found", 404);
  }

  const wingmanNpub = deps.getWingmanNpub();
  if (!wingmanNpub) {
    return jsonError("Wingman identity not configured (set WINGMAN_PRIV)", 500);
  }

  const userNpub = session.npub;
  if (!userNpub) {
    return jsonError("Session has no user npub", 400);
  }

  // Auto-populate project context
  const directory = session.workingDirectory;
  let projectName: string | null = null;
  let projectMetadata: Record<string, unknown> | null = null;

  if (directory) {
    const project = deps.findProjectByDirectory(directory);
    if (project) {
      projectName = project.name;
      projectMetadata = {
        id: project.id,
        appId: project.appId ?? null,
        taskBoardUrl: project.taskBoardUrl ?? null,
        worktreeName: project.worktreeName ?? null,
      };
    }
  }

  const memory = deps.memoryStore.saveMemory({
    wingmanNpub,
    userNpub,
    project: projectName,
    workingDir: directory ?? null,
    projectMetadata,
    tags: tags ?? null,
    content,
  });

  return jsonOk({ memory });
}

/**
 * DELETE /api/mcp/wingman/memory?sessionId=...&id=...
 * Delete a memory by ID.
 */
function handleDeleteMemory(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Response {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const memoryId = url.searchParams.get("id");
  if (!memoryId) {
    return jsonError("id is required", 400);
  }

  const deleted = deps.memoryStore.deleteMemory(memoryId);
  return jsonOk({ deleted });
}

// ---------------------------------------------------------------------------
// Flight Deck helpers
// ---------------------------------------------------------------------------

interface FlightDeckMcpContext {
  session: SessionSnapshot;
  runId: string | null;
  run: { input: JsonObject; current: JsonObject } | null;
  root: JsonObject;
  workspace: JsonObject;
  chat: JsonObject;
  routing: JsonObject;
  record: JsonObject;
  runtime: JsonObject;
  botIdentity: RuntimeBotIdentity | null;
  backendBaseUrl: string | null;
  workspaceId: string | null;
  appNpub: string | null;
  subscriptionId: string | null;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveFlightDeckRunId(session: SessionSnapshot): string | null {
  const metadata = session.metadata ?? { AGENT: false, billingMode: "subscription" };
  return asString(metadata.flowRunId) ?? (
    metadata.bindingType === "flow_run" ? asString(metadata.bindingId) : null
  );
}

function resolveFlightDeckMcpContext(
  deps: WingmanMcpApiDependencies,
  sessionId: string,
): FlightDeckMcpContext | Response {
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;
  const session = deps.getSession(sessionId);
  if (!session) return jsonError("Caller session not found", 404);
  const runId = resolveFlightDeckRunId(session);
  const run = runId && deps.pipelineStore ? deps.pipelineStore.getRun(runId) : null;
  const binding = deps.documentDirectStore?.getBySession(sessionId) ?? null;
  const metadata = session.metadata ?? { AGENT: false, billingMode: 'subscription' };
  const towerServiceNpub = asString(metadata.flightdeckTowerServiceNpub);
  const directWorkspaceId = asString(metadata.flightdeckWorkspaceId);
  const directAgentNpub = asString(metadata.flightdeckAgentNpub) ?? asString(metadata.agentChatBotNpub);
  const resolvedDirect = towerServiceNpub && directWorkspaceId && directAgentNpub
    ? deps.resolveFlightDeckDirectContext?.({ towerServiceNpub, workspaceId: directWorkspaceId, agentNpub: directAgentNpub }) ?? null
    : null;
  const directRoot = resolvedDirect ? {
    workspace: {
      subscriptionId: resolvedDirect.subscriptionId,
      workspaceId: directWorkspaceId,
      backendBaseUrl: resolvedDirect.backendBaseUrl,
      sourceAppNpub: resolvedDirect.appNpub,
    },
    chat: {
      channelId: asString(metadata.flightdeckChannelId),
      threadId: asString(metadata.flightdeckThreadId),
    },
    routing: {
      bindingType: 'thread',
      bindingId: asString(metadata.flightdeckThreadId),
      routingKey: asString(metadata.flightdeckRoutingKey),
      channelId: asString(metadata.flightdeckChannelId),
      threadId: asString(metadata.flightdeckThreadId),
    },
    record: { recordFamily: 'chat_thread', recordId: asString(metadata.flightdeckThreadId) },
    runtime: { mode: 'direct_chat' },
    agent: { botNpub: directAgentNpub, agentId: asString(metadata.agentChatAgentId) },
  } : null;
  const root = asObject(run?.current ?? run?.input ?? (binding ? {
    workspace: {
      subscriptionId: binding.subscriptionId,
      workspaceId: binding.workspaceId,
    },
    routing: {
      bindingType: 'document',
      bindingId: binding.documentId,
      routingKey: binding.routingKey,
    },
    record: { recordFamily: 'document', recordId: binding.documentId },
    runtime: { mode: 'document_direct' },
  } : directRoot ?? {}));
  const workspace = asObject(root.workspace);
  const subscriptionId = asString(workspace.subscriptionId);
  const directContext = subscriptionId ? deps.getFlightDeckRuntimeContext?.(subscriptionId) ?? null : null;
  const botIdentity = resolvedDirect?.botIdentity ?? directContext?.botIdentity ?? (subscriptionId && deps.getBotIdentityForSubscription
    ? deps.getBotIdentityForSubscription(subscriptionId)
    : null);

  return {
    session,
    runId,
    run: run ? { input: run.input, current: run.current } : null,
    root,
    workspace,
    chat: asObject(root.chat),
    routing: asObject(root.routing),
    record: asObject(root.record),
    runtime: asObject(root.runtime),
    botIdentity,
    backendBaseUrl: asString(workspace.backendBaseUrl) ?? directContext?.backendBaseUrl ?? null,
    workspaceId: asString(workspace.workspaceId) ?? directContext?.workspaceId ?? null,
    appNpub: asString(workspace.sourceAppNpub) ?? directContext?.appNpub ?? null,
    subscriptionId,
  };
}

function requireFlightDeckPgContext(ctx: FlightDeckMcpContext): Response | null {
  if (!ctx.run && !['document_direct', 'direct_chat'].includes(asString(ctx.runtime.mode) ?? '')) {
    return jsonError("No pipeline run, document binding, or Agent Direct context found for this session", 400);
  }
  if (!ctx.workspaceId) return jsonError("Flight Deck PG workspace id is missing from pipeline context", 400);
  if (!ctx.backendBaseUrl) return jsonError("Flight Deck backend URL is missing from pipeline context", 400);
  if (!ctx.appNpub) return jsonError("Flight Deck app npub is missing from pipeline context", 400);
  if (!ctx.botIdentity) return jsonError("No runtime bot identity is available for this Flight Deck subscription", 400);
  return null;
}

function resolveChannelId(ctx: FlightDeckMcpContext, body: JsonObject): string | null {
  return asString(body.channelId)
    ?? asString(body.channel_id)
    ?? asString(ctx.chat.channelId)
    ?? asString(ctx.routing.channelId)
    ?? asString(asObject(ctx.record.payload).channel_id);
}

function resolveThreadId(ctx: FlightDeckMcpContext, body: JsonObject): string | null {
  return asString(body.threadId)
    ?? asString(body.thread_id)
    ?? asString(ctx.chat.threadId)
    ?? asString(ctx.routing.threadId)
    ?? asString(asObject(ctx.record.payload).thread_id);
}

function resolveTaskId(ctx: FlightDeckMcpContext, body: JsonObject): string | null {
  const routingBindingType = asString(ctx.routing.bindingType);
  return asString(body.taskId)
    ?? asString(body.task_id)
    ?? (routingBindingType === "task" ? asString(ctx.routing.bindingId) : null)
    ?? asString(asObject(ctx.root.createdTask).taskId)
    ?? asString(asObject(ctx.root.createdTask).id)
    ?? asString(ctx.record.recordId);
}

function resolveDocumentId(ctx: FlightDeckMcpContext, body: JsonObject): string | null {
  const routingBindingType = asString(ctx.routing.bindingType);
  return asString(body.documentId)
    ?? asString(body.document_id)
    ?? asString(asObject(ctx.root.discussionDocument).documentId)
    ?? asString(asObject(ctx.root.ensuredDocument).documentId)
    ?? (routingBindingType === "document" ? asString(ctx.routing.bindingId) : null)
    ?? (asString(ctx.record.recordFamily) === "document" ? asString(ctx.record.recordId) : null);
}

async function handleFlightDeckHelper(
  deps: WingmanMcpApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = asString(body.sessionId);
  if (!sessionId) return jsonError("sessionId is required", 400);
  const action = asString(body.action);
  if (!action) return jsonError("action is required", 400);
  const resolved = resolveFlightDeckMcpContext(deps, sessionId);
  if (resolved instanceof Response) return resolved;

  if (action === "context") {
    return jsonOk({
      ok: true,
      mode: asString(resolved.runtime.mode),
      runId: resolved.runId,
      hasRunContext: Boolean(resolved.run),
      workspace: {
        workspaceId: resolved.workspaceId,
        backendBaseUrl: resolved.backendBaseUrl,
        sourceAppNpub: resolved.appNpub,
        workspaceOwnerNpub: asString(resolved.workspace.workspaceOwnerNpub),
        humanWorkspaceOwnerNpub: asString(resolved.workspace.humanWorkspaceOwnerNpub),
        workspaceServiceNpub: asString(resolved.workspace.workspaceServiceNpub),
        subscriptionId: resolved.subscriptionId,
      },
      chat: {
        channelId: resolveChannelId(resolved, body),
        threadId: resolveThreadId(resolved, body),
        messageText: asString(resolved.chat.messageText),
      },
      routing: resolved.routing,
      record: {
        recordId: asString(resolved.record.recordId),
        recordFamily: asString(resolved.record.recordFamily),
      },
      bot: {
        npub: resolved.botIdentity?.botNpub ?? asString(asObject(resolved.root.agent).botNpub),
        available: Boolean(resolved.botIdentity),
      },
    });
  }

  const missing = requireFlightDeckPgContext(resolved);
  if (missing) return missing;
  const pg = {
    backendBaseUrl: resolved.backendBaseUrl!,
    workspaceId: resolved.workspaceId!,
    appNpub: resolved.appNpub!,
    botIdentity: resolved.botIdentity!,
  };

  if (action === "doc_create") {
    const channelId = resolveChannelId(resolved, body);
    const title = asString(body.title);
    const docBody = asString(body.body) ?? "";
    if (!channelId) return jsonError("channelId is required", 400);
    if (!title) return jsonError("title is required", 400);
    const result = await createFlightDeckPgChannelDocument({
      ...pg,
      channelId,
      title,
      body: docBody,
      summary: asString(body.summary),
      metadata: {
        autopilot_mcp_helper: true,
        source_session_id: sessionId,
        source_pipeline_run_id: resolved.runId,
        source_record_id: asString(resolved.record.recordId),
        ...asObject(body.metadata),
      },
    });
    return jsonOk({ ok: true, result });
  }

  if (action === "doc_get") {
    const documentId = resolveDocumentId(resolved, body);
    if (!documentId) return jsonError("documentId is required", 400);
    const result = await fetchFlightDeckPgDocument({
      ...pg,
      documentId,
      includeBody: body.includeBody !== false && body.include_body !== false,
    });
    return jsonOk({
      ok: true,
      ...result,
      body_text: decodeFlightDeckPgDocumentBody(result),
    });
  }

  if (action === "doc_update") {
    const documentId = resolveDocumentId(resolved, body);
    const docBody = asString(body.body);
    if (!documentId) return jsonError("documentId is required", 400);
    if (!docBody && !asString(body.title) && body.metadata === undefined && body.summary === undefined) {
      return jsonError("body, title, summary, or metadata is required", 400);
    }
    try {
      const current = await fetchFlightDeckPgDocument({ ...pg, documentId });
      const rowVersion = Number(asObject(current.doc).row_version);
      if (!Number.isFinite(rowVersion) || rowVersion <= 0) {
        const error = `Document ${documentId} did not include a valid row_version`;
        deps.documentDirectStore?.recordCallback({ sessionId, kind: 'document_update', documentId, state: 'failed', error });
        return jsonError(error, 409);
      }
      const lease = await acquireFlightDeckPgEditLease({
        ...pg,
        entityType: "document",
        entityId: documentId,
        ttlSeconds: 120,
      });
      const leaseToken = asString(asObject(lease.lease).lease_token);
      if (!leaseToken) {
        const error = `Document ${documentId} edit lease did not include a token`;
        deps.documentDirectStore?.recordCallback({ sessionId, kind: 'document_update', documentId, state: 'failed', error });
        return jsonError(error, 409);
      }
      const result = await updateFlightDeckPgDocument({
        ...pg,
        documentId,
        title: asString(body.title),
        body: docBody,
        summary: body.summary === undefined ? undefined : asString(body.summary),
        metadata: body.metadata === undefined ? undefined : asObject(body.metadata),
        rowVersion,
        leaseToken,
      });
      deps.documentDirectStore?.recordCallback({ sessionId, kind: 'document_update', documentId, state: 'succeeded' });
      return jsonOk({ ok: true, result });
    } catch (error) {
      deps.documentDirectStore?.recordCallback({ sessionId, kind: 'document_update', documentId, state: 'failed', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  if (action === "doc_comments") {
    const documentId = resolveDocumentId(resolved, body);
    if (!documentId) return jsonError("documentId is required", 400);
    const result = await fetchFlightDeckPgDocumentComments({
      ...pg,
      documentId,
      limit: Number(body.limit) > 0 ? Number(body.limit) : 200,
    });
    return jsonOk({ ok: true, ...result });
  }

  if (action === "daily_scope_get") {
    const noteDate = asString(body.noteDate) ?? asString(body.note_date) ?? new Date().toISOString().slice(0, 10);
    const result = await fetchFlightDeckPgDailyScope({
      ...pg,
      ownerActorId: asString(body.ownerActorId) ?? asString(body.owner_actor_id),
      ownerNpub: asString(body.ownerNpub) ?? asString(body.owner_npub) ?? asString(resolved.workspace.humanWorkspaceOwnerNpub),
      noteDate,
      limit: Number(body.limit) > 0 ? Number(body.limit) : 5,
    });
    return jsonOk({ ok: true, noteDate, ...result, daily_note: result.daily_notes[0] ?? null });
  }

  if (action === "daily_scope_upsert") {
    const noteDate = asString(body.noteDate) ?? asString(body.note_date) ?? new Date().toISOString().slice(0, 10);
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const items = rawItems.slice(0, 5).map((item, index) => {
      const row: Record<string, unknown> = typeof item === "object" && item !== null
        ? item as Record<string, unknown>
        : { text: item };
      return {
        id: asString(row.id) ?? `item-${index + 1}`,
        text: asString(row.text) ?? asString(row.label) ?? "",
        completed: Boolean(row.completed),
        source: asString(row.source) ?? "agent",
      };
    }).filter((item) => item.text);
    const result = await upsertFlightDeckPgDailyScope({
      ...pg,
      ownerActorId: asString(body.ownerActorId) ?? asString(body.owner_actor_id),
      ownerNpub: asString(body.ownerNpub) ?? asString(body.owner_npub) ?? asString(resolved.workspace.humanWorkspaceOwnerNpub),
      noteDate,
      title: asString(body.title) ?? "Daily Scope",
      body: asString(body.body) ?? asString(body.narrative) ?? "",
      focus: asString(body.focus),
      items,
      metadata: {
        source_session_id: sessionId,
        source_pipeline_run_id: resolved.runId,
        source_record_id: asString(resolved.record.recordId),
        ...asObject(body.metadata),
      },
    });
    return jsonOk({ ok: true, result });
  }

  if (action === "doc_reply") {
    const documentId = resolveDocumentId(resolved, body);
    const parentCommentId = asString(body.commentId) ?? asString(body.comment_id);
    const replyBody = asString(body.body);
    if (!documentId) return jsonError("documentId is required", 400);
    if (!parentCommentId) return jsonError("commentId is required", 400);
    if (!replyBody) return jsonError("body is required", 400);
    try {
      const result = await createFlightDeckPgDocumentComment({
        ...pg,
        documentId,
        parentCommentId,
        body: replyBody,
        metadata: {
          autopilot_mcp_helper: true,
          source_session_id: sessionId,
          source_pipeline_run_id: resolved.runId,
          source_record_id: asString(resolved.record.recordId),
          ...asObject(body.metadata),
        },
      });
      deps.documentDirectStore?.recordCallback({ sessionId, kind: 'document_comment_reply', documentId, commentId: parentCommentId, state: 'succeeded' });
      return jsonOk({ ok: true, result });
    } catch (error) {
      deps.documentDirectStore?.recordCallback({ sessionId, kind: 'document_comment_reply', documentId, commentId: parentCommentId, state: 'failed', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  if (action === "thread_read") {
    const channelId = resolveChannelId(resolved, body);
    if (!channelId) return jsonError("channelId is required", 400);
    const result = await fetchFlightDeckPgChannelMessages({
      ...pg,
      channelId,
      threadId: resolveThreadId(resolved, body),
      limit: Number(body.limit) > 0 ? Number(body.limit) : 200,
    });
    return jsonOk({ ok: true, ...result });
  }

  if (action === "chat_reply") {
    const channelId = resolveChannelId(resolved, body);
    const replyBody = asString(body.body);
    if (!channelId) return jsonError("channelId is required", 400);
    if (!replyBody) return jsonError("body is required", 400);
    const result = await createFlightDeckPgChannelMessage({
      ...pg,
      channelId,
      body: replyBody,
      threadId: resolveThreadId(resolved, body),
      createThread: body.createThread === true,
      metadata: {
        autopilot_mcp_helper: true,
        source_session_id: sessionId,
        source_pipeline_run_id: resolved.runId,
        source_record_id: asString(resolved.record.recordId),
        ...asObject(body.metadata),
      },
    });
    return jsonOk({ ok: true, result });
  }

  if (action === "task_comment") {
    const taskId = resolveTaskId(resolved, body);
    const commentBody = asString(body.body);
    if (!taskId) return jsonError("taskId is required", 400);
    if (!commentBody) return jsonError("body is required", 400);
    const result = await createFlightDeckPgTaskComment({
      ...pg,
      taskId,
      body: commentBody,
      threadId: resolveThreadId(resolved, body),
      metadata: {
        autopilot_mcp_helper: true,
        source_session_id: sessionId,
        source_pipeline_run_id: resolved.runId,
        source_record_id: asString(resolved.record.recordId),
        ...asObject(body.metadata),
      },
    });
    return jsonOk({ ok: true, result });
  }

  if (action === "task_comments") {
    const taskId = resolveTaskId(resolved, body);
    if (!taskId) return jsonError("taskId is required", 400);
    const result = await fetchFlightDeckPgTaskComments({
      ...pg,
      taskId,
      limit: Number(body.limit) > 0 ? Number(body.limit) : 200,
    });
    return jsonOk({ ok: true, ...result });
  }

  if (action === "task_state") {
    const taskId = resolveTaskId(resolved, body);
    const state = asString(body.state);
    if (!taskId) return jsonError("taskId is required", 400);
    if (!state) return jsonError("state is required", 400);
    const taskResult = await fetchFlightDeckPgTask({ ...pg, taskId });
    const rowVersion = Number(asObject(taskResult.task).row_version);
    if (!Number.isFinite(rowVersion) || rowVersion <= 0) {
      return jsonError(`Task ${taskId} did not include a valid row_version`, 409);
    }
    const lease = await acquireFlightDeckPgEditLease({
      ...pg,
      entityType: "task",
      entityId: taskId,
      ttlSeconds: 120,
    });
    const leaseToken = asString(asObject(lease.lease).lease_token);
    if (!leaseToken) return jsonError(`Task ${taskId} edit lease did not include a token`, 409);
    const result = await updateFlightDeckPgTaskState({
      ...pg,
      taskId,
      state,
      rowVersion,
      leaseToken,
    });
    return jsonOk({ ok: true, result });
  }

  return jsonError(`Unsupported Flight Deck helper action: ${action}`, 400);
}

// ---------------------------------------------------------------------------
// Artifact pinning
// ---------------------------------------------------------------------------

/**
 * POST /api/mcp/wingman/artifact/pin
 * Body: { sessionId, filePath }
 * Pin a file as the active artifact in the UI panel.
 */
async function handlePinArtifact(
  deps: WingmanMcpApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const removeFilePath = typeof body.removeFilePath === "string" ? body.removeFilePath : null;
  const filePath = typeof body.filePath === "string" ? body.filePath : null;
  const pinnedFilePaths = Array.isArray(body.pinnedFiles)
    ? body.pinnedFiles.filter((value): value is string => typeof value === "string")
    : null;
  const activeFilePath = typeof body.activeFilePath === "string" ? body.activeFilePath : null;
  const updatedSession = pinnedFilePaths
    ? deps.setPinnedFiles(sessionId!, pinnedFilePaths, activeFilePath)
    : removeFilePath
      ? deps.removePinnedFile(sessionId!, removeFilePath)
      : deps.setPinnedFile(sessionId!, filePath);
  const pinnedFiles = Array.isArray(updatedSession?.metadata?.pinnedFiles)
    ? updatedSession.metadata.pinnedFiles
    : filePath
      ? [filePath]
      : [];

  return jsonOk({ pinnedFile: updatedSession?.pinnedFile ?? filePath, pinnedFiles });
}

/**
 * GET /api/mcp/wingman/artifact/pin?sessionId=...
 * Returns the currently pinned file for a session.
 */
function handleGetPinnedArtifact(
  deps: WingmanMcpApiDependencies,
  url: URL,
): Response {
  const sessionId = url.searchParams.get("sessionId");
  const denied = requireSessionId(deps, sessionId);
  if (denied) return denied;

  const session = deps.getSession(sessionId!);
  return jsonOk({
    pinnedFile: session?.pinnedFile ?? null,
    pinnedFiles: Array.isArray(session?.metadata?.pinnedFiles) ? session.metadata.pinnedFiles : [],
  });
}
