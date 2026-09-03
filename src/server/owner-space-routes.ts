import { runWithRequestContext, type RequestAuthContext } from "../auth/request-context";
import type { WorkspaceScope } from "../workspaces/workspace-scope";
import type { AppsApiContext } from "./apps-api-routes";
import { handleAppsApi } from "./apps-api-routes";
import type { DocsApiContext } from "./docs-routes";
import { handleDocsApi } from "./docs-routes";
import type { AppRecord } from "../apps/app-registry";
import type { WorkspaceDelegationStore } from "../storage/workspace-delegation-store";
import type { SchedulerStore } from "../scheduler/scheduler-store";
import { handleWappsApi, type WappsApiContext } from "./wapps-api-routes";
import {
  handleAgentChatApi,
  isAgentChatApiPath,
  type AgentChatApiContext,
} from "./agent-chat-routes";
import type { ExecutionAuditEntry } from "../auth/trusted-execution";
import {
  buildDelegatedWorkspaceScope,
  createOwnerScopedAuthContext,
  delegationAllowsApp,
  delegationAllowsPath,
  DelegationScopes,
  resolveOwnerAccess,
} from "../auth/delegation-access";
import { normaliseNpub } from "../identity/npub-utils";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

interface OwnerRouteMatch {
  ownerNpub: string;
  subpath: string;
}

export interface OwnerSpaceRoutesContext {
  workspaceDelegationStore: WorkspaceDelegationStore;
  resolveWorkspace: (context?: RequestAuthContext) => WorkspaceScope;
  buildAppsContext: (
    appsAuthContext: RequestAuthContext,
    workspaceScopeOverride?: WorkspaceScope,
    canAccessAppOverride?: (app: AppRecord) => boolean,
  ) => AppsApiContext;
  docsApiContext: DocsApiContext;
  listDirectories: (
    path: string | null,
    query: string | undefined,
    scope: WorkspaceScope,
  ) => Promise<unknown>;
  createDirectoryEntry: (
    parentInput: string | null | undefined,
    nameInput: unknown,
    scopeOverride?: WorkspaceScope,
  ) => Promise<unknown>;
  schedulerStore: SchedulerStore;
  schedulerApiHandler: (request: Request, url: URL, method: HttpMethod) => Promise<Response | null>;
  ensureSessionsAccess: (
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<Response | null>;
  buildWappsContext?: (
    authContext: RequestAuthContext,
    canAccessAppOverride?: (app: AppRecord) => boolean,
  ) => WappsApiContext;
  agentChatApiContext?: AgentChatApiContext;
  auditExecution?: (entry: ExecutionAuditEntry) => void;
}

function matchOwnerRoute(pathname: string): OwnerRouteMatch | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "owners") {
    return null;
  }
  const ownerNpub = normaliseNpub(parts[2] ?? null);
  if (!ownerNpub) {
    return null;
  }
  const subpath = `/${parts.slice(3).join("/")}`;
  return { ownerNpub, subpath };
}

function cloneUrlWithPath(url: URL, pathname: string): URL {
  const cloned = new URL(url.toString());
  cloned.pathname = pathname;
  return cloned;
}

function createRewrittenRequest(request: Request, url: URL): Request {
  return new Request(url.toString(), request);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const payload = await request.clone().json();
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function collectPotentialPathValues(
  url: URL,
  body: Record<string, unknown> | null,
): string[] {
  const values: string[] = [];
  const queryPath = url.searchParams.get("path");
  if (queryPath) {
    values.push(queryPath);
  }
  const queryDirectory = url.searchParams.get("directory");
  if (queryDirectory) {
    values.push(queryDirectory);
  }
  if (!body) {
    return values;
  }
  const keys = ["path", "directory", "parent", "targetDirectory"];
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) {
      values.push(value);
    }
  }
  return values;
}

function hasWorkspacePathFilters(
  delegation: ReturnType<WorkspaceDelegationStore["findActiveDelegation"]>,
): boolean {
  const filters = delegation?.resourceFilters;
  if (!filters) {
    return true;
  }
  return Boolean(
    filters.pathPrefixes?.length ||
    filters.projectRoots?.length ||
    filters.appRoots?.length,
  );
}

