import type { RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import type { WorkspaceScope } from "../workspaces/workspace-scope";
import type { AppLifecycleScripts, AppRecord } from "../apps/app-registry";
import { appCommand, migrateLegacyAppCommand } from "../apps/app-command";
import type { AppEnvironmentVariables } from "../apps/app-env";
import type { AppProcessStatus } from "../apps/app-process-manager";
import type { StarterProjectRecord } from "../storage/starter-project-store";
import type { RuntimeBotIdentity } from "../agent-chat/types";
import { TowerWappRegistrationError, type TowerWappRegistrar } from "../wapps/tower-registration";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

interface StarterProjectResponse {
  id: string;
  name: string;
  gitUrl: string;
  webApp: boolean;
  scriptAuto: boolean;
  notes: string | null;
  setupCommand: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StarterLaunchResult {
  root: string;
  label: string;
  scripts: Partial<AppLifecycleScripts>;
  github?: {
    owner: string;
    repo: string;
    cloneUrl: string;
    htmlUrl: string;
    defaultBranch: string;
    deployedBranchCreated: boolean;
    protection: {
      requested: boolean;
      main: "applied" | "skipped" | "failed";
      deployed: "applied" | "skipped" | "failed";
      warnings: string[];
    };
  };
}

export interface StarterProjectsApiContext {
  adminNpub: string | null;
  workspaceScope: WorkspaceScope;
  viewerNpub: string | null;

  AccessActions: {
    AppsManage: AccessAction;
  };

  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  normaliseOptionalString: (value: unknown) => string | null;
  normaliseNpub: (npub: string | null | undefined) => string | null;
  createRepositoryFromStarter: (
    scope: WorkspaceScope,
    options: {
      starterGitUrl: string;
      appName: string;
      directoryName: string;
      ownerNpub: string;
      githubOwner: string;
      githubRepo: string;
      privateRepo: boolean;
      protectBranches: boolean;
      createDeployedBranch: boolean;
    },
  ) => Promise<StarterLaunchResult>;
  buildAppResponse: (
    app: AppRecord,
    status: AppProcessStatus,
    options?: { ownerAlias?: string | null; subdomainAlias?: string | null },
  ) => Record<string, unknown>;
  towerUrl?: string | null;
  wingmanUrl?: string | null;
  towerWorkspaceOwnerNpub?: string | null;
  towerRegistrationIdentity?: RuntimeBotIdentity | null;
  towerWappRegistrar?: TowerWappRegistrar;

  appRegistry: {
    registerApp: (input: {
      label: string;
      root: string;
      scripts?: AppLifecycleScripts;
      notes?: string;
      ownerNpub?: string | null;
      env?: AppEnvironmentVariables;
      webApp?: boolean;
      webAppPort?: number | null;
    }) => Promise<AppRecord>;
    getApp: (id: string) => Promise<AppRecord | undefined>;
  };

  appProcessManager: {
    getStatus: (id: string) => Promise<AppProcessStatus>;
    setup: (id: string) => Promise<AppProcessStatus>;
    start: (id: string) => Promise<AppProcessStatus>;
  };

  appAliasRegistry: {
    getByAppId: (id: string) => Promise<{ alias: string } | undefined>;
  };

  starterProjectStore: {
    list: () => StarterProjectRecord[];
    getById: (id: string) => StarterProjectRecord | null;
    create: (input: {
      name: string;
      gitUrl: string;
      webApp?: boolean;
      scriptAuto?: boolean;
      notes?: string | null;
      setupCommand?: string | null;
      updatedBy?: string | null;
    }) => StarterProjectRecord;
    update: (
      id: string,
      updates: {
        name?: string;
        gitUrl?: string;
        webApp?: boolean;
        scriptAuto?: boolean;
        notes?: string | null;
        setupCommand?: string | null;
        updatedBy?: string | null;
      },
    ) => StarterProjectRecord;
    remove: (id: string) => boolean;
  };

  npubProjectStore: {
    getByPath: (ownerNpub: string, root: string) => { id: string } | null;
    setAppId: (projectId: string, appId: string) => void;
    createProject: (ownerNpub: string, root: string, label?: string) => { id: string } | null;
  };
}

function toStarterResponse(record: StarterProjectRecord): StarterProjectResponse {
  return {
    id: record.id,
    name: record.name,
    gitUrl: record.gitUrl,
    webApp: Boolean(record.webApp),
    scriptAuto: Boolean(record.scriptAuto),
    notes: record.notes ?? null,
    setupCommand: record.setupCommand ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toBoolean(input: unknown): boolean | undefined {
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return input !== 0;
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  }
  return undefined;
}

function slugifyDirectoryName(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const slug = trimmed
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!slug) {
    throw new Error("Name must include letters or numbers");
  }
  if (slug === "." || slug === "..") {
    throw new Error("Invalid folder name");
  }
  if (slug.includes("/")) {
    throw new Error("Folder name must be a single path segment");
  }
  return slug;
}

function isTowerBackedStarter(starter: StarterProjectRecord): boolean {
  return starter.id === "wapp-starter-tower-pg";
}

function buildStarterManagedEnv(
  starter: StarterProjectRecord,
  ownerNpub: string,
  workspaceOwnerNpub: string,
  towerUrl: string | null | undefined,
  wingmanUrl: string | null | undefined,
): AppEnvironmentVariables | undefined {
  const env: AppEnvironmentVariables = {};
  if (wingmanUrl?.trim()) {
    env.WINGMAN_URL = wingmanUrl.trim().replace(/\/$/, "");
  }
  if (!isTowerBackedStarter(starter)) {
    return Object.keys(env).length > 0 ? env : undefined;
  }
  Object.assign(env, {
    WAPP_ALLOWED_NPUBS_JSON: JSON.stringify([ownerNpub]),
    WAPP_OWNER_NPUB: ownerNpub,
    WAPP_WORKSPACE_OWNER_NPUB: workspaceOwnerNpub,
    WORKSPACE_OWNER_NPUB: workspaceOwnerNpub,
  });
  if (towerUrl?.trim()) {
    env.TOWER_URL = towerUrl.trim().replace(/\/$/, "");
  }
  return env;
}

async function registerTowerBackedStarterApp(
  ctx: StarterProjectsApiContext,
  starter: StarterProjectRecord,
  app: AppRecord,
  workspaceOwnerNpub: string,
  appName: string,
): Promise<void> {
  if (!isTowerBackedStarter(starter)) return;
  void ctx; void app; void workspaceOwnerNpub; void appName;
  throw new TowerWappRegistrationError("Tower-backed starters must be assigned through the WApp API so Autopilot can provision an installation-scoped signing broker identity", {
    status: 503, detailCode: "wapp_signing_broker_assignment_required",
  });
}

async function registerLaunchedStarterApp(
  ctx: StarterProjectsApiContext,
  ownerNpub: string,
  root: string,
  label: string,
  scripts: Partial<AppLifecycleScripts>,
  starter: StarterProjectRecord,
): Promise<{
  app: AppRecord;
  setupStatus: AppProcessStatus | null;
  startStatus: AppProcessStatus | null;
  startError: string | null;
}> {
  const scriptPayload: AppLifecycleScripts = {};
  const incoming = scripts ?? {};
  const keys: Array<keyof AppLifecycleScripts> = ["start", "stop", "restart", "setup", "build"];
  keys.forEach((key) => {
    const command = incoming[key];
    if (command) scriptPayload[key] = command;
  });
  if (starter.scriptAuto) {
    const setupCommand = ctx.normaliseOptionalString(starter.setupCommand);
    const reviewedSetup = setupCommand ? migrateLegacyAppCommand(setupCommand) : appCommand("bun", "run", "setup");
    if (!reviewedSetup) throw new Error("Starter setup command requires explicit Admin review as structured argv");
    scriptPayload.setup = reviewedSetup;
  }
  const towerWorkspaceOwnerNpub = ctx.towerWorkspaceOwnerNpub?.trim() || ownerNpub;

  if (isTowerBackedStarter(starter)) {
    throw new TowerWappRegistrationError(
      "Tower-backed starters require a non-exportable, installation-scoped NIP-98 signing broker capability; raw WAPP_NSEC app configuration is disabled",
      { status: 503, detailCode: "wapp_signing_broker_capability_missing" },
    );
  }

  const app = await ctx.appRegistry.registerApp({
    label,
    root,
    scripts: Object.keys(scriptPayload).length > 0 ? scriptPayload : undefined,
    notes: starter.notes ?? undefined,
    ownerNpub,
    env: buildStarterManagedEnv(starter, ownerNpub, towerWorkspaceOwnerNpub, ctx.towerUrl, ctx.wingmanUrl),
    webApp: Boolean(starter.webApp),
  });

  await registerTowerBackedStarterApp(ctx, starter, app, towerWorkspaceOwnerNpub, label);

  try {
    let project = ctx.npubProjectStore.getByPath(ownerNpub, root);
    if (project) {
      ctx.npubProjectStore.setAppId(project.id, app.id);
    } else {
      project = ctx.npubProjectStore.createProject(ownerNpub, root, app.label || undefined);
      if (project) {
        ctx.npubProjectStore.setAppId(project.id, app.id);
      }
    }
  } catch (linkError) {
    console.warn(`[starter-projects] failed to link app ${app.id} to npub-project: ${(linkError as Error).message}`);
  }

  if (!starter.scriptAuto) {
    return { app, setupStatus: null, startStatus: null, startError: null };
  }

  const setupStatus = await ctx.appProcessManager.setup(app.id);
  if (setupStatus.status !== "failed" && app.webApp && app.scripts.start) {
    try {
      const startStatus = await ctx.appProcessManager.start(app.id);
      return { app, setupStatus, startStatus, startError: null };
    } catch (error) {
      const startStatus = await ctx.appProcessManager.getStatus(app.id).catch(() => null);
      return {
        app,
        setupStatus,
        startStatus,
        startError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { app, setupStatus, startStatus: null, startError: null };
}

export async function handleStarterProjectsApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: StarterProjectsApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  if (pathname === "/api/apps/starter-projects" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) return denied;
    const starterProjects = ctx.starterProjectStore.list().map(toStarterResponse);
    return Response.json({ starterProjects, projects: starterProjects });
  }

  if (pathname === "/api/apps/starter-projects/launch" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) return denied;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const body = payload as Record<string, unknown>;
    const starterId = ctx.normaliseOptionalString(body.starterId);
    const appName = ctx.normaliseOptionalString(body.name);
    if (!starterId) return Response.json({ error: "Starter project id is required" }, { status: 400 });
    if (!appName) return Response.json({ error: "Name is required" }, { status: 400 });

    const starter = ctx.starterProjectStore.getById(starterId);
    if (!starter) return Response.json({ error: "Starter project not found" }, { status: 404 });

    const ownerNpub = ctx.viewerNpub ?? (ctx.workspaceScope.isAdmin ? ctx.adminNpub : null);
    if (!ownerNpub) {
      return Response.json({ error: "Unable to resolve app owner" }, { status: 403 });
    }

    const directoryName = slugifyDirectoryName(appName);
    try {
      const githubOwner = ctx.normaliseOptionalString(body.githubOwner);
      const githubRepo = ctx.normaliseOptionalString(body.githubRepo);
      if (!githubOwner) return Response.json({ error: "GitHub owner is required" }, { status: 400 });
      if (!githubRepo) return Response.json({ error: "GitHub repo name is required" }, { status: 400 });

      const privateRepo = toBoolean(body.private) ?? true;
      const protectBranches = toBoolean(body.protectBranches) ?? true;
      const createDeployedBranch = toBoolean(body.createDeployedBranch) ?? true;

      const cloneResult = await ctx.createRepositoryFromStarter(ctx.workspaceScope, {
        starterGitUrl: starter.gitUrl,
        appName,
        directoryName,
        ownerNpub,
        githubOwner,
        githubRepo,
        privateRepo,
        protectBranches,
        createDeployedBranch,
      });
      const { app, setupStatus, startStatus, startError } = await registerLaunchedStarterApp(
        ctx,
        ownerNpub,
        cloneResult.root,
        appName,
        cloneResult.scripts,
        starter,
      );
      const status = await ctx.appProcessManager.getStatus(app.id);
      const aliasRecord = await ctx.appAliasRegistry.getByAppId(app.id);
      const appPayload = ctx.buildAppResponse(app, status, { subdomainAlias: aliasRecord?.alias ?? null });
      return Response.json(
        {
          app: appPayload,
          starterProject: toStarterResponse(starter),
          setup: {
            attempted: starter.scriptAuto,
            status: setupStatus ?? null,
          },
          start: {
            attempted: Boolean(starter.scriptAuto && starter.webApp && app.scripts.start),
            status: startStatus ?? null,
            error: startError,
          },
          github: cloneResult.github ?? null,
        },
        { status: 201 },
      );
    } catch (error) {
      if (error instanceof TowerWappRegistrationError) {
        const status = error.status && error.status >= 400 && error.status < 500 ? 400 : 502;
        return Response.json({
          error: "wapp-tower-registration-failed",
          message: error.message,
          detailCode: error.detailCode,
          details: error.details ?? null,
        }, { status });
      }
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/admin/starter-projects" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) return denied;
    if (!ctx.workspaceScope.isAdmin) return Response.json({ error: "admin-only" }, { status: 403 });
    const starterProjects = ctx.starterProjectStore.list().map(toStarterResponse);
    return Response.json({ starterProjects, projects: starterProjects });
  }

  if (pathname === "/api/admin/starter-projects" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) return denied;
    if (!ctx.workspaceScope.isAdmin) return Response.json({ error: "admin-only" }, { status: 403 });
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    const body = payload as Record<string, unknown>;
    try {
      const created = ctx.starterProjectStore.create({
        name: ctx.normaliseOptionalString(body.name) ?? "",
        gitUrl: ctx.normaliseOptionalString(body.gitUrl) ?? "",
        webApp: toBoolean(body.webApp) ?? false,
        scriptAuto: toBoolean(body.scriptAuto) ?? false,
        notes: ctx.normaliseOptionalString(body.notes) ?? null,
        setupCommand: ctx.normaliseOptionalString(body.setupCommand) ?? null,
        updatedBy: ctx.viewerNpub ?? ctx.adminNpub,
      });
      return Response.json({ starterProject: toStarterResponse(created) }, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname.startsWith("/api/admin/starter-projects/") && method === "PUT") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) return denied;
    if (!ctx.workspaceScope.isAdmin) return Response.json({ error: "admin-only" }, { status: 403 });
    const id = decodeURIComponent(pathname.slice("/api/admin/starter-projects/".length));
    if (!id) return Response.json({ error: "Starter project id is required" }, { status: 400 });

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    const body = payload as Record<string, unknown>;
    try {
      const updated = ctx.starterProjectStore.update(id, {
        name: Object.prototype.hasOwnProperty.call(body, "name") ? ctx.normaliseOptionalString(body.name) ?? "" : undefined,
        gitUrl: Object.prototype.hasOwnProperty.call(body, "gitUrl") ? ctx.normaliseOptionalString(body.gitUrl) ?? "" : undefined,
        webApp: Object.prototype.hasOwnProperty.call(body, "webApp") ? toBoolean(body.webApp) : undefined,
        scriptAuto: Object.prototype.hasOwnProperty.call(body, "scriptAuto") ? toBoolean(body.scriptAuto) : undefined,
        notes: Object.prototype.hasOwnProperty.call(body, "notes") ? ctx.normaliseOptionalString(body.notes) : undefined,
        setupCommand:
          Object.prototype.hasOwnProperty.call(body, "setupCommand") ? ctx.normaliseOptionalString(body.setupCommand) : undefined,
        updatedBy: ctx.viewerNpub ?? ctx.adminNpub,
      });
      return Response.json({ starterProject: toStarterResponse(updated) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.toLowerCase().includes("not found") ? 404 : 400;
      return Response.json({ error: message }, { status });
    }
  }

  if (pathname.startsWith("/api/admin/starter-projects/") && method === "DELETE") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
    if (denied) return denied;
    if (!ctx.workspaceScope.isAdmin) return Response.json({ error: "admin-only" }, { status: 403 });
    const id = decodeURIComponent(pathname.slice("/api/admin/starter-projects/".length));
    if (!id) return Response.json({ error: "Starter project id is required" }, { status: 400 });
    const removed = ctx.starterProjectStore.remove(id);
    if (!removed) return Response.json({ error: "Starter project not found" }, { status: 404 });
    return Response.json({ ok: true });
  }

  return null;
}
