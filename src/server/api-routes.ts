/**
 * API route handlers for /api/* endpoints.
 * Extracted from server.ts to reduce file size.
 */

import { runWithRequestContext, type RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import type { WorkspaceScope } from "../workspaces/workspace-scope";
import type { AppRecord } from "../apps/app-registry";
import { handleAppsApi, type AppsApiContext } from "./apps-api-routes";
import { handleStarterProjectsApi, type StarterProjectsApiContext } from "./starter-projects-routes";
import { handleChatApi, type ChatApiContext } from "./chat-routes";
import { handleSessionApi, type SessionApiContext } from "./session-api-routes";
import { handleProviderProxyApi, type ProviderProxyApiContext } from "./provider-proxy-routes";
import { handleBillingApi, type BillingApiContext } from "./billing-routes";
import { handleDocsApi, type DocsApiContext } from "./docs-routes";
import { handleAdminUsersApi, type AdminUsersApiContext } from "./admin-users-routes";
import { handleAuthApi, type AuthApiContext } from "./auth-routes";
import {
  handleFeatureFlagsApi,
  type FeatureFlagsApiContext,
} from "./feature-flags-routes";
import {
  handleUploadsApi,
  type UploadApiContext,
} from "./upload-routes";
import { handleVoiceNoteUploadsApi, type VoiceNoteUploadApiContext } from "./voice-note-routes";
import { handleSystemRoutes, type SystemRoutesContext } from "./system-routes";
import {
  handleAgentChatApi,
  isAgentChatApiPath,
  type AgentChatApiContext,
} from './agent-chat-routes';
import { handleDelegationApi, type DelegationRoutesContext } from "./delegation-routes";
import { handleOwnerSpaceApi } from "./owner-space-routes";
import { handleWappsApi, type WappsApiContext } from "./wapps-api-routes";
import { handlePipelineApi, type PipelineApiContext } from "../pipelines/pipeline-api-routes";
import type { WorkspaceDelegationStore } from "../storage/workspace-delegation-store";
import { getEffectiveOwnerNpub } from "../auth/effective-owner";
import { handleSigningApi, type SigningApiContext } from "../signing/signing-api";
import { handleTerminalApi, type TerminalRoutesContext } from "./terminal-routes";
import { handleUserSettingsApi, type UserSettingsRoutesContext } from "./user-settings-routes";
import {
  handleInstanceSettingsApi,
  type InstanceSettingsRoutesContext,
} from "./instance-settings-routes";
import {
  handleRemoteInstructApi,
  type RemoteInstructRoutesContext,
} from "./remote-instruct-routes";
import {
  handleCloudflareTunnelApi,
  type CloudflareTunnelRoutesContext,
} from "./cloudflare-tunnel-routes";
import { handleSessionDispatchApi } from "../session-dispatch/session-dispatch-routes";
import type { SessionDispatchService } from "../session-dispatch/session-dispatch-service";
import { MODEL_PROVIDERS_SETTING_KEY } from "../settings/openrouter-models";
import { resolveAgentModelCatalogue } from "./agent-model-catalogue";
import { handleWappTowerDbBrokerRoute } from "./wapp-tower-db-broker-route";
import type { WappTowerDbRequestBroker } from "../wapps/tower-db-request-broker";
import {
  WAPP_LEGACY_CUSTODY_MIGRATION_PATH,
  handleWappLegacyCustodyMigrationRoute,
} from "./wapp-legacy-custody-migration-route";
import type { LegacyWappCustodyMigration } from "../wapps/legacy-custody-migration";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

// ---------- Handler signatures for pre-instantiated API handlers ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
type SimpleApiHandler = (...args: any[]) => Promise<Response | null>;
type AuthedApiHandler = (...args: any[]) => Promise<Response | null>;
type ProjectApiHandler = (...args: any[]) => Promise<Response | null>;
type NpubProjectApiHandler = (...args: any[]) => Promise<Response | null>;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- Context supplied by server.ts ----------

export interface ApiRoutesContext {
  // Config subset needed by handleApi
  config: {
    port: number;
    baseUrl: string;
    baseUrlConfigured: boolean;
    agentPortStart: number;
    agentPortMax: number;
    hostUrlBase: string | null;
    appRoutingMode: string;
    subdomainBaseDomain: string | null;
    subdomainProxyEnabled: boolean;
    connectRelays: string[];
    agents: Record<string, { label: string; modelOptions?: string[] }>;
    defaultAgent: string;
    giteaUrl: string | null;
  };
  adminNpub: string | null;
  adminNpubs?: string[];

  // Callback to retrieve the remote IP for a request.
  // Optional — if omitted, localhost checks are skipped (e.g. in tests).
  getRequestIP?: (request: Request) => { address: string } | null;

  // Pre-instantiated API handlers
  todoApiHandler: AuthedApiHandler;
  projectApiHandler: ProjectApiHandler;
  npubProjectApiHandler: NpubProjectApiHandler;
  browserLogHandler: AuthedApiHandler;
  caproverApiHandler: AuthedApiHandler;
  nightWatchApiHandler: SimpleApiHandler;
  nip98ApiHandler: SimpleApiHandler;
  botCryptoApiHandler: SimpleApiHandler;
  capabilityBrokerApiHandler?: SimpleApiHandler;
  wappTowerDbRequestBroker?: WappTowerDbRequestBroker;
  legacyWappCustodyMigration?: LegacyWappCustodyMigration;
  botKeyApiHandler: SimpleApiHandler;
  giteaApiHandler: SimpleApiHandler;
  gitWorkflowApiHandler: SimpleApiHandler;
  ngitApiHandler: SimpleApiHandler;
  wingmanMcpApiHandler: SimpleApiHandler;
  schedulerApiHandler: SimpleApiHandler;
  schedulerStore: import("../scheduler/scheduler-store").SchedulerStore;
  auditExecution?: (entry: import("../auth/trusted-execution").ExecutionAuditEntry) => void;

  // Pre-built route contexts (request-independent)
  sessionApiContext: SessionApiContext;
  docsApiContext: DocsApiContext;
  providerProxyApiContext: ProviderProxyApiContext;
  billingApiContext: BillingApiContext;
  systemRoutesContext: SystemRoutesContext;
  authApiContext: AuthApiContext;
  adminUsersApiContext: AdminUsersApiContext;
  uploadApiContext: UploadApiContext;
  voiceNoteUploadApiContext: VoiceNoteUploadApiContext;
  agentChatApiContext?: AgentChatApiContext;
  delegationRoutesContext: DelegationRoutesContext;
  pipelineApiContext?: PipelineApiContext;
  signingApiContext?: SigningApiContext;
  terminalRoutesContext?: TerminalRoutesContext;
  userSettingsRoutesContext: UserSettingsRoutesContext;
  instanceSettingsRoutesContext: InstanceSettingsRoutesContext;
  remoteInstructRoutesContext: RemoteInstructRoutesContext;
  cloudflareTunnelRoutesContext?: CloudflareTunnelRoutesContext;
  workspaceDelegationStore: WorkspaceDelegationStore;
  sessionDispatchService?: SessionDispatchService;

  // Stores accessed directly by handleApi
  featureFlagStore: {
    getFlag: (key: string) => unknown;
  };
  userSettingsStore: {
    getAll: (npub: string) => Record<string, string>;
    set: (npub: string, key: string, value: string) => void;
    delete: (npub: string, key: string) => void;
  };
  artifactsStore: {
    get: (id: string) => { filePath: string; mimeType: string | null } | null;
  };

  // Constants
  PROJECTS_FLAG_KEY: string;

  // Core helper functions
  resolveWorkspace: (context?: RequestAuthContext) => WorkspaceScope;
  verifyNip98AuthHeader: (request: Request, url: URL) => Promise<{
    signerNpub: string;
    capabilitySessionId?: string | null;
  } | null>;
  resolveNip98AuthContext: (
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<RequestAuthContext>;
  resolveFeatureFlagStateForViewer: (
    key: string,
    isAdmin: boolean,
    defaultState?: "on" | "off" | "on_admin",
  ) => { effectiveState: string };
  ensureApiAccess: (
    action: AccessAction,
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<Response | null>;
  serialiseFeatureFlagsForViewer: (isAdmin: boolean) => unknown;

  // Directory helpers
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

  // Access control actions
  AccessActions: {
    ProjectsManage: AccessAction;
    TodosManage: AccessAction;
    SessionsManage: AccessAction;
    DeploymentsManage: AccessAction;
    SystemManage: AccessAction;
    UiRestricted?: AccessAction;
    FilesRead: AccessAction;
    FilesWrite: AccessAction;
    AppsManage: AccessAction;
  };

  // Per-request context builders (take request-scoped values, return typed sub-contexts)
  buildStarterProjectsContext: (
    workspaceScope: WorkspaceScope,
    viewerNpub: string | null,
  ) => Parameters<typeof handleStarterProjectsApi>[4];
  buildAppsContext: (
    appsAuthContext: RequestAuthContext,
    workspaceScopeOverride?: WorkspaceScope,
    canAccessAppOverride?: (app: AppRecord) => boolean,
  ) => Parameters<typeof handleAppsApi>[4];
  buildFeatureFlagsContext: (
    viewerIsAdmin: boolean,
  ) => FeatureFlagsApiContext;
  buildChatContext: (
    viewerNpub: string | null,
    viewerIsAdmin: boolean,
  ) => ChatApiContext;
  buildWappsContext?: (
    authContext: RequestAuthContext,
    canAccessAppOverride?: (app: AppRecord) => boolean,
  ) => WappsApiContext;
}

// ---------- Factory ----------

// Localhost addresses accepted for internal-only API routes.
const LOCALHOST_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCALHOST_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEFAULT_AGENT_SETTING_KEY = "default_agent";

function isLocalhostRequest(request: Request, ctx: ApiRoutesContext): boolean {
  if (!ctx.getRequestIP) {
    // No IP resolver provided (e.g. unit tests) — allow by default.
    return true;
  }
  const ip = ctx.getRequestIP(request);
  return ip !== null && LOCALHOST_ADDRESSES.has(ip.address);
}

function isLocalhostBrokerRequest(request: Request, url: URL, ctx: ApiRoutesContext): boolean {
  return LOCALHOST_HOSTNAMES.has(url.hostname.toLowerCase()) && isLocalhostRequest(request, ctx);
}

function resolveViewerDefaultAgent(ctx: ApiRoutesContext, viewerNpub: string | null): string {
  const agents = ctx.config.agents ?? {};
  if (!viewerNpub) {
    return ctx.config.defaultAgent;
  }

  const storedAgent = ctx.userSettingsStore.getAll(viewerNpub)[DEFAULT_AGENT_SETTING_KEY];
  const normalizedAgent = typeof storedAgent === "string" ? storedAgent.trim().toLowerCase() : "";
  if (normalizedAgent && normalizedAgent in agents) {
    return normalizedAgent;
  }
  return ctx.config.defaultAgent;
}

export function createApiRouteHandler(ctx: ApiRoutesContext) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
    authContext: RequestAuthContext,
  ): Promise<Response> => {
    const withProjectApiCors = (response: Response): Response => {
      const headers = new Headers(response.headers);
      const origin = request.headers.get("origin");
      headers.set("Access-Control-Allow-Origin", origin || "*");
      headers.set("Vary", "Origin");
      headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };

    const pathname = url.pathname;
    const workspaceScope = ctx.resolveWorkspace(authContext);
    const viewerIsAdmin = workspaceScope.isAdmin;
    const projectsFlag = ctx.resolveFeatureFlagStateForViewer(ctx.PROJECTS_FLAG_KEY, viewerIsAdmin, "on_admin");
    const projectsEnabled = projectsFlag.effectiveState === "on";
    const viewerNpub = getEffectiveOwnerNpub(authContext);

    if (pathname === "/api/internal/wapps/tower-db") {
      if (!ctx.wappTowerDbRequestBroker) {
        return Response.json({ error: "wapp-tower-db-broker-unavailable" }, { status: 503 });
      }
      const response = await handleWappTowerDbBrokerRoute({
        request,
        url,
        method,
        isLoopback: isLocalhostBrokerRequest(request, url, ctx),
        broker: ctx.wappTowerDbRequestBroker,
      });
      return response ?? Response.json({ error: "Not found" }, { status: 404 });
    }

    if (pathname === WAPP_LEGACY_CUSTODY_MIGRATION_PATH) {
      if (!ctx.legacyWappCustodyMigration) {
        return Response.json({ error: "legacy-custody-migration-unavailable" }, { status: 503 });
      }
      const migrationAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, migrationAuthContext);
      if (denied) return denied;
      const response = await runWithRequestContext(
        migrationAuthContext,
        () => handleWappLegacyCustodyMigrationRoute({
          request,
          url,
          method,
          isLoopback: isLocalhostBrokerRequest(request, url, ctx),
          isAdmin: ctx.resolveWorkspace(migrationAuthContext).isAdmin,
          migration: ctx.legacyWappCustodyMigration!,
        }),
      );
      return response ?? Response.json({ error: "Not found" }, { status: 404 });
    }

    if (pathname.startsWith("/api/session-dispatches")) {
      if (!isLocalhostRequest(request, ctx)) return Response.json({ error: "Forbidden" }, { status: 403 });
      if (!ctx.sessionDispatchService) return Response.json({ error: "session-dispatch-unavailable" }, { status: 503 });
      const response = await handleSessionDispatchApi(request, url, method, ctx.sessionDispatchService);
      if (response) return response;
    }

    const browserLogResponse = await ctx.browserLogHandler(request, url, method, authContext);
    if (browserLogResponse) {
      return browserLogResponse;
    }

    const providerProxyResponse = await handleProviderProxyApi(request, url, method, ctx.providerProxyApiContext);
    if (providerProxyResponse) {
      return providerProxyResponse;
    }

    const remoteInstructResponse = await handleRemoteInstructApi(
      request,
      url,
      method,
      authContext,
      ctx.remoteInstructRoutesContext,
    );
    if (remoteInstructResponse) {
      return remoteInstructResponse;
    }

    const billingApiResponse = await handleBillingApi(request, url, method, authContext, ctx.billingApiContext);
    if (billingApiResponse) {
      return billingApiResponse;
    }

    const instanceSettingsResponse = await handleInstanceSettingsApi(
      request,
      url,
      method,
      authContext,
      ctx.instanceSettingsRoutesContext,
    );
    if (instanceSettingsResponse) {
      return instanceSettingsResponse;
    }

    if (pathname.startsWith("/api/cloudflare/tunnel-hostnames")) {
      const cloudflareTunnelRoutesContext = ctx.cloudflareTunnelRoutesContext;
      if (!cloudflareTunnelRoutesContext) {
        return Response.json({ error: "cloudflare-tunnel-unavailable" }, { status: 503 });
      }
      const cloudflareAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);
      const response = await runWithRequestContext(
        cloudflareAuthContext,
        () => handleCloudflareTunnelApi(
          request,
          url,
          method,
          cloudflareAuthContext,
          cloudflareTunnelRoutesContext,
        ),
      );
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (pathname.startsWith("/api/pipelines") && ctx.pipelineApiContext) {
      const pipelineApiContext = ctx.pipelineApiContext;
      const pipelineAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);
      const pipelineResponse = await runWithRequestContext(
        pipelineAuthContext,
        () => handlePipelineApi(request, url, method, pipelineAuthContext, pipelineApiContext),
      );
      if (pipelineResponse) return pipelineResponse;
    }

    if (pathname.startsWith("/api/terminal/")) {
      if (!ctx.terminalRoutesContext) {
        return Response.json({ error: "terminal-unavailable" }, { status: 503 });
      }
      const response = await handleTerminalApi(request, url, method, authContext, ctx.terminalRoutesContext);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (pathname.startsWith("/api/npub-projects")) {
      if (method === "OPTIONS") {
        return withProjectApiCors(new Response(null, { status: 204 }));
      }

      let effectiveAuth = authContext;
      let effectiveIsAdmin = workspaceScope.isAdmin;

      // Allow NIP-98 auth as fallback when no session cookie
      if (!authContext.session) {
        effectiveAuth = await ctx.resolveNip98AuthContext(request, url, authContext);
        if (effectiveAuth.npub) {
          const configuredAdmins = ctx.adminNpubs ?? (ctx.adminNpub ? [ctx.adminNpub] : []);
          effectiveIsAdmin = configuredAdmins.includes(effectiveAuth.npub);
        } else {
          return withProjectApiCors(Response.json({ error: "Authentication required" }, { status: 401 }));
        }
      }

      const response = await ctx.npubProjectApiHandler(
        request,
        url,
        method,
        effectiveAuth,
        effectiveIsAdmin,
      );
      if (response) {
        return withProjectApiCors(response);
      }
      return withProjectApiCors(Response.json({ error: "Not found" }, { status: 404 }));
    }
    if (pathname.startsWith("/api/projects")) {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.ProjectsManage, request, url, authContext);
      if (denied) {
        return denied;
      }
      if (!projectsEnabled) {
        return Response.json({ error: "projects-disabled" }, { status: 403 });
      }
      const response = await ctx.projectApiHandler(request, url, method, authContext, {
        isAdmin: workspaceScope.isAdmin,
      });
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (pathname.startsWith("/api/todos")) {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.TodosManage, request, url, authContext);
      if (denied) {
        return denied;
      }
      const response = await ctx.todoApiHandler(request, url, method, authContext);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (pathname.startsWith("/api/nightwatch")) {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
      if (denied) {
        return denied;
      }
      const response = await ctx.nightWatchApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (pathname.startsWith("/api/scheduler")) {
      const schedulerAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, schedulerAuthContext);
      if (denied) {
        return denied;
      }
      const response = await runWithRequestContext(
        schedulerAuthContext,
        () => ctx.schedulerApiHandler(request, url, method),
      );
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (pathname.startsWith("/api/wapps")) {
      const wappsAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);
      if (!ctx.buildWappsContext) {
        return Response.json({ error: "wapps-unavailable" }, { status: 503 });
      }
      const wappsApiContext = ctx.buildWappsContext(wappsAuthContext);
      const response = await runWithRequestContext(
        wappsAuthContext,
        () => handleWappsApi(request, url, method, wappsAuthContext, wappsApiContext),
      );
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // Internal signing API — called by external runner scripts through the
    // wingman-sign CLI. Requires localhost plus a scoped bearer capability.
    if (pathname.startsWith("/api/internal/signing")) {
      if (!isLocalhostRequest(request, ctx)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      if (!ctx.signingApiContext) {
        return Response.json({ error: "Runner signing is not configured" }, { status: 503 });
      }
      const response = await handleSigningApi(request, url, method, ctx.signingApiContext);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // Bot key API — per-user bot identity management.
    // Auth: cookie-based for browser routes, session ID for escrow unlock.
    if (pathname.startsWith("/api/bot-keys")) {
      const response = await ctx.botKeyApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // Bot crypto API — NIP-44 encrypt/decrypt using user's bot key.
    // Restricted to localhost: only MCP stdio servers (running on the same host) call this.
    if (pathname.startsWith("/api/mcp/bot-crypto")) {
      if (!isLocalhostRequest(request, ctx)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      const response = await ctx.botCryptoApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (pathname.startsWith("/api/mcp/capabilities")) {
      if (!isLocalhostRequest(request, ctx)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      if (!ctx.capabilityBrokerApiHandler) {
        return Response.json({ error: "Capability broker is not configured" }, { status: 503 });
      }
      const response = await ctx.capabilityBrokerApiHandler(request, url, method);
      return response ?? Response.json({ error: "Not found" }, { status: 404 });
    }
    // MCP NIP-98 API — called by the MCP stdio server running inside agents.
    // Restricted to localhost: only MCP stdio servers (running on the same host) call this.
    if (pathname.startsWith("/api/mcp/nip98")) {
      if (!isLocalhostRequest(request, ctx)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      const response = await ctx.nip98ApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // Git workflow API — branch, worktree, merge, and status operations.
    // Restricted to localhost: only MCP stdio servers (running on the same host) call this.
    if (pathname.startsWith("/api/git/")) {
      if (!isLocalhostRequest(request, ctx)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      const response = await ctx.gitWorkflowApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // Gitea API — programmatic git operations scoped to the Gitea remote.
    // No auth gate: validated by session ID in the handler.
    if (pathname.startsWith("/api/gitea")) {
      const response = await ctx.giteaApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // ngit API — NIP-34 git repository operations (publish, push state, list).
    // No auth gate: requests are validated by session ID and grants in the handler.
    if (pathname.startsWith("/api/ngit")) {
      const response = await ctx.ngitApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (isAgentChatApiPath(pathname)) {
      const agentChatAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, agentChatAuthContext);
      if (denied) {
        return denied;
      }
      if (!ctx.agentChatApiContext) {
        return Response.json({ error: 'agent-chat-unavailable' }, { status: 503 });
      }
      const response = await handleAgentChatApi(
        request,
        url,
        method === 'GET' || method === 'POST' || method === 'PATCH' || method === 'DELETE' ? method : 'GET',
        agentChatAuthContext,
        {
          ...ctx.agentChatApiContext,
          agentTypes: resolveAgentModelCatalogue(
            ctx.config.agents,
            ctx.instanceSettingsRoutesContext.service.get(MODEL_PROVIDERS_SETTING_KEY),
          ),
        },
      );
      if (response) {
        return response;
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    // MCP Wingman Action API — called by the MCP stdio server running inside agents.
    // Keep the whole surface host-local. Flight Deck is additionally bound to
    // the caller's opaque session capability because it exposes dispatch
    // context and can perform Tower writes with the stored bot identity.
    if (pathname.startsWith("/api/mcp/wingman")) {
      if (!isLocalhostRequest(request, ctx)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      if (pathname === "/api/mcp/wingman/flightdeck") {
        if (!ctx.capabilityBrokerApiHandler) {
          return Response.json({ error: "Capability broker is not configured" }, { status: 503 });
        }
        const body = await request.clone().json().catch(() => ({})) as { sessionId?: unknown };
        const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        if (!sessionId) {
          return Response.json({ error: "sessionId is required" }, { status: 400 });
        }
        const identityUrl = new URL("/api/mcp/capabilities/identity", url);
        identityUrl.searchParams.set("sessionId", sessionId);
        const identityRequest = new Request(identityUrl.toString(), {
          method: "GET",
          headers: {
            authorization: request.headers.get("authorization") ?? "",
            "x-wingman-capability-nonce": request.headers.get("x-wingman-capability-nonce") ?? "",
          },
        });
        const identityResponse = await ctx.capabilityBrokerApiHandler(identityRequest, identityUrl, "GET");
        if (!identityResponse?.ok) {
          return identityResponse ?? Response.json({ error: "Capability validation failed" }, { status: 403 });
        }
      }
      const response = await ctx.wingmanMcpApiHandler(request, url, method);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (pathname.startsWith("/api/caprover")) {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.DeploymentsManage, request, url, authContext);
      if (denied) {
        return denied;
      }
      const response = await ctx.caproverApiHandler(request, url, method, authContext);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // Private chat API routes
    if (pathname.startsWith("/api/chats") || pathname === "/api/maple/models") {
      if (!authContext.session) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      const chatContext = ctx.buildChatContext(viewerNpub, viewerIsAdmin);
      const response = await handleChatApi(request, url, method, chatContext);
      if (response) {
        return response;
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // System routes (delegated to system-routes.ts)
    if (pathname.startsWith("/api/system/")) {
      const systemResponse = await handleSystemRoutes(request, url, method, authContext, ctx.systemRoutesContext);
      if (systemResponse) {
        return systemResponse;
      }
    }

    // Auth routes (delegated to auth-routes.ts)
    if (pathname.startsWith("/api/auth/") || pathname === "/api/identity/profile") {
      const authResult = await handleAuthApi(request, url, method, authContext, ctx.authApiContext);
      if (authResult) return authResult;
    }

    // Admin user routes (delegated to admin-users-routes.ts)
    if (pathname.startsWith("/api/admin/users") || pathname === "/api/admin/ports") {
      const adminUsersResponse = await handleAdminUsersApi(request, url, method, authContext, ctx.adminUsersApiContext);
      if (adminUsersResponse) return adminUsersResponse;
    }

    if (
      pathname === "/api/apps/starter-projects" ||
      pathname === "/api/apps/starter-projects/launch" ||
      pathname === "/api/admin/starter-projects" ||
      pathname.startsWith("/api/admin/starter-projects/")
    ) {
      const starterProjectsCtx = ctx.buildStarterProjectsContext(workspaceScope, viewerNpub);
      const starterProjectsResponse = await handleStarterProjectsApi(request, url, method, authContext, starterProjectsCtx);
      if (starterProjectsResponse) return starterProjectsResponse;
    }

    if (pathname === "/api/workspace/tree" || pathname === "/api/apps" || pathname.startsWith("/api/apps/")) {
      const appsAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);

      const appsCtx = ctx.buildAppsContext(appsAuthContext);
      const appsApiResponse = await runWithRequestContext(
        appsAuthContext,
        () => handleAppsApi(request, url, method, appsAuthContext, appsCtx),
      );
      if (appsApiResponse) return appsApiResponse;
    }

    if (pathname === "/api/config" && method === "GET") {
      // Authenticated only — unauthenticated visitors receive branding via
      // the boot config injected into index.html at serve time.
      // Localhost is trusted for internal MCP tooling (e.g. gitea_info).
      if (!authContext.session && !authContext.npub && !isLocalhostRequest(request, ctx)) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      const instanceSettings = ctx.instanceSettingsRoutesContext.service;
      const modelProviderSetting = instanceSettings.get(MODEL_PROVIDERS_SETTING_KEY);
      const defaultAgent = resolveViewerDefaultAgent(ctx, viewerNpub);
      const agents = resolveAgentModelCatalogue(ctx.config.agents, modelProviderSetting);
      return Response.json({
        branding: {
          name: instanceSettings.get("branding.name")?.trim() || "Wingman",
          highlightColor: instanceSettings.get("branding.highlight_color")?.trim() || "#10b981",
        },
        port: ctx.config.port,
        baseUrl: ctx.config.baseUrl,
        agentPortStart: ctx.config.agentPortStart,
        agentPortMax: ctx.config.agentPortMax,
        hostUrlBase: ctx.config.hostUrlBase,
        appRoutingMode: ctx.config.appRoutingMode,
        subdomainBaseDomain: ctx.config.subdomainBaseDomain,
        subdomainProxyEnabled: ctx.config.subdomainProxyEnabled,
        defaultDirectory: workspaceScope.defaultDirectory,
        allowedDirectories: workspaceScope.allowedDirectories,
        connectRelays: ctx.config.connectRelays,
        adminNpub: ctx.adminNpub,
        adminNpubs: ctx.adminNpubs ?? (ctx.adminNpub ? [ctx.adminNpub] : []),
        agents,
        defaultAgent,
        systemDefaultAgent: ctx.config.defaultAgent,
        featureFlags: ctx.serialiseFeatureFlagsForViewer(workspaceScope.isAdmin),
        giteaUrl: ctx.config.giteaUrl ?? null,
        terminalConfigured: ctx.terminalRoutesContext?.pinService.isConfigured() ?? false,
      });
    }

    // Feature flag routes (delegated to feature-flags-routes.ts)
    if (pathname.startsWith("/api/feature-flags")) {
      const featureFlagsCtx = ctx.buildFeatureFlagsContext(workspaceScope.isAdmin);
      const ffResult = await handleFeatureFlagsApi(request, url, method, authContext, featureFlagsCtx);
      if (ffResult) return ffResult;
    }

    if (
      pathname === "/api/delegations" ||
      pathname.startsWith("/api/delegations/") ||
      pathname.endsWith("/delegations")
    ) {
      const delegationAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);
      const delegationResult = await runWithRequestContext(
        delegationAuthContext,
        () => handleDelegationApi(request, url, method, delegationAuthContext, ctx.delegationRoutesContext),
      );
      if (delegationResult) return delegationResult;
    }

    if (pathname.startsWith("/api/owners/")) {
      const ownerAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);
      const ownerSpaceResult = await runWithRequestContext(
        ownerAuthContext,
        () =>
          handleOwnerSpaceApi(request, url, method, ownerAuthContext, {
            workspaceDelegationStore: ctx.workspaceDelegationStore,
            resolveWorkspace: ctx.resolveWorkspace,
            buildAppsContext: ctx.buildAppsContext,
            docsApiContext: ctx.docsApiContext,
            listDirectories: ctx.listDirectories,
            createDirectoryEntry: ctx.createDirectoryEntry,
            schedulerStore: ctx.schedulerStore,
            schedulerApiHandler: ctx.schedulerApiHandler,
            ensureSessionsAccess: (schedulerRequest, schedulerUrl, schedulerAuthContext) =>
              ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, schedulerRequest, schedulerUrl, schedulerAuthContext),
            buildWappsContext: ctx.buildWappsContext,
            agentChatApiContext: ctx.agentChatApiContext
              ? {
                  ...ctx.agentChatApiContext,
                  agentTypes: resolveAgentModelCatalogue(
                    ctx.config.agents,
                    ctx.instanceSettingsRoutesContext.service.get(MODEL_PROVIDERS_SETTING_KEY),
                  ),
                }
              : undefined,
            auditExecution: ctx.auditExecution,
          }),
      );
      if (ownerSpaceResult) return ownerSpaceResult;
    }

    // Docs/files API routes (delegated to docs-routes.ts)
    if (pathname.startsWith("/api/docs/")) {
      const docsAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);
      const docsApiResponse = await runWithRequestContext(
        docsAuthContext,
        () => handleDocsApi(request, url, method, docsAuthContext, ctx.docsApiContext),
      );
      if (docsApiResponse) return docsApiResponse;
    }

    if (pathname === "/api/directories" && method === "GET") {
      const directoriesAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesRead, request, url, directoriesAuthContext);
      if (denied) {
        return denied;
      }
      try {
        const data = await ctx.listDirectories(
          url.searchParams.get("path"),
          url.searchParams.get("query") ?? undefined,
          ctx.resolveWorkspace(directoriesAuthContext),
        );
        return Response.json(data);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    if (pathname === "/api/directories" && method === "POST") {
      const directoriesAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, url, directoriesAuthContext);
      if (denied) {
        return denied;
      }
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }

      if (!payload || typeof payload !== "object") {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }

      const parentInput = (payload as Record<string, unknown>).parent;
      const nameInput = (payload as Record<string, unknown>).name;

      try {
        const data = await ctx.createDirectoryEntry(
          typeof parentInput === "string" ? parentInput : null,
          nameInput,
          ctx.resolveWorkspace(directoriesAuthContext),
        );
        return Response.json(data, { status: 201 });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    // Upload API routes (delegated to upload-routes.ts)
    if (pathname.startsWith("/api/uploads/")) {
      const voiceNoteResult = await handleVoiceNoteUploadsApi(
        request,
        url,
        method,
        authContext,
        ctx.voiceNoteUploadApiContext,
      );
      if (voiceNoteResult) return voiceNoteResult;

      const uploadResult = await handleUploadsApi(request, url, method, authContext, ctx.uploadApiContext);
      if (uploadResult) return uploadResult;
    }

    // Session, delegate-session, and archive API routes (delegated to session-api-routes.ts)
    if (
      pathname.startsWith("/api/archive") ||
      pathname.startsWith("/api/sessions") ||
      pathname.startsWith("/api/delegate-sessions") ||
      (pathname.startsWith("/api/owners/") && pathname.includes("/sessions"))
    ) {
      const sessionAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);
      const sessionApiResponse = await runWithRequestContext(
        sessionAuthContext,
        () => handleSessionApi(request, url, method, sessionAuthContext, ctx.sessionApiContext),
      );
      if (sessionApiResponse) return sessionApiResponse;
    }

    // POST /api/sessions is handled by sessionApiContext above

    // GET /api/artifacts/:id/raw — Serve artifact file content
    if (pathname.startsWith("/api/artifacts/") && method === "GET") {
      const artParts = pathname.split("/");
      const artifactId = artParts[3];
      if (artifactId && artParts[4] === "raw") {
        const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
        if (denied) return denied;

        const artifact = ctx.artifactsStore.get(artifactId);
        if (!artifact) {
          return Response.json({ error: "Artifact not found" }, { status: 404 });
        }

        try {
          const file = Bun.file(artifact.filePath);
          if (!(await file.exists())) {
            return Response.json({ error: "Artifact file not found on disk" }, { status: 404 });
          }
          return new Response(file, {
            headers: {
              "Content-Type": artifact.mimeType || "application/octet-stream",
              "Cache-Control": "private, max-age=3600",
            },
          });
        } catch {
          return Response.json({ error: "Failed to read artifact file" }, { status: 500 });
        }
      }
    }

    if (pathname.startsWith("/api/user/settings")) {
      const userSettingsResponse = await handleUserSettingsApi(
        request,
        url,
        method,
        authContext,
        ctx.userSettingsRoutesContext,
      );
      if (userSettingsResponse) return userSettingsResponse;
    }

    // /api/sessions/:id/* routes are handled by sessionApiContext above

    return Response.json({ error: "Not found" }, { status: 404 });
  };
}
