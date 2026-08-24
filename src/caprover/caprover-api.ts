/**
 * CapRover API Handler
 *
 * HTTP handler for /api/caprover/* routes.
 * Manages CapRover app tracking, deployments, and configuration.
 */

import type { RequestAuthContext } from "../auth/request-context";
import { normaliseNpub } from "../identity/npub-utils";
import { CaproverClient, CaproverClientError } from "./caprover-client";
import type { CaproverTargetClient } from "./caprover-client";
import type { CaproverStore } from "./caprover-store";
import type {
  CaptainDefinition,
  CaproverAppRecord,
  CaproverAppDefinition,
  CaproverDeploymentRecord,
  DeployMethod,
} from "./types";

// ============================================================
// Types
// ============================================================

export interface CaproverApiDependencies {
  store: CaproverStore;
  getClient: () => CaproverClient | null;
  getTargets?: () => CaproverTargetClient[];
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ============================================================
// Helpers
// ============================================================

const parseRequestBody = async (request: Request): Promise<Record<string, unknown>> => {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${(error as Error).message}`);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid JSON payload");
  }
  return payload as Record<string, unknown>;
};

const normaliseOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const validateCaproverName = (name: unknown): string => {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("caproverName is required");
  }
  const normalized = name.trim().toLowerCase();
  // CapRover app names: lowercase alphanumeric with hyphens, must start with letter
  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
    throw new Error("caproverName must be lowercase, start with a letter, and contain only letters, numbers, and hyphens");
  }
  if (normalized.length > 50) {
    throw new Error("caproverName must be 50 characters or less");
  }
  return normalized;
};

const ensureClient = (deps: CaproverApiDependencies): CaproverClient => {
  const client = deps.getClient();
  if (!client) {
    throw new Error("CapRover is not configured. Set CAPROVER_URL and LOGIN_CODE environment variables.");
  }
  return client;
};

const resolveTargetClient = (
  deps: CaproverApiDependencies,
  requestedTarget: string | null,
): CaproverTargetClient | { error: string; status: number } => {
  const targets = deps.getTargets?.() ?? [];
  if (targets.length > 0) {
    const normalized = requestedTarget?.trim().toLowerCase() || targets[0]?.name || "primary";
    const target = targets.find((candidate) => candidate.name === normalized);
    if (!target) {
      return { error: `Unknown CapRover target: ${normalized}`, status: 400 };
    }
    return target;
  }

  const client = deps.getClient();
  if (!client) {
    return {
      error: "CapRover is not configured. Set CAPROVER_URL and LOGIN_CODE environment variables.",
      status: 503,
    };
  }

  return {
    name: "primary",
    serverUrl: "",
    client,
  };
};

const buildWebhookUrl = (target: CaproverTargetClient, app: CaproverAppDefinition): string | null => {
  const token = app.appPushWebhook?.pushWebhookToken;
  if (!token || !target.serverUrl) return null;
  return `${target.serverUrl.replace(/\/+$/, "")}/api/v2/user/apps/webhooks/triggerbuild?namespace=captain&token=${encodeURIComponent(token)}`;
};

const serializeRemoteApp = (app: CaproverAppDefinition, target: CaproverTargetClient) => ({
  appName: app.appName,
  hasPersistentData: app.hasPersistentData,
  hasDefaultSubDomainSsl: app.hasDefaultSubDomainSsl,
  containerHttpPort: app.containerHttpPort,
  notExposeAsWebApp: app.notExposeAsWebApp,
  instanceCount: app.instanceCount,
  captainDefinitionRelativeFilePath: app.captainDefinitionRelativeFilePath,
  envVars: app.envVars ?? [],
  volumes: app.volumes ?? [],
  ports: app.ports ?? [],
  customDomain: app.customDomain ?? [],
  isAppBuilding: app.isAppBuilding ?? false,
  deployedVersion: app.deployedVersion ?? null,
  gitDeploy: app.appPushWebhook
    ? {
        repo: app.appPushWebhook.repoInfo?.repo ?? "",
        branch: app.appPushWebhook.repoInfo?.branch ?? "",
        user: app.appPushWebhook.repoInfo?.user ?? "",
        hasPassword: Boolean(app.appPushWebhook.repoInfo?.password),
        hasSshKey: Boolean(app.appPushWebhook.repoInfo?.sshKey),
        hasWebhook: Boolean(app.appPushWebhook.pushWebhookToken),
        webhookUrl: buildWebhookUrl(target, app),
      }
    : null,
});

const serializeApp = (app: CaproverAppRecord) => ({
  id: app.id,
  appId: app.appId,
  projectId: app.projectId,
  caproverName: app.caproverName,
  liveUrl: app.liveUrl,
  customDomain: app.customDomain,
  hasSsl: app.hasSsl,
  deployedVersion: app.deployedVersion,
  notes: app.notes,
  createdAt: app.createdAt,
  updatedAt: app.updatedAt,
});

const serializeDeployment = (deployment: CaproverDeploymentRecord) => ({
  id: deployment.id,
  caproverAppId: deployment.caproverAppId,
  targetName: deployment.targetName,
  version: deployment.version,
  status: deployment.status,
  deployMethod: deployment.deployMethod,
  dockerImage: deployment.dockerImage,
  gitHash: deployment.gitHash,
  startedAt: deployment.startedAt,
  completedAt: deployment.completedAt,
  errorMessage: deployment.errorMessage,
});

const serializeTarget = (target: CaproverTargetClient) => ({
  name: target.name,
  serverUrl: target.serverUrl,
});

// ============================================================
// Route Handlers
// ============================================================

/**
 * GET /api/caprover/apps - List tracked apps
 * POST /api/caprover/apps - Create/track a new app
 */
const handleAppsCollection = async (
  deps: CaproverApiDependencies,
  method: HttpMethod,
  request: Request,
): Promise<Response> => {
  if (method === "GET") {
    const apps = deps.store.listApps();
    return Response.json({ apps: apps.map(serializeApp) });
  }

  if (method === "POST") {
    try {
      const body = await parseRequestBody(request);
      const caproverName = validateCaproverName(body.caproverName);
      const appId = normaliseOptionalString(body.appId);
      const projectId = normaliseOptionalString(body.projectId);
      const notes = normaliseOptionalString(body.notes);
      const hasPersistentData = body.hasPersistentData === true;
      const createOnCaprover = body.createOnCaprover !== false; // Default to true

      // Check if already tracked
      const existing = deps.store.getAppByCaproverName(caproverName);
      if (existing) {
        return Response.json({ error: `App "${caproverName}" is already tracked` }, { status: 409 });
      }

      let liveUrl: string | null = null;

      // Create on CapRover if requested
      if (createOnCaprover) {
        const client = ensureClient(deps);

        // Check if already exists on CapRover
        const remoteApp = await client.getApp(caproverName);
        if (remoteApp) {
          // App exists, get its URL
          liveUrl = await client.getAppUrl(caproverName);
        } else {
          // Create new app on CapRover
          await client.createApp(caproverName, hasPersistentData);
          liveUrl = await client.getAppUrl(caproverName);
        }
      }

      // Track in local store
      const created = deps.store.createApp({
        caproverName,
        appId,
        projectId,
        notes,
        liveUrl,
      });

      return Response.json({ app: serializeApp(created) }, { status: 201 });
    } catch (error) {
      if (error instanceof CaproverClientError) {
        return Response.json({ error: error.message }, { status: 502 });
      }
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
};

/**
 * GET /api/caprover/apps/:id - Get app details
 * PATCH /api/caprover/apps/:id - Update app tracking info
 * DELETE /api/caprover/apps/:id - Stop tracking (optionally delete from CapRover)
 */
const handleAppItem = async (
  deps: CaproverApiDependencies,
  method: HttpMethod,
  appId: string,
  request: Request,
): Promise<Response> => {
  const app = deps.store.getApp(appId);
  if (!app) {
    return Response.json({ error: "App not found" }, { status: 404 });
  }

  if (method === "GET") {
    // Optionally fetch fresh data from CapRover
    try {
      const client = deps.getClient();
      if (client) {
        const remoteApp = await client.getApp(app.caproverName);
        if (remoteApp) {
          const liveUrl = await client.getAppUrl(app.caproverName);
          // Update local record with latest info
          const updated = deps.store.updateApp(appId, {
            liveUrl,
            deployedVersion: remoteApp.deployedVersion ?? null,
            hasSsl: remoteApp.hasDefaultSubDomainSsl,
            customDomain: remoteApp.customDomain?.[0]?.publicDomain ?? null,
          });
          return Response.json({ app: serializeApp(updated), remote: remoteApp });
        }
      }
    } catch {
      // Ignore remote errors, return local data
    }
    return Response.json({ app: serializeApp(app) });
  }

  if (method === "PATCH") {
    try {
      const body = await parseRequestBody(request);
      const updated = deps.store.updateApp(appId, {
        appId: body.appId !== undefined ? normaliseOptionalString(body.appId) : undefined,
        projectId: body.projectId !== undefined ? normaliseOptionalString(body.projectId) : undefined,
        notes: body.notes !== undefined ? normaliseOptionalString(body.notes) : undefined,
        customDomain: body.customDomain !== undefined ? normaliseOptionalString(body.customDomain) : undefined,
      });
      return Response.json({ app: serializeApp(updated) });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (method === "DELETE") {
    try {
      const url = new URL(request.url);
      const deleteFromCaprover = url.searchParams.get("remote") === "true";

      if (deleteFromCaprover) {
        const client = ensureClient(deps);
        await client.deleteApp(app.caproverName);
      }

      deps.store.deleteApp(appId);
      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof CaproverClientError) {
        return Response.json({ error: error.message }, { status: 502 });
      }
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
};

/**
 * POST /api/caprover/apps/:id/deploy - Deploy the app
 */
const handleAppDeploy = async (
  deps: CaproverApiDependencies,
  appId: string,
  request: Request,
): Promise<Response> => {
  const app = deps.store.getApp(appId);
  if (!app) {
    return Response.json({ error: "App not found" }, { status: 404 });
  }

  try {
    const body = await parseRequestBody(request);
    const client = ensureClient(deps);

    let deployMethod: DeployMethod;
    let dockerImage: string | null = null;
    let gitHash: string | null = null;

    if (body.dockerImage) {
      // Deploy from Docker image
      dockerImage = String(body.dockerImage).trim();
      if (!dockerImage) {
        return Response.json({ error: "dockerImage cannot be empty" }, { status: 400 });
      }
      deployMethod = "docker_image";
    } else if (body.captainDefinition) {
      // Deploy from captain-definition
      deployMethod = "captain_definition";
      gitHash = normaliseOptionalString(body.gitHash);
    } else {
      return Response.json({ error: "Either dockerImage or captainDefinition is required" }, { status: 400 });
    }

    // Create deployment record
    const deployment = deps.store.createDeployment({
      caproverAppId: appId,
      deployMethod,
      dockerImage,
      gitHash,
    });

    try {
      // Execute deployment
      if (deployMethod === "docker_image" && dockerImage) {
        await client.deployFromImage(app.caproverName, dockerImage);
      } else if (deployMethod === "captain_definition" && body.captainDefinition) {
        const captainDef = body.captainDefinition as CaptainDefinition;
        await client.deployCaptainDefinition(app.caproverName, captainDef, gitHash ?? undefined);
      }

      // Get updated app info
      const remoteApp = await client.getApp(app.caproverName);
      const version = remoteApp?.deployedVersion ?? null;

      // Update deployment record
      deps.store.updateDeployment(deployment.id, {
        status: "success",
        version,
        completedAt: new Date().toISOString(),
      });

      // Update app record
      const updatedApp = deps.store.updateApp(appId, {
        deployedVersion: version,
      });

      return Response.json({
        app: serializeApp(updatedApp),
        deployment: serializeDeployment(deps.store.getDeployment(deployment.id)!),
      });
    } catch (error) {
      // Update deployment as failed
      deps.store.updateDeployment(deployment.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: (error as Error).message,
      });
      throw error;
    }
  } catch (error) {
    if (error instanceof CaproverClientError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
};

/**
 * GET /api/caprover/apps/:id/logs - Get build logs
 */
const handleAppLogs = async (
  deps: CaproverApiDependencies,
  appId: string,
): Promise<Response> => {
  const app = deps.store.getApp(appId);
  if (!app) {
    return Response.json({ error: "App not found" }, { status: 404 });
  }

  try {
    const client = ensureClient(deps);
    const { logs, isAppBuilding } = await client.getBuildLogs(app.caproverName);
    return Response.json({ logs, isAppBuilding });
  } catch (error) {
    if (error instanceof CaproverClientError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
};

/**
 * POST /api/caprover/apps/:id/config - Update app configuration on CapRover
 */
const handleAppConfig = async (
  deps: CaproverApiDependencies,
  appId: string,
  request: Request,
): Promise<Response> => {
  const app = deps.store.getApp(appId);
  if (!app) {
    return Response.json({ error: "App not found" }, { status: 404 });
  }

  try {
    const body = await parseRequestBody(request);
    const client = ensureClient(deps);

    // Handle various config updates
    if (body.instanceCount !== undefined) {
      await client.updateAppConfig(app.caproverName, {
        instanceCount: Number(body.instanceCount),
      });
    }

    if (body.containerHttpPort !== undefined) {
      await client.updateAppConfig(app.caproverName, {
        containerHttpPort: Number(body.containerHttpPort),
      });
    }

    if (body.envVars !== undefined && Array.isArray(body.envVars)) {
      await client.updateAppConfig(app.caproverName, {
        envVars: body.envVars as { key: string; value: string }[],
      });
    }

    if (body.enableSsl === true) {
      await client.enableSsl(app.caproverName);
      deps.store.updateApp(appId, { hasSsl: true });
    }

    if (body.addCustomDomain) {
      const domain = String(body.addCustomDomain).trim();
      await client.addCustomDomain(app.caproverName, domain);
      deps.store.updateApp(appId, { customDomain: domain });
    }

    if (body.removeCustomDomain) {
      const domain = String(body.removeCustomDomain).trim();
      await client.removeCustomDomain(app.caproverName, domain);
      deps.store.updateApp(appId, { customDomain: null });
    }

    if (body.enableSslOnDomain) {
      const domain = String(body.enableSslOnDomain).trim();
      await client.enableSslOnDomain(app.caproverName, domain);
    }

    // Fetch updated app info
    const remoteApp = await client.getApp(app.caproverName);
    const updated = deps.store.updateApp(appId, {
      deployedVersion: remoteApp?.deployedVersion ?? null,
      hasSsl: remoteApp?.hasDefaultSubDomainSsl ?? false,
      customDomain: remoteApp?.customDomain?.[0]?.publicDomain ?? null,
    });

    return Response.json({ app: serializeApp(updated), remote: remoteApp });
  } catch (error) {
    if (error instanceof CaproverClientError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
};

/**
 * GET /api/caprover/deployments - List deployment history
 */
const handleDeployments = async (
  deps: CaproverApiDependencies,
  url: URL,
): Promise<Response> => {
  const appId = url.searchParams.get("appId");
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10)), 100) : 50;

  const deployments = deps.store.listDeployments(appId ?? undefined, limit);
  return Response.json({ deployments: deployments.map(serializeDeployment) });
};

/**
 * GET /api/caprover/remote/apps - List all apps from CapRover server
 */
const handleRemoteApps = async (deps: CaproverApiDependencies, url: URL): Promise<Response> => {
  try {
    const resolved = resolveTargetClient(deps, url.searchParams.get("target"));
    if ("error" in resolved) {
      return Response.json({ error: resolved.error }, { status: resolved.status });
    }
    const { apps, rootDomain } = await resolved.client.getAllApps();
    return Response.json({
      target: serializeTarget(resolved),
      apps: apps.map((app) => serializeRemoteApp(app, resolved)),
      rootDomain,
    });
  } catch (error) {
    if (error instanceof CaproverClientError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
};

/**
 * GET /api/caprover/targets - List configured CapRover targets
 */
const handleTargets = (deps: CaproverApiDependencies): Response => {
  const targets = deps.getTargets?.() ?? [];
  if (targets.length === 0) {
    const client = deps.getClient();
    return Response.json({
      targets: client ? [{ name: "primary", serverUrl: null }] : [],
    });
  }

  return Response.json({ targets: targets.map(serializeTarget) });
};

/**
 * GET /api/caprover/status - Check CapRover connection status
 */
const handleStatus = async (deps: CaproverApiDependencies): Promise<Response> => {
  const client = deps.getClient();
  if (!client) {
    return Response.json({
      configured: false,
      error: "CapRover not configured. Set CAPROVER_URL and LOGIN_CODE.",
    });
  }

  try {
    await client.authenticate();
    const { rootDomain } = await client.getAllApps();
    return Response.json({
      configured: true,
      connected: true,
      rootDomain,
    });
  } catch (error) {
    return Response.json({
      configured: true,
      connected: false,
      error: (error as Error).message,
    });
  }
};

// ============================================================
// Main Handler Factory
// ============================================================

export const createCaproverApiHandler = (dependencies: CaproverApiDependencies) => {
  const deps = dependencies;

  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
    _authContext: RequestAuthContext,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/caprover")) {
      return null;
    }

    // Parse route segments: /api/caprover/...
    const segments = url.pathname.split("/").filter(Boolean);
    // segments[0] = "api", segments[1] = "caprover"

    // /api/caprover/status
    if (segments.length === 3 && segments[2] === "status") {
      if (method === "GET") {
        return handleStatus(deps);
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/caprover/targets
    if (segments.length === 3 && segments[2] === "targets") {
      if (method === "GET") {
        return handleTargets(deps);
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/caprover/apps
    if (segments.length === 3 && segments[2] === "apps") {
      return handleAppsCollection(deps, method, request);
    }

    // /api/caprover/deployments
    if (segments.length === 3 && segments[2] === "deployments") {
      if (method === "GET") {
        return handleDeployments(deps, url);
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/caprover/remote/apps
    if (segments.length === 4 && segments[2] === "remote" && segments[3] === "apps") {
      if (method === "GET") {
        return handleRemoteApps(deps, url);
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/caprover/apps/:id
    if (segments.length === 4 && segments[2] === "apps") {
      const appId = segments[3]!;
      return handleAppItem(deps, method, appId, request);
    }

    // /api/caprover/apps/:id/deploy
    if (segments.length === 5 && segments[2] === "apps" && segments[4] === "deploy") {
      if (method === "POST") {
        const appId = segments[3]!;
        return handleAppDeploy(deps, appId, request);
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/caprover/apps/:id/logs
    if (segments.length === 5 && segments[2] === "apps" && segments[4] === "logs") {
      if (method === "GET") {
        const appId = segments[3]!;
        return handleAppLogs(deps, appId);
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // /api/caprover/apps/:id/config
    if (segments.length === 5 && segments[2] === "apps" && segments[4] === "config") {
      if (method === "POST") {
        const appId = segments[3]!;
        return handleAppConfig(deps, appId, request);
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  };
};