function resolveOwnerSchedulerScope(method: HttpMethod, subpath: string): string {
  if (method === "GET" || method === "HEAD") return DelegationScopes.SessionsRead;
  if (method === "POST" && subpath === "/scheduler/jobs") return DelegationScopes.SessionsCreate;
  return DelegationScopes.SessionsManage;
}

function schedulerJobId(subpath: string): string | null {
  const match = subpath.match(/^\/scheduler\/jobs\/([^/]+)(?:\/|$)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function delegationDenial(
  ctx: OwnerSpaceRoutesContext,
  authContext: RequestAuthContext,
  ownerNpub: string,
  requiredScope: string,
): Response {
  const delegateNpub = normaliseNpub(
    authContext.subjectNpub ?? authContext.signerNpub ?? authContext.actorNpub ?? authContext.npub ?? null,
  );
  const active = delegateNpub
    ? ctx.workspaceDelegationStore.findActiveDelegation(ownerNpub, delegateNpub)
    : null;
  ctx.auditExecution?.({
    actorNpub: delegateNpub,
    ownerNpub,
    delegationId: active?.id ?? null,
    scope: requiredScope,
    target: "owner-space",
    action: `authorize ${requiredScope}`,
    outcome: "denied",
    timestamp: new Date().toISOString(),
  });
  if (active) {
    return Response.json({
      error: "delegation-scope-required",
      requiredScope,
    }, { status: 403 });
  }
  return Response.json({
    error: "active-owner-delegation-required",
    requiredScope,
  }, { status: 403 });
}

function auditResourceDenial(
  ctx: OwnerSpaceRoutesContext,
  authContext: RequestAuthContext,
  ownerNpub: string,
  delegationId: string | null | undefined,
  scope: string,
  request: Request,
  url: URL,
): void {
  ctx.auditExecution?.({
    actorNpub: normaliseNpub(authContext.subjectNpub ?? authContext.signerNpub ?? authContext.npub ?? null),
    ownerNpub,
    delegationId: delegationId ?? null,
    scope,
    target: url.pathname,
    action: `${request.method} ${url.pathname}`,
    outcome: "denied",
    timestamp: new Date().toISOString(),
  });
}

function schedulerResourceDenial(
  delegation: ReturnType<WorkspaceDelegationStore["findActiveDelegation"]>,
  ownerWorkspace: WorkspaceScope,
  jobId: string | null,
  paths: Array<{ field: string; value: string | null | undefined }>,
): Response | null {
  const triggerIds = delegation?.resourceFilters?.triggerIds ?? [];
  if (triggerIds.length > 0 && (!jobId || !triggerIds.includes(jobId))) {
    return Response.json({
      error: "trigger-outside-delegated-resource-filters",
      filter: "triggerIds",
      triggerId: jobId,
    }, { status: 403 });
  }
  for (const candidate of paths) {
    if (candidate.value && !delegationAllowsPath(delegation, ownerWorkspace, candidate.value)) {
      return Response.json({
        error: "trigger-outside-delegated-resource-filters",
        filter: candidate.field,
      }, { status: 403 });
    }
  }
  return null;
}

export function resolveOwnerWappsScope(method: HttpMethod, subpath: string): string {
  if (method === "GET" || method === "HEAD") return DelegationScopes.WappsRead;
  if (subpath === "/wapps/templates/create") return DelegationScopes.WappsInstall;
  return DelegationScopes.WappsAssign;
}

export function resolveOwnerAgentChatScope(method: HttpMethod): string {
  return method === "GET" || method === "HEAD"
    ? DelegationScopes.SessionsRead
    : DelegationScopes.SessionsManage;
}

function delegatedWappResourceDenial(
  delegation: ReturnType<WorkspaceDelegationStore["findActiveDelegation"]>,
  input: { wappId?: string | null; workspaceId?: string | null; scopeId?: string | null },
): Response | null {
  const filters = delegation?.resourceFilters;
  const checks = [
    ["wappIds", input.wappId, filters?.wappIds],
    ["workspaceIds", input.workspaceId, filters?.workspaceIds],
    ["scopeIds", input.scopeId, filters?.scopeIds],
  ] as const;
  for (const [filter, value, allowed] of checks) {
    if (allowed?.length && (!value || !allowed.includes(value))) {
      return Response.json({ error: "wapp-outside-delegated-resource-filters", filter }, { status: 403 });
    }
  }
  return null;
}

export async function resolveOwnerAppsScope(request: Request, method: HttpMethod, subpath: string): Promise<string> {
  if (method === "GET" || method === "HEAD") return DelegationScopes.AppsRead;
  if (/\/caprover\/|\/deploy-to-caprover$/.test(subpath)) return DelegationScopes.DeploymentsManage;
  if (/\/actions$/.test(subpath) && method === "POST") {
    const body = await readJsonBody(request);
    const action = typeof body?.action === "string" ? body.action.trim().toLowerCase() : "";
    return action === "setup" || action === "build" ? DelegationScopes.AppsBuild : DelegationScopes.AppsOperate;
  }
  return DelegationScopes.AppsConfigure;
}

export async function handleOwnerSpaceApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: OwnerSpaceRoutesContext,
): Promise<Response | null> {
  const matched = matchOwnerRoute(url.pathname);
  if (!matched) {
    return null;
  }

  if (matched.subpath === "/scheduler/jobs" || matched.subpath.startsWith("/scheduler/jobs/")) {
    const requiredScope = resolveOwnerSchedulerScope(method, matched.subpath);
    const access = resolveOwnerAccess(
      authContext,
      matched.ownerNpub,
      ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore),
      requiredScope,
    );
    if (!access) {
      return delegationDenial(ctx, authContext, matched.ownerNpub, requiredScope);
    }
    const ownerAuthContext = createOwnerScopedAuthContext(authContext, matched.ownerNpub, access, requiredScope);
    const ownerWorkspace = ctx.resolveWorkspace(ownerAuthContext);
    const jobId = schedulerJobId(matched.subpath);
    const existing = jobId ? ctx.schedulerStore.getJob(jobId) : null;
    if (jobId && (!existing || normaliseNpub(existing.userNpub) !== matched.ownerNpub)) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }
    const body = method === "GET" || method === "HEAD" || method === "DELETE"
      ? null
      : await readJsonBody(request);
    const deniedResource = schedulerResourceDenial(access.delegation, ownerWorkspace, jobId, [
      { field: "workingDirectory", value: typeof body?.workingDirectory === "string" ? body.workingDirectory : existing?.workingDirectory },
      { field: "watchDirectory", value: typeof body?.watchDirectory === "string" ? body.watchDirectory : existing?.watchDirectory },
    ]);
    if (deniedResource) {
      auditResourceDenial(ctx, authContext, matched.ownerNpub, access.delegation?.id, requiredScope, request, url);
      return deniedResource;
    }
    const rewrittenUrl = cloneUrlWithPath(url, `/api${matched.subpath}`);
    const rewrittenRequest = createRewrittenRequest(request, rewrittenUrl);
    const deniedAccess = await ctx.ensureSessionsAccess(rewrittenRequest, rewrittenUrl, ownerAuthContext);
    if (deniedAccess) return deniedAccess;
    return await runWithRequestContext(
      ownerAuthContext,
      () => ctx.schedulerApiHandler(rewrittenRequest, rewrittenUrl, method),
    );
  }

  const agentChatPath = `/api${matched.subpath}`;
  if (isAgentChatApiPath(agentChatPath)) {
    if (!ctx.agentChatApiContext) {
      return Response.json({ error: "agent-chat-unavailable" }, { status: 503 });
    }
    const requiredScope = resolveOwnerAgentChatScope(method);
    const access = resolveOwnerAccess(
      authContext,
      matched.ownerNpub,
      ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore),
      requiredScope,
    );
    if (!access) {
      return delegationDenial(ctx, authContext, matched.ownerNpub, requiredScope);
    }
    const ownerAuthContext = createOwnerScopedAuthContext(
      authContext,
      matched.ownerNpub,
      access,
      requiredScope,
    );
    const rewrittenUrl = cloneUrlWithPath(url, agentChatPath);
    const rewrittenRequest = createRewrittenRequest(request, rewrittenUrl);
    return await runWithRequestContext(ownerAuthContext, () => handleAgentChatApi(
      rewrittenRequest,
      rewrittenUrl,
      method === "GET" || method === "POST" || method === "PATCH" || method === "DELETE" ? method : "GET",
      ownerAuthContext,
      ctx.agentChatApiContext!,
    ));
  }

  if (matched.subpath === "/wapps" || matched.subpath.startsWith("/wapps/")) {
    if (!ctx.buildWappsContext) return Response.json({ error: "wapps-unavailable" }, { status: 503 });
    const requiredScope = resolveOwnerWappsScope(method, matched.subpath);
    const access = resolveOwnerAccess(
      authContext,
      matched.ownerNpub,
      ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore),
      requiredScope,
    );
    if (!access) return delegationDenial(ctx, authContext, matched.ownerNpub, requiredScope);
    const ownerAuthContext = createOwnerScopedAuthContext(authContext, matched.ownerNpub, access, requiredScope);
    const wappIdMatch = matched.subpath.match(/^\/wapps\/([^/]+)(?:\/|$)/);
    const routeWappId = wappIdMatch && !["templates", "tower-bindings"].includes(wappIdMatch[1]!)
      ? decodeURIComponent(wappIdMatch[1]!)
      : null;
    const body = method === "GET" || method === "HEAD" || method === "DELETE" ? null : await readJsonBody(request);
    const wappId = routeWappId ?? (
      typeof body?.id === "string" ? body.id
        : typeof body?.wappInstallationId === "string" ? body.wappInstallationId
          : typeof body?.wapp_installation_id === "string" ? body.wapp_installation_id : null
    );
    const wappsContext = ctx.buildWappsContext(ownerAuthContext, (app) =>
      normaliseNpub(app.ownerNpub ?? null) === matched.ownerNpub && delegationAllowsApp(access.delegation, app));
    const existing = routeWappId ? wappsContext.wappStore.get(routeWappId) : null;
    if (routeWappId && (!existing || normaliseNpub(existing.ownerNpub) !== matched.ownerNpub)) {
      return Response.json({ error: "WApp not found" }, { status: 404 });
    }
    const towerBindingId = typeof body?.towerBindingId === "string"
      ? body.towerBindingId
      : typeof body?.tower_binding_id === "string" ? body.tower_binding_id : existing?.towerBindingId;
    const binding = towerBindingId ? wappsContext.wappStore.getTowerBinding(towerBindingId) : null;
    const workspaceOwnerNpub = normaliseNpub(
      typeof body?.workspaceOwnerNpub === "string" ? body.workspaceOwnerNpub
        : typeof body?.workspace_owner_npub === "string" ? body.workspace_owner_npub
          : existing?.workspaceOwnerNpub ?? binding?.workspaceOwnerNpub ?? null,
    );
    if (workspaceOwnerNpub && workspaceOwnerNpub !== matched.ownerNpub) {
      auditResourceDenial(ctx, authContext, matched.ownerNpub, access.delegation?.id, requiredScope, request, url);
      return Response.json({ error: "wapp-owner-mismatch" }, { status: 403 });
    }
    const deniedResource = delegatedWappResourceDenial(access.delegation, {
      wappId,
      workspaceId: typeof body?.workspaceId === "string" ? body.workspaceId
        : typeof body?.workspace_id === "string" ? body.workspace_id
          : binding?.workspaceId ?? existing?.towerBinding?.workspaceId ?? null,
      scopeId: typeof body?.scopeId === "string" ? body.scopeId
        : typeof body?.scope_id === "string" ? body.scope_id : existing?.scopeId ?? null,
    });
    if (deniedResource) {
      auditResourceDenial(ctx, authContext, matched.ownerNpub, access.delegation?.id, requiredScope, request, url);
      return deniedResource;
    }
    const rewrittenUrl = cloneUrlWithPath(url, `/api${matched.subpath}`);
    const rewrittenRequest = createRewrittenRequest(request, rewrittenUrl);
    return await runWithRequestContext(ownerAuthContext, () =>
      handleWappsApi(rewrittenRequest, rewrittenUrl, method, ownerAuthContext, wappsContext));
  }

  if (
    matched.subpath === "/apps" ||
    matched.subpath.startsWith("/apps/") ||
    matched.subpath === "/workspace/tree"
  ) {
    const requiredScope = await resolveOwnerAppsScope(request, method, matched.subpath);
    const access = resolveOwnerAccess(
      authContext,
      matched.ownerNpub,
      ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore),
      requiredScope,
    );
    if (!access) {
      return Response.json({ error: "Delegation required" }, { status: 403 });
    }
    const ownerAuthContext = createOwnerScopedAuthContext(authContext, matched.ownerNpub, access, requiredScope);
    const ownerWorkspace = ctx.resolveWorkspace(ownerAuthContext);
    const appBody = method === "GET" || method === "HEAD" ? null : await readJsonBody(request);
    if (
      !hasWorkspacePathFilters(access.delegation) &&
      (matched.subpath === "/workspace/tree" || matched.subpath === "/apps/clone" || matched.subpath === "/apps")
    ) {
      return Response.json({ error: "Delegation does not grant workspace path access" }, { status: 403 });
    }
    const deniedAppPath = collectPotentialPathValues(url, appBody)
      .find((candidate) => !delegationAllowsPath(access.delegation, ownerWorkspace, candidate));
    if (deniedAppPath) {
      return Response.json({ error: "Path is outside delegated access" }, { status: 403 });
    }
    const delegatedWorkspace = buildDelegatedWorkspaceScope(ownerWorkspace, access.delegation);
    const rewrittenUrl = cloneUrlWithPath(url, `/api${matched.subpath}`);
    const appsCtx = ctx.buildAppsContext(
      ownerAuthContext,
      delegatedWorkspace,
      (app) =>
        normaliseNpub(app.ownerNpub ?? null) === matched.ownerNpub &&
        delegationAllowsApp(access.delegation, app),
    );
    return handleAppsApi(
      createRewrittenRequest(request, rewrittenUrl),
      rewrittenUrl,
      method,
      ownerAuthContext,
      appsCtx,
    );
  }

  if (matched.subpath.startsWith("/docs/")) {
    const requiredScope =
      method === "GET" || method === "HEAD"
        ? DelegationScopes.FilesRead
        : DelegationScopes.FilesWrite;
    const access = resolveOwnerAccess(
      authContext,
      matched.ownerNpub,
      ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore),
      requiredScope,
    );
    if (!access) {
      return Response.json({ error: "Delegation required" }, { status: 403 });
    }
    const ownerAuthContext = createOwnerScopedAuthContext(authContext, matched.ownerNpub, access, requiredScope);
    const ownerWorkspace = ctx.resolveWorkspace(ownerAuthContext);
    const body = method === "GET" || method === "HEAD" ? null : await readJsonBody(request);
    const requestedPaths = collectPotentialPathValues(url, body);
    const deniedPath = requestedPaths.find((candidate) => !delegationAllowsPath(access.delegation, ownerWorkspace, candidate));
    if (deniedPath) {
      return Response.json({ error: "Path is outside delegated access" }, { status: 403 });
    }
    const rewrittenUrl = cloneUrlWithPath(url, `/api${matched.subpath}`);
    return handleDocsApi(
      createRewrittenRequest(request, rewrittenUrl),
      rewrittenUrl,
      method,
      ownerAuthContext,
      ctx.docsApiContext,
    );
  }

  if (matched.subpath === "/directories") {
    const requiredScope =
      method === "GET" || method === "HEAD"
        ? DelegationScopes.FilesRead
        : DelegationScopes.FilesWrite;
    const access = resolveOwnerAccess(
      authContext,
      matched.ownerNpub,
      ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore),
      requiredScope,
    );
    if (!access) {
      return Response.json({ error: "Delegation required" }, { status: 403 });
    }
    const ownerAuthContext = createOwnerScopedAuthContext(authContext, matched.ownerNpub, access, requiredScope);
    const ownerWorkspace = ctx.resolveWorkspace(ownerAuthContext);
    const delegatedWorkspace = buildDelegatedWorkspaceScope(ownerWorkspace, access.delegation);
    if (method === "GET") {
      const pathParam = url.searchParams.get("path");
      if (!delegationAllowsPath(access.delegation, ownerWorkspace, pathParam)) {
        return Response.json({ error: "Path is outside delegated access" }, { status: 403 });
      }
      try {
        const data = await ctx.listDirectories(
          pathParam,
          url.searchParams.get("query") ?? undefined,
          delegatedWorkspace,
        );
        return Response.json(data);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    if (method === "POST") {
      const payload = await readJsonBody(request);
      if (!payload) {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }
      const parentInput = typeof payload.parent === "string" ? payload.parent : null;
      if (!delegationAllowsPath(access.delegation, ownerWorkspace, parentInput)) {
        return Response.json({ error: "Path is outside delegated access" }, { status: 403 });
      }
      try {
        const data = await ctx.createDirectoryEntry(parentInput, payload.name, delegatedWorkspace);
        return Response.json(data, { status: 201 });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }
  }

  return null;
}
