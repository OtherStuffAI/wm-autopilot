import { randomUUID, timingSafeEqual } from "node:crypto";
import { type Dirent } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import "./logging/server-logger";

import { AGENT_TYPES as SUPPORTED_AGENT_TYPES, isAgentType, type AgentType } from "./agent-types";
import { z } from "zod";
import { 
  validateInput, 
  NpubSchema, 
  SessionIdSchema, 
  PathSchema, 
  LimitSchema, 
  OffsetSchema, 
  FilterSchema,
  ArchiveListOptionsSchema,
  JsonRequestSchema
} from "./utils/validation";
import { loadConfig } from "./config";
import { ProcessManager } from "./agents/process-manager";
import { createBrokerKeyVaultBackend } from "./signing/broker-key-vault";
import { createProfileBotIdentityRunner } from "./agent-chat/profile-bot-identity";
import { AgentProfileKeyRotation } from "./agent-chat/agent-profile-key-rotation";
import { createDirectChatProfileIdentityRunner } from "./agent-chat/direct-chat-profile-identity";
import { ensureLegacyBrokerRecordProvisioned } from "./signing/broker-vault-migration";
import type { SessionOrigin, SessionSnapshot } from "./agents/process-manager";
import {
  appRegistry,
  type AppLifecycleAction,
  type AppLifecycleScripts,
  type AppRecord,
} from "./apps/app-registry";
import { redactAppEnv } from "./apps/app-env";
import { createTrustedExecutionRule, type ExecutionAuditEntry } from "./auth/trusted-execution";
import { hasWappActivityAuthority } from "./auth/wapp-activity-authority";
import { appCommand, validateAppCommand } from "./apps/app-command";
import { appAliasRegistry } from "./apps/app-alias-registry";
import { appDomainRegistry, type AppDomainRecord } from "./apps/app-domain-registry";
import {
  appProcessManager,
  type AppProcessStatus,
} from "./apps/app-process-manager";
import { scanDirectoryTree } from "./apps/app-detector";
import { resolveStarterAppDirectory } from "./apps/starter-directory";

/** Tmux session for the Wingman core process (used by warm restart manager). */
const WINGMAN_CORE_TMUX_SESSION = "wingman-apps";
import { messageStore } from "./storage/message-store";
import type { SessionMetadataInput } from "./sessions/session-metadata";
import { scheduleSessionArchive, cancelPendingArchive } from "./storage/session-archiver";
import { sessionArchiveStore } from "./storage/session-archive-store";
import { cleanupStopNextActionSessions } from "./sessions/next-action-cleanup";
import { isDirectChatSessionProtected } from "./agent-chat/direct-chat-lifecycle";
import { chatInterceptStateStore } from "./agent-chat/chat-intercept-state-store";
import { createFlightDeckTriggerResolver } from "./agent-chat/flightdeck-trigger-resolver";
import { directChatTurnStore } from "./agent-chat/direct-chat-turn-store";
import { flightDeckDispatchOutcomeStore } from "./agent-chat/flightdeck-dispatch-outcome-store";
import { PromptQueueStore } from "./storage/prompt-queue-store";
import { SessionDispatchStore } from "./session-dispatch/session-dispatch-store";
import { SessionDispatchService } from "./session-dispatch/session-dispatch-service";
import { SessionDispatchInboxCoordinator, resolveDispatchInboxWakePolicy } from "./session-dispatch/session-dispatch-inbox";
import { closeDispatchedWorker } from "./session-dispatch/dispatched-worker-closeout";
import { fileWatcherStore } from "./storage/file-watcher-store";
import {
  featureFlagStore,
  normaliseFeatureFlagKey,
  resolveFeatureFlagEffectiveState,
  type FeatureFlagState,
} from "./storage/feature-flag-store";
import { starterProjectStore } from "./storage/starter-project-store";
import { WorkspaceDelegationStore } from "./storage/workspace-delegation-store";
import { FileWatcherRunner } from "./watchers/file-watcher-runner";
import { identityUserStore } from "./storage/identity-user-store";
import { TodoStore } from "./todos/todo-store";
import { createTodoApiHandler } from "./todos/todo-api";
import { ProjectStore } from "./projects/project-store";
import { createProjectApiHandler } from "./projects/project-api";
import { createNpubProjectApiHandler } from "./projects/npub-project-api";
import { npubProjectStore } from "./projects/npub-project-store";
import {
  CaproverStore,
  createCaproverApiHandler,
  createCaproverClientFromEnv,
  createCaproverTargetClientsFromEnv,
  createAppTarball,
} from "./caprover";
import { createCloudflareTunnelClientFromEnv } from "./cloudflare/tunnel-hostnames";
import { NightWatchStore } from "./nightwatch/nightwatch-store";
import { maybeTriggerNightWatch } from "./nightwatch/nightwatch-engine";
import {
  ensureManagedFeatureFlags,
  PIPELINE_AGENT_OUTPUT_FORMATTING_FLAG_KEY,
  PROJECTS_FLAG_KEY,
} from "./server/managed-feature-flags";
import { createNightWatchApiHandler } from "./nightwatch/nightwatch-api";
import { createAccessGrantListener, type AccessGrantListener } from "./nostr/access-grant-listener";
import { createBrowserLogHandler } from "./logging/browser-log-handler";
import { Nip98GrantStore } from "./mcp/grants-store";
import { createNip98ApiHandler } from "./mcp/nip98-api";
import { createWingmanMcpApiHandler } from "./mcp/wingman-api";
import { createNgitApiHandler } from "./ngit/ngit-api";
import { createGiteaApiHandler } from "./gitea/gitea-api";
import { createGitWorkflowApiHandler } from "./gitea/git-workflow-api";
import { ensureGiteaUser } from "./gitea/gitea-user-manager";
import { GitHubApiClient, getGitHubCredentialsForNpub } from "./git/github-api";
import { getGitHubGitEnvForUser } from "./git/github-credential-helper";
import { BotKeyStore } from "./identity/bot-key-store";
import { createBotKeyApiHandler } from "./identity/bot-key-api";
import { createBotCryptoApiHandler } from "./identity/bot-crypto-api";
import { signBotProfileEvent } from "./identity/bot-identity-publisher";
import { publishBotProfileEvent } from "./identity/bot-profile-publisher";
import { loadWingmanInstanceIdentity } from "./identity/wingman-instance-identity";
import { CapabilityBroker, buildDefaultAgentCapabilityPolicy } from "./signing/capability-broker";
import { FileCapabilityBrokerStateStore } from "./signing/capability-state-store";
import { writeServerLog } from "./logging/server-logger";
import { HttpTowerWappRegistrar } from "./wapps/tower-registration";
import { InstallationIntentConsumer } from "./wapps/installation-intent-consumer";
import { isAgentDispatchAdminOnlyEnabled, isSharedAgentDispatchEnabled, isSharedInstanceAccessEnabled } from "./shared-instance";
import { WorkspaceSubscriptionManager } from './agent-chat/subscription-runtime';
import { agentDefinitionStore } from './agent-chat/agent-definition-store';
import { resolveAndBindSessionCapabilityBotRecord } from './agents/session-capability-binding';
import { DispatchPipelineRuntime } from './agent-chat/dispatch-pipelines/runtime';
import { AgentCommentSessionRuntime } from './agent-chat/comment-session-runtime';
import { AgentChatSessionRuntime } from './agent-chat/session-runtime';
import { FlightDeckSessionTurnBridge } from './agent-chat/flightdeck-session-turn-bridge';
import { AgentDirectDeliveryReconciler } from './agent-chat/direct-chat-delivery-reconciler';
import {
  DuplicateCallbackPublicationDecisionStore,
  DuplicateCallbackPublicationFilter,
} from './agent-chat/duplicate-callback-publication-filter';
import { AgentWorkSessionRuntime } from './agent-work/session-runtime';
import { TaskDirectRuntime } from './agent-chat/task-direct-runtime';
import { DocumentDirectRuntime, DocumentDirectStore } from './agent-chat/document-direct-runtime';
import { AgentWorkSessionIdleRetention } from './agent-work/session-idle-retention';
import { MemoryStore } from "./mcp/memory-store";
import { userSettingsStore } from "./storage/user-settings-store";
import { artifactsStore } from "./storage/artifacts-store";
import { resumeRunningPipelineRuns } from "./pipelines/pipeline-api-routes";
import { type JsonObject, PipelineStore } from "./pipelines/pipeline-store";
import { getPipelineDefinition } from "./pipelines/pipeline-loader";
import { loadPipelineFunctionRegistry } from "./pipelines/function-loader";
import { builtinPipelineFunctions } from "./pipelines/functions";
import { runDeclarativePipeline } from "./pipelines/pipeline-runner";
import {
  buildAgentUrl,
  normaliseHostForUrl,
  parseAllowedHosts,
  pickAgentHost,
} from "./agents/agent-client";
import { AgentRuntimeStatusPoller } from "./agents/agent-status-poller";
import { LiveMessagePersistenceLoop } from "./server/live-message-persistence";
import { LiveSessionMessageSync } from "./server/live-session-message-sync";
import { SessionMessageUpdates } from "./server/session-message-updates";
import { getSessionCookieName, mintSessionCookie, SessionCookieError, SESSION_COOKIE_NAME } from "./auth/session-cookie";
import { LoginChallengeStore } from "./auth/login-challenge-store";
import {
  resolveRequestAuthContext,
  runWithRequestContext,
  getRequestContext,
  type RequestAuthContext,
} from "./auth/request-context";
import { getEffectiveOwnerAuthContext, getEffectiveOwnerNpub } from "./auth/effective-owner";
import { resolveNip98AuthContext } from "./auth/nip98-auth";
import { Nip98ReplayCache, verifyNip98Request } from "./auth/nip98-verifier";
import { deriveNpubSegment, isNpubInList, normaliseNpub, normaliseNpubList } from "./identity/npub-utils";
import { generateIdentityAlias } from "./identity/identity-alias";
import { resolveSessionOwnerNpub, sessionBelongsToViewer as sessionOwnerMatchesViewer } from "./sessions/session-ownership";
import { resolveWorkspaceScope, type WorkspaceScope } from "./workspaces/workspace-scope";
import {
  AccessActions,
  allow,
  deny,
  evaluateAccess,
  registerAccessRule,
  requireAuthentication,
  type AccessAction,
  type AccessDecision,
  type AccessRule,
} from "./auth/access-control";
import { handleKeyTeleport, handleKeyTeleportRegistration } from "./auth/keyteleport";
import { secureResolvePath, validatePathSegment, sanitizePath } from "./server/path-security.js";
import {
  MAX_DIRECTORY_RESULTS,
  DIRECTORY_BROWSER_ROOT,
  expandHomeDirectory,
  formatHomeRelativePath,
  formatRootDirectoryName,
  ensureWithinBase,
  createPathUtils,
} from "./server/path-utils";
import { createProjectStaticAssetService } from "./server/static-assets";
import { createStaticRouteHandler } from "./server/static-routes";
import { maybeRefreshSessionCookie } from "./server/session-refresh";
import { shouldUseSecureCookies } from "./server/cookie-security";
import {
  configuredPublicRequestUrl,
  forwardedRequestUrl,
  redirectInsecurePublicRequest,
} from "./server/request-url";
import { handleAppHostRequest, resolveAliasToPort, proxyRequestToApp, type SubdomainProxyConfig } from "./server/subdomain-proxy";
import { isAgentRuntimeStatus } from "./types/agent-status";
import { scheduleCleanup } from "./uploads/cleanup";
import { createSessionEventsHandler } from "./server/session-events";
import { sessionBroadcaster, createSessionSubscribeResponse } from "./server/session-broadcaster";
import { type ChatApiContext } from "./server/chat-routes";
import { type SessionApiContext } from "./server/session-api-routes";
import { parseNightWatchStartOptions } from "./nightwatch/nightwatch-start-config";
import { type ProviderProxyApiContext } from "./server/provider-proxy-routes";
import { type BillingApiContext } from "./server/billing-routes";
import { type DocsApiContext } from "./server/docs-routes";
import { type AdminUsersApiContext } from "./server/admin-users-routes";
import { type AuthApiContext } from "./server/auth-routes";
import {
  serialiseFeatureFlagsForViewer,
} from "./server/feature-flags-routes";
import {
  resolveTempImage,
  resolveTempAttachment,
  type UploadApiContext,
} from "./server/upload-routes";
import { performSystemCleanup } from "./server/system-cleanup.js";
import { type SystemRoutesContext } from "./server/system-routes";
import { createApiRouteHandler } from "./server/api-routes";
import { type RemoteInstructRoutesContext } from "./server/remote-instruct-routes";
import { instanceSettingsService } from "./settings/instance-settings-service";
import { instanceSettingsStore } from "./storage/instance-settings-store";
import {
  handleTerminalWebSocketUpgrade,
} from "./server/terminal-websocket";
import { handleAppWebSocketUpgrade, type AppWebSocketUpgradeServer } from "./server/app-websocket-proxy";
import { createWingmanWebSocketHandler, type WingmanWebSocketData } from "./server/websocket-handler";
import { ensureAgentApiBinary } from "./server/bootstrap/agentapi";
import { SchedulerStore } from "./scheduler/scheduler-store";
import { SchedulerEngine } from "./scheduler/scheduler-engine";
import { requireSuccessfulPipelineExecution } from "./scheduler/pipeline-execution-result";
import { createSchedulerApiHandler } from "./scheduler/scheduler-api";
import { wappStore } from "./wapps/wapp-store";
import { backendConnectionStore } from "./agent-chat/backend-connection-store";
import { TowerPgWappPublisher } from "./wapps/wapp-publisher";
import { createWappSourceAppNpubResolver } from "./wapps/wapp-publish-target";
import { FlightDeckScopeAccessResolver } from "./wapps/scope-access";
import { createBoardClient } from "./board/yoke-board";
import {
  clearWarmRestartMarker,
  loadWarmRestartMarker,
  rehydrateWarmSessions,
  restoreRestartedSessions,
  warmRestartOutcome,
  warmRestartState,
  writeWarmRestartMarker,
} from "./server/bootstrap/warm-restart";
import type { WarmRestartMarker } from "./server/bootstrap/warm-restart";
import { resolveTerminalConfig } from "./terminal/terminal-config";
import { TerminalSessionManager } from "./terminal/terminal-session-manager";
import { TerminalTicketStore } from "./terminal/terminal-ticket-store";
import { TerminalPinService } from "./terminal/terminal-pin-service";
import { TerminalPinRateLimiter } from "./terminal/terminal-pin-rate-limiter";
import { reconcileAppsWithPM2 } from "./server/bootstrap/pm2-reconcile";
import { autostartApps } from "./server/bootstrap/app-autostart";
import { cleanupOrphanedAgentProcesses } from "./server/bootstrap/pm2-agent-cleanup";
import { ensureWingmanCoreRegistration } from "./server/bootstrap/wingman-core-registry";
import { connectPM2 } from "./agents/pm2-wrapper";
import { createUploadHelpers } from "./server/uploads/helpers";
import { resolveAndCacheNostrProfile } from "./server/nostr-profile";
import { AgentProfileMetadataCache } from './agent-chat/agent-profile-metadata-cache';
import { waitForSessionPromptReadiness } from "./server/session-readiness";
import { getSessionPromptReadiness } from "./server/prompt-readiness";
import { createPromptDispatchEngine, QueueDispatchError } from "./server/prompt-dispatch";
import { TeamBillingService } from "./billing/team-billing-service";
import {
  validateForkInput,
  getRecentMessages,
  formatMessagesAsContext,
} from "./sessions/fork-to-worktree";
import { forkCodexSessionFile } from "./agents/codex-session-fork";
import {
  type CommandResult,
  type GitRepositorySummary,
  type GitWorktreeSummary,
  type GitCommandAction,
  type CreateWorktreeOptions,
  type CreateWorktreeResult,
  runCommand,
  resolveRealPath,
  executeGitCommand,
  describeGitRepository,
  ensureBranchNameValid,
  branchExists,
  ensureStartPointResolvable,
  createGitWorktree,
} from "./server/git-operations";

const instanceSettingsAutoImport = instanceSettingsService.autoImportMissing(process.env);
if (instanceSettingsAutoImport.imported.length > 0) {
  console.log(
    `[settings] imported ${instanceSettingsAutoImport.imported.length} environment setting(s) into encrypted instance settings`,
  );
}

const config = loadConfig();
const wingmanInstanceIdentity = loadWingmanInstanceIdentity();
const defaultTowerUrl = (
  instanceSettingsService.get("internal.wapp_tower_url") ||
  "http://127.0.0.1:3100"
).replace(/\/$/, "");
const towerWappRegistrar = new HttpTowerWappRegistrar();
const towerRegistrationIdentity = wingmanInstanceIdentity
  ? {
    botNpub: wingmanInstanceIdentity.npub,
    botPubkeyHex: wingmanInstanceIdentity.pubkeyHex,
    botSecret: wingmanInstanceIdentity.secretKey,
  }
  : null;
const installationIntentConsumer = towerRegistrationIdentity ? new InstallationIntentConsumer({
  towerUrl: defaultTowerUrl,
  autopilotOrigin: new URL(config.baseUrl).origin,
  identity: towerRegistrationIdentity,
  appRegistry,
  appAliasRegistry,
  wappStore,
  buildLaunchUrl: (alias, app) => {
    const aliasUrl = buildAppHostUrl(alias);
    if (aliasUrl) return aliasUrl.startsWith("http") ? aliasUrl : new URL(aliasUrl, config.baseUrl).toString();
    return app.webApp && app.webAppPort ? buildHostedWebAppUrl(app.webAppPort) ?? config.baseUrl : config.baseUrl;
  },
}) : null;
writeServerLog("INFO", "[wapp-install-intent] consumer initialized", {
  enabled: Boolean(installationIntentConsumer),
  workspaceIds: wappStore.listTowerBindings().map((binding) => binding.workspaceId).filter(Boolean),
});
if (installationIntentConsumer) {
  setTimeout(() => {
    const workspaceIds = [...new Set(wappStore.listTowerBindings().map((binding) => binding.workspaceId).filter((value): value is string => Boolean(value)))];
    if (workspaceIds.length === 0) return;
    void installationIntentConsumer.reconcile(workspaceIds)
      .then((results) => {
        writeServerLog("INFO", "[wapp-install-intent] startup reconciliation completed", { workspaceIds, results });
      })
      .catch((error) => {
        writeServerLog("ERROR", "[wapp-install-intent] startup reconciliation failed", { message: (error as Error).message });
      });
  }, 1_000);
}

function resolveScheduledPipelineAgent(
  requestedAgent: string | null | undefined,
  definitionDefaultAgent: string | null | undefined,
): AgentType {
  const fromTrigger = typeof requestedAgent === "string" ? requestedAgent.trim().toLowerCase() : "";
  if (fromTrigger && isAgentType(fromTrigger)) {
    return fromTrigger;
  }

  const fromDefinition = typeof definitionDefaultAgent === "string" ? definitionDefaultAgent.trim().toLowerCase() : "";
  if (fromDefinition && isAgentType(fromDefinition)) {
    return fromDefinition;
  }

  return config.defaultAgent;
}
const wappScopeAccessResolver = new FlightDeckScopeAccessResolver(async (input) => {
  const board = createBoardClient(input.appRoot ?? config.defaultWorkingDirectory);
  return await board.getScopeAccess(input.scopeId);
});
if (wingmanInstanceIdentity) {
  console.log(`[identity] Wingman instance identity configured: ${wingmanInstanceIdentity.npub.slice(0, 20)}...`);
} else {
  console.warn("[identity] WINGMAN_PRIV not configured; shared Wingman bot identity is missing");
}
appProcessManager.configureTowerRegistration({
  identity: towerRegistrationIdentity,
  registrar: towerWappRegistrar,
});
const migratedUserSettingCount = userSettingsStore.migrateSensitiveValues();
if (migratedUserSettingCount > 0) {
  console.log(`[config] migrated ${migratedUserSettingCount} sensitive user setting(s) to encrypted storage`);
}
const configuredAdminNpubs = normaliseNpubList(
  instanceSettingsService.get("identity.admin_npubs") ?? "",
);
const adminNpub = configuredAdminNpubs[0] ?? null;
const wappPublisher = new TowerPgWappPublisher({
  defaultTowerUrl,
  authority: towerRegistrationIdentity,
  resolveSourceAppNpub: createWappSourceAppNpubResolver(backendConnectionStore),
});
const isConfiguredAdminNpub = (npub: string | null | undefined): boolean => isNpubInList(npub, configuredAdminNpubs);
const APPROVED_WORK_ROLES = new Set(["approved", "onboard"]);
const agentDispatchAdminOnlyEnabled = isAgentDispatchAdminOnlyEnabled();

const isUserApprovedForWork = (npub: string | null | undefined): boolean => {
  const normalized = normaliseNpub(npub ?? null);
  if (!normalized) {
    return false;
  }
  if (isConfiguredAdminNpub(normalized)) {
    return true;
  }
  const record = identityUserStore.getByNormalized(normalized);
  return Boolean(record?.roles.some((role) => APPROVED_WORK_ROLES.has(role)));
};

const isTrustedAgentDispatchActor = (npub: string | null | undefined): boolean => {
  const normalized = normaliseNpub(npub ?? null);
  if (!normalized) {
    return false;
  }
  return agentDispatchAdminOnlyEnabled
    ? isConfiguredAdminNpub(normalized)
    : isUserApprovedForWork(normalized);
};
const agentHosts = parseAllowedHosts(config.allowedHosts);
const agentHost = normaliseHostForUrl(pickAgentHost(agentHosts));

// Subdomain proxy configuration
const subdomainProxyConfig: SubdomainProxyConfig = {
  baseDomain: config.subdomainBaseDomain,
  enabled: config.subdomainProxyEnabled,
};

if (subdomainProxyConfig.enabled) {
  console.log(`[subdomain-proxy] Enabled for base domain: ${subdomainProxyConfig.baseDomain}`);
}

/**
 * Handle path-based app routing (/host/<alias> and /host/<alias>/*).
 * Extracts alias from path and proxies to the app's local port.
 */
const handlePathBasedAppRequest = async (
  request: Request,
  pathname: string,
  requestServer: AppWebSocketUpgradeServer,
): Promise<Response | null> => {
  // Extract alias from path: /host/<alias> or /host/<alias>/...
  const pathParts = pathname.split("/").filter(Boolean);
  if (pathParts.length < 2 || pathParts[0] !== "host") {
    return null;
  }

  const alias = pathParts[1];
  if (!alias) {
    return null;
  }

  // Redirect /host/<alias> to /host/<alias>/ to ensure correct relative path resolution
  // Without trailing slash, browser resolves ./logo.png to /host/logo.png instead of /host/<alias>/logo.png
  if (pathParts.length === 2 && !pathname.endsWith("/") && request.method === "GET") {
    const url = new URL(request.url);
    return Response.redirect(`${url.origin}${pathname}/${url.search}`, 302);
  }

  // Resolve alias to port
  const resolved = await resolveAliasToPort(alias);
  if (!resolved.success) {
    const errorMessages: Record<string, string> = {
      alias_not_found: `No app registered for alias "${alias}".`,
      app_not_found: `App ID ${resolved.appId} not found in registry.`,
      app_not_running: `App is not running (status: ${resolved.status}).`,
      port_not_registered: `App is running but port not detected. Try restarting the app.`,
      invalid_runtime_port: `App resolved to an invalid runtime port (${resolved.port}). Restart the app so its assigned port can be registered.`,
    };
    console.warn(`[path-proxy] ${alias}: ${resolved.reason}`, resolved);
    return new Response(
      JSON.stringify({
        error: "App not available",
        reason: resolved.reason,
        message: errorMessages[resolved.reason],
        alias,
        appId: resolved.appId,
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Rewrite the path to remove /host/<alias> prefix
  const remainingPath = "/" + pathParts.slice(2).join("/");
  const url = new URL(request.url);
  const rewrittenUrl = new URL(remainingPath + url.search, request.url);

  // Create a new request with the rewritten path
  const rewrittenRequest = new Request(rewrittenUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    duplex: "half",
  });

  // Check for WebSocket upgrade
  const upgradeHeader = request.headers.get("upgrade");
  if (upgradeHeader?.toLowerCase() === "websocket") {
    return handleAppWebSocketUpgrade(rewrittenRequest, resolved.port, requestServer) ?? null;
  }

  return proxyRequestToApp(rewrittenRequest, resolved.port);
};
ensureManagedFeatureFlags(featureFlagStore);
process.env.WINGMAN_PID = process.pid.toString();
const projectStore = new ProjectStore();
const todoStore = new TodoStore();
const promptQueueStore = new PromptQueueStore("data/prompt-queue.db");
const sessionDispatchStore = new SessionDispatchStore("data/session-dispatches.db");
const sessionDispatchInbox = new SessionDispatchInboxCoordinator(
  sessionDispatchStore,
  resolveDispatchInboxWakePolicy(Bun.env),
);
sessionDispatchInbox.migrateLegacyCallbacks(promptQueueStore);
const pipelineStore = new PipelineStore();
const todoApiHandler = createTodoApiHandler({ store: todoStore, projectStore });
const projectApiHandler = createProjectApiHandler({
  store: projectStore,
  getAppById: (id) => appRegistry.getApp(id),
});
const npubProjectApiHandler = createNpubProjectApiHandler();
const browserLogHandler = createBrowserLogHandler();
const caproverStore = new CaproverStore();
const caproverApiHandler = createCaproverApiHandler({
  store: caproverStore,
  getClient: createCaproverClientFromEnv,
  getTargets: createCaproverTargetClientsFromEnv,
});
const nightWatchStore = new NightWatchStore();
const nightWatchApiHandler = createNightWatchApiHandler({
  store: nightWatchStore,
  featureFlagStore,
});
const botKeyStore = new BotKeyStore();
const brokerKeyVault = createBrokerKeyVaultBackend();
const capabilityStateStore = new FileCapabilityBrokerStateStore(
  Bun.env.WINGMAN_CAPABILITY_STATE_FILE?.trim() || new URL("../data/capability-broker-state.json", import.meta.url).pathname,
);
for (const record of botKeyStore.listActiveKeys()) {
  if (brokerKeyVault.has(record)) continue;
  try {
    ensureLegacyBrokerRecordProvisioned({
      vault: brokerKeyVault,
      record,
      instanceIdentity: wingmanInstanceIdentity,
    });
    console.log(`[capability-broker] migrated stable agent identity ${record.botNpub.slice(0, 20)}… into the durable vault`);
  } catch {
    console.warn(`[capability-broker] stable agent identity ${record.botNpub.slice(0, 20)}… requires one-time vault provisioning`);
  }
}
const workspaceDelegationStore = new WorkspaceDelegationStore();
const schedulerStore = new SchedulerStore();
let accessGrantListener: AccessGrantListener | null = null;
function onBotKeyUnlockedHook(npub: string, secretKey: Uint8Array, botPubkeyHex: string): void {
  const record = botKeyStore.getActiveKeyForUser(npub);
  if (!record || record.botPubkeyHex !== botPubkeyHex) {
    throw new Error("Cannot provision broker vault for a missing or mismatched stable agent identity");
  }
  brokerKeyVault.provision(record, secretKey);
  accessGrantListener?.subscribe(npub, secretKey, botPubkeyHex);
}

const schedulerEngine = new SchedulerEngine({
  store: schedulerStore,
  createSession: (agent, dir, name, origin, targetFile, explicitNpub, metadata, model) =>
    manager.createSession(agent, dir, name, origin, targetFile, explicitNpub, metadata, model),
  addPrompt: (sid, content) => promptQueueStore.addPrompt(sid, { content }),
  dispatchPrompt: (session) => {
    void maybeAutoDispatchQueuedPrompt(session);
  },
  awaitSessionReadyForPrompt: async (session, agent) => {
    const timeoutMs = agent === "codex" ? 120000 : 60000;
    await waitForSessionPromptReadiness({
      getSession: (sessionId) => manager.getSession(sessionId) ?? null,
      getAdapter: (sessionId) => manager.getAdapter(sessionId),
      sessionId: session.id,
      host: agentHost,
      timeoutMs,
      pollIntervalMs: 250,
      requiredStablePolls: agent === "codex" ? 3 : 2,
      requestTimeoutMs: 750,
    });
    markPromptStartupReady(session.id);
  },
  runPipeline: async (job, input: JsonObject, onRunCreated, triggerAgent) => {
    if (!job.pipelineDefinitionId) {
      throw new Error("Pipeline trigger has no pipeline definition selected");
    }
    const ownerAlias = generateIdentityAlias(job.userNpub);
    const definition = await getPipelineDefinition(job.pipelineDefinitionId, ownerAlias);
    if (!definition) {
      throw new Error(`Pipeline definition not found: ${job.pipelineDefinitionId}`);
    }
    const defaultAgent = resolveScheduledPipelineAgent(triggerAgent, definition.spec.defaultAgent);
    const functions = await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions);
    const run = await runDeclarativePipeline({
      store: pipelineStore,
      sessionApiContext,
      definition,
      registry: functions.registry,
      input: mergeScheduledPipelineInput(definition.spec.input ?? {}, input),
      defaultAgent,
      ownerNpub: job.userNpub,
      ownerAlias,
      callbackOrigin: `http://127.0.0.1:${config.port}`,
      onRunCreated: (run) => onRunCreated?.(run.id),
    });
    return requireSuccessfulPipelineExecution(run);
  },
  cleanupStopNextActionSessions: async () => cleanupStopNextActionSessions({
    manager,
    scheduleArchive: (sessionId) => scheduleSessionArchive(sessionId, manager),
    isSessionProtected: (sessionId) => isDirectChatSessionProtected(sessionId, chatInterceptStateStore, directChatTurnStore),
  }),
  getInstanceIdentity: () => wingmanInstanceIdentity,
});

function mergeScheduledPipelineInput(defaultInput: JsonObject, scheduledInput: JsonObject): JsonObject {
  const merged: JsonObject = { ...defaultInput };
  for (const [key, value] of Object.entries(scheduledInput)) {
    if (value === null || value === undefined) continue;
    merged[key] = value;
  }
  return merged;
}
const schedulerApiHandler = createSchedulerApiHandler({
  store: schedulerStore,
  engine: schedulerEngine,
  getInstanceIdentity: () => wingmanInstanceIdentity,
  getActiveBotOwnerNpub: (botNpub) => botKeyStore.getActiveKeyForBotNpub(botNpub)?.userNpub ?? null,
  getNpub: (request: Request) => {
    const ctx = getRequestContext();
    if (ctx?.delegateRelationshipId && ctx.delegatedOwnerNpub) {
      return ctx.delegatedOwnerNpub;
    }
    if (ctx?.delegatedByBot && ctx.delegatedOwnerNpub) {
      return ctx.delegatedOwnerNpub;
    }
    return ctx?.npub ?? null;
  },
});
const nip98GrantsStore = new Nip98GrantStore();
const loginChallengeStore = new LoginChallengeStore();
const memoryStore = new MemoryStore();
const nip98ApiHandler = createNip98ApiHandler({
  grantsStore: nip98GrantsStore,
  getSession: (sid: string) => manager.getSession(sid) ?? null,
});
const ngitApiHandler = createNgitApiHandler({
  grantsStore: nip98GrantsStore,
  getSession: (sid: string) => manager.getSession(sid) ?? null,
  defaultRelays: config.connectRelays,
  gitea: {
    url: config.giteaUrl ?? undefined,
    apiToken: config.giteaApiToken ?? undefined,
    owner: config.giteaOwner ?? undefined,
  },
});
const botKeyApiHandler = createBotKeyApiHandler({
  store: botKeyStore,
  getSession: (sid: string) => manager.getSession(sid),
  getStoredSession: (sid: string) => messageStore.getSession(sid),
  onBotKeyUnlocked: onBotKeyUnlockedHook,
  defaultRelays: config.connectRelays,
  getInstanceIdentity: () => loadWingmanInstanceIdentity(),
  isAdminNpub: isConfiguredAdminNpub,
});
const botCryptoApiHandler = createBotCryptoApiHandler({
  getSession: (sid: string) => manager.getSession(sid),
  getStoredSession: (sid: string) => messageStore.getSession(sid),
  getInstanceIdentity: () => wingmanInstanceIdentity,
});
const wingmanDataDir = new URL("../data", import.meta.url).pathname;
const giteaApiHandler = createGiteaApiHandler({
  getSession: (sid: string) => manager.getSession(sid),
  config,
  dataDir: wingmanDataDir,
});
const gitWorkflowApiHandler = createGitWorkflowApiHandler({
  getSession: (sid: string) => manager.getSession(sid),
  config,
  dataDir: wingmanDataDir,
  executeGitCommand,
});
const workspaceSubscriptionManager = new WorkspaceSubscriptionManager({
  botKeyStore,
  brokerKeyVault,
  getInstanceIdentity: () => wingmanInstanceIdentity,
  isAuthorizedDispatchActorNpub: isTrustedAgentDispatchActor,
  dispatchAgentWorkingDirectory: config.agentDispatchWorkingDirectory,
  validateWorkingDirectory: (directory) => ensureDirectory(directory),
});
accessGrantListener = createAccessGrantListener({
  relays: config.connectRelays,
  subscriptionManager: workspaceSubscriptionManager,
  isAuthorizedIssuerNpub: isTrustedAgentDispatchActor,
});
if (wingmanInstanceIdentity && adminNpub) {
  accessGrantListener.subscribe(adminNpub, wingmanInstanceIdentity.secretKey, wingmanInstanceIdentity.pubkeyHex);
}
let sessionApiContextRef: SessionApiContext | null = null;

const requireApprovedWorkAccess = (): AccessRule => {
  return (context) => {
    const ownerNpub = getEffectiveOwnerNpub(context.auth);
    return isUserApprovedForWork(ownerNpub)
      ? allow()
      : deny("approval-required", 403);
  };
};

const trustedExecutionRuleOptions = {
  isAdminNpub: isConfiguredAdminNpub,
  audit: (entry: ExecutionAuditEntry) =>
    writeServerLog("INFO", "[execution-audit]", entry),
};

registerAccessRule(AccessActions.SessionsManage, requireAuthentication({ allowNip98: true }));
registerAccessRule(AccessActions.SessionsManage, createTrustedExecutionRule({
  kind: "sessions",
  ...trustedExecutionRuleOptions,
}));
registerAccessRule(AccessActions.SessionsRead, requireAuthentication({ allowNip98: true }));
registerAccessRule(AccessActions.SessionsRead, requireApprovedWorkAccess());
registerAccessRule(AccessActions.FilesRead, requireAuthentication({ allowNip98: true }));
registerAccessRule(AccessActions.FilesRead, requireApprovedWorkAccess());
registerAccessRule(AccessActions.FilesWrite, requireAuthentication({ allowNip98: true }));
registerAccessRule(AccessActions.FilesWrite, requireApprovedWorkAccess());
registerAccessRule(AccessActions.AppsManage, requireAuthentication({ allowNip98: true }));
registerAccessRule(AccessActions.AppsManage, createTrustedExecutionRule({
  kind: "apps",
  ...trustedExecutionRuleOptions,
}));
registerAccessRule(AccessActions.AppsRead, requireAuthentication({ allowNip98: true }));
registerAccessRule(AccessActions.AppsRead, requireApprovedWorkAccess());
registerAccessRule(AccessActions.UiRestricted, requireAuthentication());
registerAccessRule(AccessActions.TodosManage, requireAuthentication());
registerAccessRule(AccessActions.TodosManage, requireApprovedWorkAccess());
registerAccessRule(AccessActions.ProjectsManage, requireAuthentication());
registerAccessRule(AccessActions.ProjectsManage, requireApprovedWorkAccess());
registerAccessRule(AccessActions.DeploymentsManage, requireAuthentication());
registerAccessRule(AccessActions.DeploymentsManage, requireApprovedWorkAccess());
registerAccessRule(AccessActions.DelegationsManage, requireAuthentication({ allowNip98: true }));
registerAccessRule(AccessActions.DelegationsManage, requireApprovedWorkAccess());

const projectRootPath = (() => {
  let root = normalize(fileURLToPath(new URL("..", import.meta.url)));
  if (root.endsWith(sep)) {
    root = root.slice(0, -1);
  }
  return root;
})();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const projectRootDirectory = normalize(join(moduleDirectory, ".."));
const agentApiBinaryPath = normalize(join(projectRootDirectory, "out", "agentapi"));

await ensureAgentApiBinary({ agentApiBinaryPath, projectRootDirectory });

let sessionsStoppedForRestart = false;

const srcRoot = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const tmpRoot = normalize(join(srcRoot, "../tmp"));
const uploadsRoot = join(tmpRoot, "uploads");
const imageRoot = join(uploadsRoot, "images");
const attachmentRoot = join(uploadsRoot, "attachments");
const determineHomeDirectory = (): string => {
  const fromEnv = Bun.env.HOME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    return homedir();
  } catch {
    return projectRoot;
  }
};

const rawHomeDirectory = determineHomeDirectory();
const homeDirectory = normalize(await realpath(rawHomeDirectory).catch(() => rawHomeDirectory));
const documentsDirectory = join(homeDirectory, "Documents");
const userDataRoot = join(documentsDirectory, "Wingman");
const userIdentityRoot = join(userDataRoot, "users");
const systemDocsRoot = homeDirectory;
const systemDocsRootBoundary = systemDocsRoot.endsWith(sep) ? systemDocsRoot : `${systemDocsRoot}${sep}`;
await mkdir(documentsDirectory, { recursive: true }).catch(() => undefined);
await mkdir(userDataRoot, { recursive: true }).catch(() => undefined);
await mkdir(userIdentityRoot, { recursive: true }).catch(() => undefined);
await mkdir(uploadsRoot, { recursive: true }).catch(() => undefined);
await mkdir(imageRoot, { recursive: true }).catch(() => undefined);
await mkdir(attachmentRoot, { recursive: true }).catch(() => undefined);
const warmRestartRoot = join(homeDirectory, ".wingmen");
await mkdir(warmRestartRoot, { recursive: true }).catch(() => undefined);
const restartMarkerPath = join(warmRestartRoot, "restart.json");
const warmRestartMarker = await loadWarmRestartMarker(restartMarkerPath);

const resolveWorkspace = (context?: RequestAuthContext): WorkspaceScope => {
  const activeContext = context ?? getRequestContext();
  return resolveWorkspaceScope(config, activeContext, configuredAdminNpubs, systemDocsRoot, systemDocsRootBoundary);
};

const {
  ensureWithinAllowedDirectories,
  toAbsoluteDirectory,
  ensureDirectory,
  listRootDirectories,
  resolveDirectoryParent,
  toProjectRelativePath,
} = createPathUtils(resolveWorkspace, projectRoot);
warmRestartState.marker = warmRestartMarker;

// Initialize PM2 connection
try {
  await connectPM2();
  console.log("[pm2] connected to PM2 daemon");
} catch (error) {
  console.warn(`[pm2] failed to connect to PM2: ${(error as Error).message}`);
}

const teamBillingService = new TeamBillingService({
  listIdentityMembers: () =>
    identityUserStore.listUsers().map((user) => ({
      normalizedNpub: user.normalizedNpub,
      npub: user.npub,
    })),
  serverPort: config.port,
  baseUrl: config.baseUrl,
  getOpenRouterApiKey: () => instanceSettingsService.get("integrations.openrouter_api_key"),
});
teamBillingService.syncTeamMembers();
if (teamBillingService.isCreditsEnabled()) {
  void teamBillingService.primeProviderKeyCache().catch((error) => {
    console.warn(`[billing] failed to prime provider key cache on startup: ${(error as Error).message}`);
  });
}

let manager: ProcessManager;
const capabilityBroker = new CapabilityBroker({
  botKeyStore,
  keyVault: brokerKeyVault,
  getSession: (sessionId) => manager?.getSession(sessionId) ?? null,
  audit: (entry) => writeServerLog("INFO", "[capability-broker]", entry),
  stateStore: capabilityStateStore,
});
const agentProfileKeyRotation = new AgentProfileKeyRotation({
  botKeyStore,
  brokerKeyVault,
  revokeCapabilitiesForBotNpub: (botNpub) => capabilityBroker.revokeBotNpub(botNpub),
  publish: async ({ event, agent }) => {
    const record = botKeyStore.getActiveKeyForBotNpub(agent.botNpub);
    if (!record || record.userNpub !== agent.managedByNpub) throw new Error('Agent identity binding is unavailable.');
    return publishBotProfileEvent({
      botPubkeyHex: record.botPubkeyHex,
      signedEvent: event,
      defaultRelays: config.connectRelays,
    });
  },
});
manager = new ProcessManager(config, {
  resolveBillingLaunchConfig: (input) => teamBillingService.resolveLaunchConfig(input),
  recordAdapterUsage: async (data) => {
    await teamBillingService.recordProxyUsage({
      sessionId: data.sessionId,
      npub: data.npub,
      agent: data.agent,
      endpoint: data.endpoint,
      method: 'POST',
      statusCode: 200,
      costUsd: data.costUsd ?? null,
    });
  },
  issueSessionCapability: ({ sessionId, ownerNpub, profileId, botNpub }) => {
    const { record } = resolveAndBindSessionCapabilityBotRecord({
      manager,
      sessionId,
      ownerNpub,
      requestedBotNpub: botNpub,
      profiles: agentDefinitionStore.listForManagerNpub(ownerNpub),
      getActiveByBotNpub: (candidateBotNpub) => botKeyStore.getActiveKeyForBotNpub(candidateBotNpub),
      getActiveForOwner: (candidateOwnerNpub) => botKeyStore.getActiveKeyForUser(candidateOwnerNpub),
    });
    ensureLegacyBrokerRecordProvisioned({
      vault: brokerKeyVault,
      record,
      instanceIdentity: wingmanInstanceIdentity,
    });
    return capabilityBroker.issueSessionCapability({
      sessionId,
      ownerNpub,
      profileId,
      botNpub: record.botNpub,
      policy: buildDefaultAgentCapabilityPolicy({
        towerUrl: defaultTowerUrl,
        // A manager may have Flight Deck subscriptions on a public Tower
        // origin while this Autopilot talks to its local/internal origin.
        // Bind the capability to the manager's known subscription origins so
        // hydrated dispatch context and issuance policy cannot disagree.
        towerUrls: workspaceSubscriptionManager.listForManager(ownerNpub)
          .map((subscription) => subscription.backendBaseUrl),
        // NIP-98 verification canonicalises requests against WINGMAN_BASE_URL.
        // Capability targets must use the same public origin; otherwise a
        // locally signed URL is rejected by the verifier and the public URL is
        // rejected by the broker.
        autopilotUrl: config.baseUrl,
        ownerNpub,
      }),
    });
  },
  revokeSessionCapabilities: (sessionId) => {
    capabilityBroker.revokeSession(sessionId);
  },
});

const sharedInstanceAccessEnabled = isSharedInstanceAccessEnabled();
const sharedAgentDispatchEnabled = isSharedAgentDispatchEnabled();
const documentDirectStore = new DocumentDirectStore();

const wingmanMcpApiHandler = createWingmanMcpApiHandler({
  getSession: (sid: string) => manager.getSession(sid) ?? null,
  listSessions: () => manager.listSessions(),
  createSession: (agent, dir, name, explicitNpub, origin, metadata) =>
    manager.createSession(agent, dir, name, origin, undefined, explicitNpub, metadata),
  enableNightWatch: (sessionId, options) =>
    nightWatchStore.enableSession(sessionId, {
      prompt: options?.prompt,
      intervalMinutes: options?.intervalMinutes,
      maxCycles: options?.maxCycles,
    }),
  stopSession: async (sid) => (await manager.stopSession(sid)) ?? null,
  scheduleArchive: (sid) => scheduleSessionArchive(sid, manager),
  getSessionLogs: (sid) => manager.getLogs(sid),
  getSessionMessages: async (sid) => {
    const msgs = await syncSessionMessages(sid);
    return (msgs ?? []).map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt }));
  },
  listApps: () => appRegistry.listApps(),
  getAppStatus: (appId) => appProcessManager.getStatus(appId),
  runAppAction: (appId, action) => appProcessManager[action](appId),
  tailAppLogs: (appId, lines) => appProcessManager.tailLogs(appId, lines),
  caproverStore,
  getCaproverClient: createCaproverClientFromEnv,
  getCaproverTargets: createCaproverTargetClientsFromEnv,
  userSkillsRoot: join(homeDirectory, ".wingmen", "skills"),
  defaultSkillsRoot: join(projectRoot, "skills"),
  userSettingsStore,
  artifactsStore,
  openRouterApiKey: instanceSettingsService.get("integrations.openrouter_api_key"),
  findProjectByDirectory: (dir) => npubProjectStore.findByDirectory(dir),
  memoryStore,
  getWingmanNpub: () => wingmanInstanceIdentity?.npub ?? null,
  setPinnedFile: (sid, filePath) => manager.setPinnedFile(sid, filePath),
  removePinnedFile: (sid, filePath) => manager.removePinnedFile(sid, filePath),
  setPinnedFiles: (sid, filePaths, activeFilePath) => manager.setPinnedFiles(sid, filePaths, activeFilePath),
  pipelineStore,
  getBotIdentityForSubscription: (subscriptionId) =>
    workspaceSubscriptionManager.getRuntimeBotIdentity(subscriptionId),
  getFlightDeckRuntimeContext: (subscriptionId) =>
    workspaceSubscriptionManager.getFlightDeckRuntimeContext(subscriptionId),
  resolveFlightDeckDirectContext: (input) =>
    workspaceSubscriptionManager.resolveFlightDeckTurnDelivery(input),
  documentDirectStore,
});

// Reconcile PM2 processes with app registry
try {
  const appReconcileResult = await reconcileAppsWithPM2(appRegistry);
  if (appReconcileResult.appsReconciled > 0 || appReconcileResult.appsCleared > 0) {
    console.log(`[pm2] reconciled apps: ${appReconcileResult.appsReconciled} running, ${appReconcileResult.appsCleared} cleared`);
  }
  await autostartApps(appRegistry, appProcessManager);
} catch (error) {
  console.warn(`[apps-bootstrap] app reconciliation or autostart failed: ${(error as Error).message}`);
}
const nightWatchDeps = {
  store: nightWatchStore,
  featureFlagStore,
  agentHost,
  messageStore,
  promptQueueStore,
  openRouterApiKey: instanceSettingsService.get("integrations.openrouter_api_key"),
  openRouterBaseUrl: "https://openrouter.ai/api",
  wingmanBaseUrl: config.baseUrl,
  getSession: (sid: string) => manager.getSession(sid) ?? null,
  updateSessionMetadata: (sid: string, metadata: SessionMetadataInput) =>
    manager.updateSessionMetadata(sid, metadata),
  dispatchPrompt: (session: SessionSnapshot) => {
    void maybeAutoDispatchQueuedPrompt(session);
  },
  sendRawInput: async (session: SessionSnapshot, content: string): Promise<boolean> => {
    try {
      const agentUrl = buildAgentUrl(agentHost, session.port, "/message");
      const resp = await fetch(agentUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "raw", content }),
      });
      return resp.ok;
    } catch (err) {
      console.error(`[nightwatch] sendRawInput failed for session ${session.id}:`, err);
      return false;
    }
  },
  markDispatchCooldown: (sessionId: string) => {
    markQueueDispatchCooldown(sessionId);
  },
};

const wingmenRoot = join(projectRoot, ".wingmen");
await mkdir(wingmenRoot, { recursive: true }).catch(() => undefined);
const warmRestartManagerScriptPath = join(projectRoot, "scripts", "warm-restart-manager.ts");
const {
  ensureUserWorkspace,
  ensureImageDirectory,
  ensureAttachmentDirectory,
  createImageFilename,
  createAttachmentFilename,
  buildEscapedImageMarkdown,
  buildAgentImagePlaceholder,
  buildAgentFilePlaceholder,
} = createUploadHelpers({
  userIdentityRoot,
  attachmentRoot,
  imageRoot,
});

fileWatcherStore.ensureStopSessionWatcher();
fileWatcherStore.ensureStartSessionWatcher();

const fileWatcherRunner = new FileWatcherRunner({
  root: wingmenRoot,
  manager,
  config,
});
try {
  await fileWatcherRunner.start();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[watchers] failed to start file watcher runner: ${message}`);
}

process.on("beforeExit", () => {
  fileWatcherRunner.stop();
  accessGrantListener?.shutdown();
  workspaceSubscriptionManager.shutdown();
});

const serializeSession = (session: SessionSnapshot) => ({
  ...session,
  lastUpdatedAt: messageStore.getSession(session.id)?.lastUpdatedAt ?? null,
  ownerNpub: resolveSessionOwnerNpub(session.npub ?? null, session.metadata),
  agentRuntimeStatus: session.agentRuntimeStatus ?? null,
  identityAlias: generateIdentityAlias(resolveSessionOwnerNpub(session.npub ?? null, session.metadata)),
  origin: session.origin ?? null,
});

const parseSessionOriginInput = (value: unknown): SessionOrigin | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object") {
    throw new Error("Session origin must be an object");
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.trim() : "";
  const idRaw = record.id;
  const id =
    typeof idRaw === "string"
      ? idRaw.trim()
      : typeof idRaw === "number"
        ? String(idRaw)
        : "";
  if (!type || !id) {
    throw new Error("Session origin requires both type and id");
  }
  const origin: SessionOrigin = { type, id };
  const url = typeof record.url === "string" ? record.url.trim() : "";
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (url) {
    origin.url = url;
  }
  if (label) {
    origin.label = label;
  }
  return origin;
};

type IdentitySummary = {
  npub: string | null;
  normalizedNpub: string | null;
  segment: string;
  alias: string;
  ports: number[];
  sessionIds: string[];
  activeSessionIds: string[];
  lastSeenAt: string | null;
  dataRoot: string;
  logsRoot: string;
  attachmentsRoot: string;
  imagesRoot: string;
};

const buildIdentitySummaries = (
  activeSessions: SessionSnapshot[],
  viewerNormalizedNpub: string | null,
  options?: { includeAll?: boolean },
): IdentitySummary[] => {
  const includeAll = sharedInstanceAccessEnabled || Boolean(options?.includeAll);
  if (!includeAll && !viewerNormalizedNpub) {
    return [];
  }

  const storedUsers = identityUserStore.listUsers();
  const portsByNormalized = new Map<string, number[]>(
    storedUsers.map((record) => [record.normalizedNpub, record.ports] as const),
  );
  const activeSessionMap = new Map(activeSessions.map((session) => [session.id, session] as const));
  type Accumulator = {
    npub: string | null;
    normalized: string | null;
    segment: string;
    alias: string;
    ports: number[];
    dataRoot: string;
    logsRoot: string;
    attachmentsRoot: string;
    imagesRoot: string;
    sessionIds: Set<string>;
    activeSessionIds: Set<string>;
    lastSeenMs: number;
  };

  const summaryMap = new Map<string, Accumulator>();

  const registerSession = (
    sessionNpub: string | null,
    metadata: SessionMetadataInput,
    sessionId: string,
    startedAt: string,
    isActive: boolean,
  ) => {
    const ownerNpub = resolveSessionOwnerNpub(sessionNpub, metadata);
    const normalized = normaliseNpub(ownerNpub);
    if (!includeAll) {
      if (!normalized || normalized !== viewerNormalizedNpub) {
        return;
      }
    }
    const key = normalized ?? "__anonymous__";
    let accumulator = summaryMap.get(key);
    if (!accumulator) {
      const segment = deriveNpubSegment(ownerNpub);
      const dataRoot = normalize(join(userIdentityRoot, segment));
      const logsRoot = normalize(join(dataRoot, "logs"));
      const attachmentsRoot = normalize(join(attachmentRoot, segment));
      const imagesRoot = normalize(join(imageRoot, segment));
      accumulator = {
        npub: ownerNpub,
        normalized,
        segment,
        alias: generateIdentityAlias(ownerNpub),
        ports: [],
        dataRoot,
        logsRoot,
        attachmentsRoot,
        imagesRoot,
        sessionIds: new Set(),
        activeSessionIds: new Set(),
        lastSeenMs: 0,
      };
      summaryMap.set(key, accumulator);
    }
    if (normalized) {
      const storedPorts = portsByNormalized.get(normalized);
      if (storedPorts) {
        accumulator.ports = storedPorts;
      }
    }

    accumulator.sessionIds.add(sessionId);
    if (isActive) {
      accumulator.activeSessionIds.add(sessionId);
    }

    const parsed = Date.parse(startedAt);
    const timestamp = Number.isFinite(parsed) ? parsed : Date.now();
    if (timestamp > accumulator.lastSeenMs) {
      accumulator.lastSeenMs = timestamp;
    }
  };

  const storedSessions = messageStore.listSessions();
  for (const record of storedSessions) {
    registerSession(record.npub ?? null, record.metadata, record.id, record.startedAt, activeSessionMap.has(record.id));
  }

  for (const session of activeSessions) {
    registerSession(session.npub ?? null, session.metadata, session.id, session.startedAt, true);
  }

  return Array.from(summaryMap.values())
    .map((entry) => ({
      npub: entry.npub,
      normalizedNpub: entry.normalized,
      segment: entry.segment,
      ports: entry.ports,
      sessionIds: Array.from(entry.sessionIds),
      activeSessionIds: Array.from(entry.activeSessionIds),
      lastSeenAt: entry.lastSeenMs > 0 ? new Date(entry.lastSeenMs).toISOString() : null,
      dataRoot: entry.dataRoot,
      logsRoot: entry.logsRoot,
      attachmentsRoot: entry.attachmentsRoot,
      imagesRoot: entry.imagesRoot,
      alias: entry.alias,
    }))
    .sort((a, b) => {
      const left = a.normalizedNpub ?? "";
      const right = b.normalizedNpub ?? "";
      return left.localeCompare(right);
    });
};


const getViewerNormalizedNpub = (authContext: RequestAuthContext): string | null => {
  return getEffectiveOwnerNpub(authContext);
};

const sessionBelongsToViewer = (
  sessionNpub: string | null | undefined,
  sessionMetadata: SessionMetadataInput,
  viewerNormalizedNpub: string | null,
  viewerIsAdmin: boolean,
): boolean => {
  if (sharedInstanceAccessEnabled && viewerNormalizedNpub) {
    return true;
  }
  return sessionOwnerMatchesViewer(sessionNpub, sessionMetadata, viewerNormalizedNpub, viewerIsAdmin);
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

scheduleCleanup({ root: imageRoot, ttlMs: ONE_DAY_MS, intervalMs: ONE_DAY_MS, label: "image" });
scheduleCleanup({ root: attachmentRoot, ttlMs: ONE_DAY_MS, intervalMs: ONE_DAY_MS, label: "attachment" });

manager.on((event) => {
  const sessionOwnerNpub = resolveSessionOwnerNpub(event.session.npub ?? null, event.session.metadata);

  if (event.type === "session-started") {
    ensureUserWorkspace(sessionOwnerNpub);
    if (sessionOwnerNpub) {
      try {
        identityUserStore.touch(sessionOwnerNpub, {
          alias: generateIdentityAlias(sessionOwnerNpub),
          lastSeenAt: new Date().toISOString(),
        });
      } catch (error) {
        console.warn(`[admin] failed to record identity ${sessionOwnerNpub}:`, error);
      }
    }
    messageStore.recordSession({
      id: event.session.id,
      agent: event.session.agent,
      startedAt: event.session.startedAt,
      name: event.session.name,
      npub: event.session.npub,
      port: event.session.port,
      pid: event.session.pid,
      workingDirectory: event.session.workingDirectory,
      command: event.session.command,
      runtimeStatus: event.session.agentRuntimeStatus ?? null,
      origin: event.session.origin ?? null,
      pm2Name: event.session.pm2Name,
      tmuxSession: event.session.tmuxSession,
      tmuxWindow: event.session.tmuxWindow,
      metadata: event.session.metadata,
    });
    messageStore.replaceMessages(event.session.id, []);
    void maybeAutoDispatchQueuedPrompt(event.session);
    // Broadcast to browser so home page / nav live-refresh
    if (sessionOwnerNpub) {
      sessionBroadcaster.broadcast(sessionOwnerNpub, {
        type: "session-started",
        sessionId: event.session.id,
        agent: event.session.agent,
        name: event.session.name ?? undefined,
      });
    }
    return;
  }
  if (event.type === "session-deleted") {
    clearPromptStartupReady(event.session.id);
    // Session archived and removed from memory — notify browsers to refresh
    if (sessionOwnerNpub) {
      sessionBroadcaster.broadcast(sessionOwnerNpub, {
        type: "session-deleted",
        sessionId: event.session.id,
        agent: event.session.agent,
        name: event.session.name ?? undefined,
      });
    }
    return;
  }
  if (event.type === "session-updated" || event.type === "session-stopped") {
    ensureUserWorkspace(sessionOwnerNpub);
    if (sessionOwnerNpub) {
      try {
        identityUserStore.touchExisting(sessionOwnerNpub, {
          lastSeenAt: new Date().toISOString(),
        });
      } catch (error) {
        console.warn(`[admin] failed to update identity ${sessionOwnerNpub}:`, error);
      }
      if (event.type === "session-stopped") {
        clearPromptStartupReady(event.session.id);
      }
    }
    messageStore.recordSession({
      id: event.session.id,
      agent: event.session.agent,
      startedAt: event.session.startedAt,
      name: event.session.name,
      npub: event.session.npub,
      port: event.session.port,
      pid: event.session.pid,
      workingDirectory: event.session.workingDirectory,
      command: event.session.command,
      runtimeStatus: event.session.agentRuntimeStatus ?? null,
      origin: event.session.origin ?? null,
      pm2Name: event.session.pm2Name,
      tmuxSession: event.session.tmuxSession,
      tmuxWindow: event.session.tmuxWindow,
      metadata: event.session.metadata,
    });
    void maybeAutoDispatchQueuedPrompt(event.session);
    // Broadcast to browser so home page / nav live-refresh
    if (sessionOwnerNpub) {
      sessionBroadcaster.broadcast(sessionOwnerNpub, {
        type: event.type as "session-updated" | "session-stopped",
        sessionId: event.session.id,
        agent: event.session.agent,
        name: event.session.name ?? undefined,
        status: event.session.agentRuntimeStatus ?? undefined,
        artifactIntent: event.type === "session-updated" ? event.artifactIntent : undefined,
      });
    }
  }
});

const DIRECTORY_NAME_MAX_LENGTH = 160;

const normaliseDirectoryEntryName = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("Folder name is required");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Folder name is required");
  }
  if (trimmed.length > DIRECTORY_NAME_MAX_LENGTH) {
    throw new Error("Folder name is too long");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("Folder name is not allowed");
  }
  if (/[\\/]/.test(trimmed)) {
    throw new Error("Folder name cannot contain path separators");
  }
  return trimmed;
};


const createDirectoryEntry = async (
  parentInput: string | null | undefined,
  nameInput: unknown,
  scopeOverride?: WorkspaceScope,
) => {
  const parentDirectory = await ensureDirectory(parentInput, scopeOverride);
  const name = normaliseDirectoryEntryName(nameInput);
  const target = normalize(join(parentDirectory, name));
  const parentWithSep = parentDirectory.endsWith(sep) ? parentDirectory : `${parentDirectory}${sep}`;
  if (!target.startsWith(parentWithSep)) {
    throw new Error("Invalid directory path");
  }

  try {
    await mkdir(target, { recursive: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      throw new Error("A file or directory with that name already exists");
    }
    throw new Error(`Failed to create directory: ${(error as Error).message ?? "unknown error"}`);
  }

  return {
    path: target,
    name,
  };
};


const directoryExists = async (path: string): Promise<boolean> => {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

const normaliseOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const SESSION_NAME_MAX_LENGTH = 120;

const normaliseSessionNameInput = (value: unknown): string | null => {
  const text = normaliseOptionalString(value);
  if (!text) {
    return null;
  }
  return text.length > SESSION_NAME_MAX_LENGTH ? text.slice(0, SESSION_NAME_MAX_LENGTH) : text;
};

type SessionWorkspaceRequest =
  | {
      mode: "worktree";
      name: string;
    }
  | null;

const parseSessionWorkspaceRequest = (input: unknown): SessionWorkspaceRequest => {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const mode = normaliseOptionalString(candidate.mode);
  if (!mode) {
    return null;
  }
  if (mode === "worktree") {
    const name = normaliseOptionalString(candidate.name);
    if (!name) {
      throw new Error("Worktree name is required to create a new worktree");
    }
    return { mode: "worktree", name };
  }
  throw new Error(`Unsupported workspace mode: ${mode}`);
};

const resolveSessionWorkingDirectory = async (
  directoryInput: string | undefined,
  workspace: SessionWorkspaceRequest,
  workspaceScopeOverride?: WorkspaceScope,
): Promise<string> => {
  const baseDirectory = await ensureDirectory(directoryInput, workspaceScopeOverride);
  if (!workspace) {
    return baseDirectory;
  }

  if (workspace.mode === "worktree") {
    const worktree = await createGitWorktree({
      directory: baseDirectory,
      branch: workspace.name,
      startPoint: null,
    });
    return worktree.path;
  }

  return baseDirectory;
};

const stopAndRemoveSession = async (sessionId: string) => {
  const existing = manager.getSession(sessionId);
  if (!existing) {
    messageStore.removeSession(sessionId);
    return false;
  }

  if (existing.status === "starting" || existing.status === "running") {
    try {
      await manager.stopSession(sessionId);
    } catch (error) {
      throw new Error(`Failed to stop session ${sessionId}: ${(error as Error).message}`);
    }
  }

  try {
    manager.deleteSession(sessionId);
  } catch (error) {
    throw new Error(`Failed to delete session ${sessionId}: ${(error as Error).message}`);
  }

  messageStore.removeSession(sessionId);
  return true;
};

const stopSessionsForUser = async (npub: string | null | undefined) => {
  const normalized = normaliseNpub(npub ?? null);
  if (!normalized) {
    return;
  }
  const sessionIds = new Set<string>();
  const activeSessions = manager.listSessions();
  for (const session of activeSessions) {
    const sessionNpub = resolveSessionOwnerNpub(session.npub ?? null, session.metadata);
    if (sessionNpub && sessionNpub === normalized) {
      sessionIds.add(session.id);
    }
  }
  const storedSessions = messageStore.listSessions();
  for (const record of storedSessions) {
    const recordNpub = resolveSessionOwnerNpub(record.npub ?? null, record.metadata);
    if (recordNpub && recordNpub === normalized) {
      sessionIds.add(record.id);
    }
  }
  for (const id of sessionIds) {
    await stopAndRemoveSession(id);
  }
};

const WEBHOOK_TOKEN_HEADER = "x-wingman-webhook-token";

const readWebhookBearerToken = (request: Request): string | null => {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
};

const getWebhookTokenFromRequest = (request: Request): string | null => {
  const headerToken = request.headers.get(WEBHOOK_TOKEN_HEADER)?.trim();
  if (headerToken && headerToken.length > 0) {
    return headerToken;
  }
  return readWebhookBearerToken(request);
};

const constantTimeTokenMatch = (expected: string, provided: string): boolean => {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
};

const isValidWebhookToken = (request: Request): boolean => {
  const configured = instanceSettingsService.get("internal.webhook_off_token")?.trim();
  if (!configured) {
    return false;
  }
  const provided = getWebhookTokenFromRequest(request);
  if (!provided) {
    return false;
  }
  return constantTimeTokenMatch(configured, provided);
};

const handleWebhookRequest = async (
  request: Request,
  url: URL,
  authContext: RequestAuthContext,
): Promise<Response | null> => {
  const pathname = url.pathname;
  if (pathname === "/v1/api/webhook/off" && request.method === "POST") {
    if (!authContext.session && !isValidWebhookToken(request)) {
      return Response.json(
        {
          error: "Authentication required. Provide a valid session cookie or webhook token.",
        },
        { status: 401 },
      );
    }

    if (authContext.session) {
      const denied = await ensureApiAccess(AccessActions.SessionsManage, request, url, authContext);
      if (denied) {
        return denied;
      }
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

    const data = payload as Record<string, unknown>;
    const sessionId =
      normaliseOptionalString(data["session-id"]) ??
      normaliseOptionalString(data.sessionId) ??
      normaliseOptionalString(data.session_id);

    if (!sessionId) {
      return Response.json({ error: "session-id is required" }, { status: 400 });
    }

    const state = normaliseOptionalString(data.state);
    if (state && state.toLowerCase() !== "off") {
      return Response.json({ error: "Unsupported state. Only 'off' is accepted." }, { status: 400 });
    }

    try {
      const removed = await stopAndRemoveSession(sessionId);
      if (!removed) {
        return Response.json({ status: "ignored", reason: "session-not-found" }, { status: 404 });
      }
      return Response.json({ status: "ok", sessionId }, { status: 200 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  return null;
};

const listDirectories = async (
  input: string | null | undefined,
  query?: string,
  scopeOverride?: WorkspaceScope,
) => {
  const activeScope = scopeOverride ?? resolveWorkspace();
  const trimmed = input?.trim() ?? "";
  if (trimmed.length === 0 || trimmed === DIRECTORY_BROWSER_ROOT) {
    return listRootDirectories(query, activeScope);
  }

  const directory = await ensureDirectory(trimmed, activeScope);
  const entries = await readdir(directory, { withFileTypes: true });
  const term = query?.toLowerCase().trim();

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: normalize(join(directory, entry.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((entry) => {
      if (!term) return true;
      return entry.name.toLowerCase().includes(term);
    });

  const limitedDirectories = term ? directories.slice(0, MAX_DIRECTORY_RESULTS) : directories;

  const parent = resolveDirectoryParent(directory, activeScope);

  return {
    path: directory,
    parent,
    entries: limitedDirectories,
  };
};

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

const staticRoutes = createStaticRouteHandler({
  assetService: createProjectStaticAssetService(projectRoot),
  resolveBootConfig: () => ({
    branding: {
      name: instanceSettingsService.get("branding.name")?.trim() || "Wingman",
      highlightColor: instanceSettingsService.get("branding.highlight_color")?.trim() || "#10b981",
    },
  }),
});

const duplicateCallbackPublicationFilter = new DuplicateCallbackPublicationFilter(
  (route) => workspaceSubscriptionManager.resolveDuplicateCallbackPublicationConfig(route),
  new DuplicateCallbackPublicationDecisionStore(),
  console,
);
const flightDeckSessionTurnBridge = new FlightDeckSessionTurnBridge({
  manager,
  resolveDelivery: (session) => workspaceSubscriptionManager.resolveFlightDeckTurnDelivery({
    towerServiceNpub: session.metadata?.flightdeckTowerServiceNpub ?? '',
    workspaceId: session.metadata?.flightdeckWorkspaceId ?? '',
    agentNpub: session.metadata?.flightdeckAgentNpub ?? '',
  }),
  resolveTriggerMessageId: createFlightDeckTriggerResolver(chatInterceptStateStore),
  publicationFilter: duplicateCallbackPublicationFilter,
  log: console,
});
const profileBotIdentityRunner = createProfileBotIdentityRunner({
  instanceIdentity: wingmanInstanceIdentity,
  botKeyStore,
  brokerKeyVault,
});
const directChatProfileIdentityRunner = createDirectChatProfileIdentityRunner({
  agentStore: agentDefinitionStore,
  withBotIdentity: profileBotIdentityRunner,
});
const agentDirectDeliveryReconciler = new AgentDirectDeliveryReconciler({
  manager,
  store: directChatTurnStore,
  interceptStore: chatInterceptStateStore,
  resolveTransport: (record) => workspaceSubscriptionManager.resolveDirectChatTurnTransport({
    subscriptionId: record.subscriptionId!, backendBaseUrl: record.backendBaseUrl!,
    towerServiceNpub: record.towerServiceNpub!, workspaceId: record.workspaceId!, sourceAppNpub: record.sourceAppNpub!,
  }),
  withProfileIdentity: directChatProfileIdentityRunner,
  publicationFilter: duplicateCallbackPublicationFilter,
  dispatchOutcomeStore: flightDeckDispatchOutcomeStore,
  log: console,
});
const agentChatSessionRuntime = new AgentChatSessionRuntime({
  defaultAgent: config.defaultAgent,
  processManager: manager,
  idleRetentionMinutes: 60,
  turnBridge: flightDeckSessionTurnBridge,
  directDeliveryReconciler: agentDirectDeliveryReconciler,
  publicationFilter: duplicateCallbackPublicationFilter,
  withBotIdentity: profileBotIdentityRunner,
});
workspaceSubscriptionManager.setChatRuntime(agentChatSessionRuntime);
// NOTE: `agentWorkSessionRuntime` construction, `setAgentWorkRuntime`, and
// `workspaceSubscriptionManager.startupReload()` are deferred until after
// `promptDispatchEngine` is created below, because the runtime depends on
// `maybeAutoDispatchQueuedPrompt` which is destructured from the engine.

// Clean up any PM2 agent processes not reclaimed by rehydration
try {
  const agentCleanup = await cleanupOrphanedAgentProcesses(manager, messageStore);
  if (agentCleanup.cleaned > 0 || agentCleanup.failed > 0) {
    console.log(
      `[pm2] agent cleanup: ${agentCleanup.cleaned} removed, ${agentCleanup.failed} failed (of ${agentCleanup.checked} checked)`,
    );
  }
} catch (error) {
  console.warn(`[pm2] agent cleanup failed: ${(error as Error).message}`);
}

const sessionMessageUpdates = new SessionMessageUpdates();
const liveSessionMessageSync = new LiveSessionMessageSync({
  manager,
  messageStore,
  agentHost,
  requestTimeoutMs: 3000,
  minimumRefreshIntervalMs: 1000,
  logger: console,
});
const syncSessionMessages = liveSessionMessageSync.sync.bind(liveSessionMessageSync);

// SSE handler for session events
const handleSessionEvents = createSessionEventsHandler({
  manager,
  agentHost,
  sseKeepaliveIntervalMs: config.sseKeepaliveIntervalMs,
  subscribeToMessageUpdates: sessionMessageUpdates.subscribe.bind(sessionMessageUpdates),
});

const agentStatusPoller = new AgentRuntimeStatusPoller(manager, {
  host: agentHost,
  intervalMs: config.agentStatusPollIntervalMs,
  maxIntervalMs: config.agentStatusPollMaxIntervalMs,
  timeoutMs: config.agentStatusPollTimeoutMs,
  initialDelayMs: config.agentStatusPollIntervalMs,
});
agentStatusPoller.start();

const liveMessagePersistence = new LiveMessagePersistenceLoop({
  manager,
  syncSessionMessages,
  intervalMs: Math.max(5000, config.agentStatusPollIntervalMs),
  initialDelayMs: 2000,
  maxConcurrency: 2,
  onMessagesChanged: (sessionId) => sessionMessageUpdates.publish(sessionId),
});
liveMessagePersistence.start();

const promptDispatchEngine = createPromptDispatchEngine({
  manager,
  agentHost,
  messageStore,
  isUserApprovedForWork,
  promptQueueStore,
  buildAgentUrl,
  waitForSessionPromptReadiness,
  syncSessionMessages,
  maybeTriggerNightWatch,
  nightWatchDeps,
  flightDeckTurnBridge: flightDeckSessionTurnBridge,
  dispatchInbox: sessionDispatchInbox,
});
const {
  dispatchNextQueuedPromptForSession,
  maybeAutoDispatchQueuedPrompt,
  markPromptStartupReady,
  clearPromptStartupReady,
  markQueueDispatchCooldown,
  queueDispatchInFlight,
  waitForMessageUpdate,
} = promptDispatchEngine;

// Session creation and rehydration emit manager events that can dispatch
// persisted prompts. Recovery must therefore run after the dispatch engine is
// initialized, or startup will hit the destructured helper's temporal dead zone.
await restoreRestartedSessions(
  warmRestartMarker,
  restartMarkerPath,
  manager,
  messageStore,
  [...SUPPORTED_AGENT_TYPES],
);

await rehydrateWarmSessions(
  warmRestartMarker,
  restartMarkerPath,
  agentHost,
  manager,
  ensureUserWorkspace,
  config.defaultWorkingDirectory,
  messageStore,
  [...SUPPORTED_AGENT_TYPES],
);

// Deferred from above: AgentWorkSessionRuntime depends on
// maybeAutoDispatchQueuedPrompt, which is only available after the
// promptDispatchEngine destructure.
const agentWorkSessionRuntime = new AgentWorkSessionRuntime({
  defaultAgent: config.defaultAgent,
  getSession: (sessionId: string) => manager.getSession(sessionId) ?? null,
  createSession: async (agent, workingDirectory, name, origin, explicitNpub, metadata) =>
    await manager.createSession(agent, workingDirectory, name, origin, undefined, explicitNpub, metadata),
  updateSessionMetadata: (sessionId, metadata) => manager.updateSessionMetadata(sessionId, metadata),
  addPrompt: (sessionId, content) => promptQueueStore.addPrompt(sessionId, { content }),
  hasQueuedPrompt: (sessionId, content) => promptQueueStore.hasQueuedPrompt(sessionId, content),
  hasQueuedTaskDispatchPrompt: (sessionId, taskId) =>
    promptQueueStore.hasQueuedTaskDispatchPrompt(sessionId, taskId),
  maybeAutoDispatchQueuedPrompt,
  enableNightWatch: (sessionId) => {
    nightWatchStore.enableSession(sessionId);
  },
});
workspaceSubscriptionManager.setAgentWorkRuntime(agentWorkSessionRuntime);

const taskDirectRuntime = new TaskDirectRuntime({
  defaultAgent: config.defaultAgent,
  processManager: manager,
  agentStore: agentDefinitionStore,
});
workspaceSubscriptionManager.setTaskDirectRuntime(taskDirectRuntime);

const documentDirectRuntime = new DocumentDirectRuntime({
  defaultAgent: config.defaultAgent,
  processManager: manager,
  agentStore: agentDefinitionStore,
  store: documentDirectStore,
});
workspaceSubscriptionManager.setDocumentDirectRuntime(documentDirectRuntime);

const agentCommentSessionRuntime = new AgentCommentSessionRuntime({
  defaultAgent: config.defaultAgent,
  getSession: (sessionId: string) => manager.getSession(sessionId) ?? null,
  listSessions: () => manager.listSessions(),
  createSession: async (agent, workingDirectory, name, origin, explicitNpub, metadata) =>
    await manager.createSession(agent, workingDirectory, name, origin, undefined, explicitNpub, metadata),
  updateSessionMetadata: (sessionId, metadata) => manager.updateSessionMetadata(sessionId, metadata),
  addPrompt: (sessionId, content) => promptQueueStore.addPrompt(sessionId, { content }),
  hasQueuedPrompt: (sessionId, content) => promptQueueStore.hasQueuedPrompt(sessionId, content),
  maybeAutoDispatchQueuedPrompt,
});
workspaceSubscriptionManager.setAgentCommentRuntime(agentCommentSessionRuntime);

void new AgentWorkSessionIdleRetention({
  processManager: manager,
  idleRetentionMinutes: 60,
});

const APP_ACTIONS: AppLifecycleAction[] = ["start", "stop", "restart", "setup", "build"];

const parseAppScripts = (input: unknown): AppLifecycleScripts => {
  const scripts: AppLifecycleScripts = {};
  if (!input || typeof input !== "object") {
    return scripts;
  }
  for (const action of APP_ACTIONS) {
    const value = (input as Record<string, unknown>)[action];
    if (value !== undefined && value !== null) {
      scripts[action] = validateAppCommand(value);
    }
  }
  return scripts;
};

const parseBooleanFlag = (value: string | null): boolean => {
  if (!value) return false;
  const flag = value.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
};

const parseBooleanInput = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "1" || trimmed === "true" || trimmed === "yes" || trimmed === "on") {
      return true;
    }
    if (trimmed === "0" || trimmed === "false" || trimmed === "no" || trimmed === "off") {
      return false;
    }
  }
  return undefined;
};

const parsePortInput = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
};

const WEB_APP_PORT_PLACEHOLDER = "<port>";

type BuildAppResponseOptions = {
  ownerAlias?: string | null;
  subdomainAlias?: string | null;
  customDomains?: AppDomainRecord[];
};

const buildHostedWebAppUrl = (port: number | null): string | null => {
  if (typeof port !== "number" || !Number.isFinite(port)) {
    return null;
  }
  const normalizedPort = Math.trunc(port);
  if (normalizedPort <= 0) {
    return null;
  }
  const base = config.hostUrlBase ?? "";
  const trimmed = base.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes(WEB_APP_PORT_PLACEHOLDER)) {
    return trimmed.replaceAll(WEB_APP_PORT_PLACEHOLDER, String(normalizedPort));
  }
  const separator = trimmed.endsWith("/") ? "" : "/";
  return `${trimmed}${separator}${normalizedPort}`;
};

const resolveOwnerAlias = (ownerNpub: string | null | undefined): string | null => {
  if (!ownerNpub) {
    return null;
  }
  const record = identityUserStore.getByNormalized(ownerNpub);
  return record?.alias ?? null;
};

const resolveOwnerAliasCached = (
  ownerNpub: string | null | undefined,
  cache: Map<string, string | null>,
): string | null => {
  if (!ownerNpub) {
    return null;
  }
  if (cache.has(ownerNpub)) {
    return cache.get(ownerNpub) ?? null;
  }
  const alias = resolveOwnerAlias(ownerNpub);
  cache.set(ownerNpub, alias);
  return alias;
};

type AppOwnerFilterOption = {
  value: string;
  label: string;
  npub: string | null;
  alias: string | null;
  appCount: number;
};

const buildAppOwnerFilters = (
  apps: AppRecord[],
  cache: Map<string, string | null>,
): AppOwnerFilterOption[] => {
  const map = new Map<
    string,
    { value: string; npub: string | null; alias: string | null; appCount: number }
  >();
  for (const app of apps) {
    const normalizedOwner = normaliseNpub(app.ownerNpub ?? null);
    const key = normalizedOwner ?? "__anonymous__";
    let entry = map.get(key);
    if (!entry) {
      entry = {
        value: key,
        npub: normalizedOwner,
        alias: resolveOwnerAliasCached(app.ownerNpub ?? null, cache),
        appCount: 0,
      };
      map.set(key, entry);
    }
    entry.appCount += 1;
  }
  return Array.from(map.values()).map((entry) => ({
    value: entry.value,
    npub: entry.npub,
    alias: entry.alias,
    appCount: entry.appCount,
    label: entry.alias ?? (entry.npub ?? "Anonymous"),
  }));
};

const defaultAppProcessStatus = (appId: string): AppProcessStatus => {
  const timestamp = new Date().toISOString();
  return {
    appId,
    status: "idle",
    lastAction: null,
    lastExitCode: null,
    message: undefined,
    updatedAt: timestamp,
    lastSuccessAt: undefined,
    lastFailureAt: undefined,
    running: false,
    inProgressAction: null,
  };
};

const buildSubdomainUrl = (alias: string | null): string | null => {
  if (!alias || !config.subdomainBaseDomain) {
    return null;
  }
  // Build URL like https://bold-gem-boat.apps.example.com
  return `https://${alias}.${config.subdomainBaseDomain}`;
};

/**
 * Build the app host URL based on routing mode.
 * - PATH mode: /host/<alias> (relative, will be resolved against current origin)
 * - SUBDOMAIN mode: https://<alias>.<baseDomain>
 */
const buildAppHostUrl = (alias: string | null): string | null => {
  if (!alias) {
    return null;
  }

  if (config.appRoutingMode === "path") {
    // Path-based routing: /host/<alias>
    return `/host/${alias}`;
  }

  // Subdomain mode - requires baseDomain to be configured
  if (!config.subdomainBaseDomain) {
    return null;
  }
  return `https://${alias}.${config.subdomainBaseDomain}`;
};

const buildAppResponse = (app: AppRecord, status: AppProcessStatus, options: BuildAppResponseOptions = {}) => {
  const hasStartScript = Boolean(app.scripts.start);
  const availableScripts: Record<AppLifecycleAction, boolean> = {
    start: hasStartScript,
    stop: true,
    restart: hasStartScript,
    setup: Boolean(app.scripts.setup),
    build: Boolean(app.scripts.build),
  };
  const webAppPort =
    typeof app.webAppPort === "number" && Number.isFinite(app.webAppPort) ? Math.trunc(app.webAppPort) : null;
  const webAppAlias = options.ownerAlias ?? null;
  const subdomainAlias = options.subdomainAlias ?? null;
  const customDomains = (options.customDomains ?? []).map((domain) => ({
    hostname: domain.hostname,
    appId: domain.appId,
    status: domain.status,
    url: `https://${domain.hostname}`,
    createdAt: domain.createdAt,
    updatedAt: domain.updatedAt,
    lastVerifiedAt: domain.lastVerifiedAt,
    error: domain.error,
  }));
  const activeCustomDomain = customDomains.find((domain) => domain.status === "active");
  // Use routing-mode-aware URL builder (path or subdomain based on APP_ROUTING)
  const subdomainUrl = app.webApp ? buildAppHostUrl(subdomainAlias) : null;
  const webAppUrl = app.webApp && webAppPort !== null && !subdomainUrl ? buildHostedWebAppUrl(webAppPort) : null;
  const primaryUrl = app.webApp ? activeCustomDomain?.url ?? subdomainUrl ?? webAppUrl : null;
  return {
    id: app.id,
    label: app.label,
    root: app.root,
    scripts: app.scripts,
    pm2Name: app.pm2Name ?? null,
    logsDir: app.logsDir ?? null,
    notes: app.notes ?? null,
    env: redactAppEnv(app.env),
    ownerNpub: app.ownerNpub,
    autoStart: Boolean(app.autoStart),
    auto_start: Boolean(app.autoStart),
    lifecycleReviewRequired: Boolean(app.lifecycleReviewRequired),
    lifecycleReviewReasons: app.lifecycleReviewReasons ?? [],
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    webApp: app.webApp,
    webAppPort,
    webAppAlias,
    webAppUrl,
    subdomainAlias,
    subdomainUrl,
    customDomains,
    primaryUrl,
    status,
    availableScripts,
    logs: undefined as string[] | undefined,
  };
};

const deriveDirectoryNameFromUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const sanitized = trimmed.replace(/\\+/g, "/");
  const parts = sanitized.split(/[/:]/).filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  const last = parts[parts.length - 1] ?? "";
  return last.replace(/\.git$/i, "");
};

const humaniseAppLabel = (value: string): string => {
  const spaced = value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) {
    return value;
  }
  return spaced
    .split(" ")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
};

const collectBunScriptDefaults = async (
  directory: string,
): Promise<Partial<AppLifecycleScripts>> => {
  try {
    const packageJsonPath = join(directory, "package.json");
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const scripts = parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
    const result: Partial<AppLifecycleScripts> = {};
    const scriptNames: Array<"start" | "stop" | "restart" | "setup"> = [
      "start",
      "stop",
      "restart",
      "setup",
    ];
    for (const name of scriptNames) {
      const scriptValue = scripts?.[name];
      if (typeof scriptValue === "string" && scriptValue.trim().length > 0) {
        result[name] = appCommand("bun", "run", name);
      }
    }
    return result;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {};
    }
    console.warn(`[apps] Failed to read package.json while collecting scripts: ${err.message}`);
    return {};
  }
};

function resolveAppCloneGitEnv(viewerNpub: string | null | undefined): Record<string, string> | undefined {
  return getGitHubGitEnvForUser(viewerNpub, new URL("../data", import.meta.url).pathname) ?? undefined;
}

const cloneRepositoryIntoWorkspace = async (
  scope: WorkspaceScope,
  repositoryUrl: string,
  directoryName: string,
  viewerNpub: string | null,
): Promise<{ root: string; label: string; scripts: Partial<AppLifecycleScripts> }> => {
  const sanitizedDirectory = normaliseDirectoryEntryName(directoryName);
  const targetDirectory = normalize(join(scope.defaultDirectory, sanitizedDirectory));
  ensureWithinAllowedDirectories(targetDirectory, scope);

  try {
    const stats = await stat(targetDirectory);
    if (stats.isDirectory()) {
      throw new Error("Target directory already exists");
    }
    throw new Error("A non-directory entry exists at the target location");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  await mkdir(dirname(targetDirectory), { recursive: true });

  const cloneResult = await runCommand("git", ["clone", "--depth", "1", repositoryUrl, targetDirectory], {
    env: resolveAppCloneGitEnv(viewerNpub),
  });
  if (cloneResult.exitCode !== 0) {
    await rm(targetDirectory, { recursive: true, force: true }).catch(() => undefined);
    const message = cloneResult.stderr || cloneResult.stdout || "Failed to clone repository";
    throw new Error(message);
  }

  const scripts = await collectBunScriptDefaults(targetDirectory);
  const label = humaniseAppLabel(sanitizedDirectory) || sanitizedDirectory;
  const resolvedRoot = await realpath(targetDirectory).catch(() => targetDirectory);
  return { root: resolvedRoot, label, scripts };
};

const runGitOrThrow = async (
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<CommandResult> => {
  const result = await runCommand("git", args, options);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result;
};

const createRepositoryFromStarter = async (
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
): Promise<{
  root: string;
  label: string;
  scripts: Partial<AppLifecycleScripts>;
  github: {
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
}> => {
  const creds = getGitHubCredentialsForNpub(options.ownerNpub);
  if (!creds?.token) {
    throw new Error("GitHub token is not configured for this user. Add it in Settings > GitHub first.");
  }

  const gitEnv = getGitHubGitEnvForUser(options.ownerNpub, new URL("../data", import.meta.url).pathname) ?? {};
  const github = new GitHubApiClient(creds.token);
  const actor = await github.getAuthenticatedUser();
  const authorEnv: Record<string, string> = {
    ...gitEnv,
    GIT_AUTHOR_NAME: gitEnv.GIT_AUTHOR_NAME || creds.authorName || actor.login,
    GIT_AUTHOR_EMAIL: gitEnv.GIT_AUTHOR_EMAIL || creds.authorEmail || `${actor.id}+${actor.login}@users.noreply.github.com`,
    GIT_COMMITTER_NAME: gitEnv.GIT_COMMITTER_NAME || creds.authorName || actor.login,
    GIT_COMMITTER_EMAIL: gitEnv.GIT_COMMITTER_EMAIL || creds.authorEmail || `${actor.id}+${actor.login}@users.noreply.github.com`,
  };

  const sanitizedDirectory = normaliseDirectoryEntryName(options.directoryName);
  const targetDirectory = resolveStarterAppDirectory(scope, sanitizedDirectory);
  ensureWithinAllowedDirectories(targetDirectory, scope);

  try {
    const stats = await stat(targetDirectory);
    if (stats.isDirectory()) {
      throw new Error("Target directory already exists");
    }
    throw new Error("A non-directory entry exists at the target location");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw err;
  }

  await mkdir(dirname(targetDirectory), { recursive: true });

  const cloneResult = await runCommand("git", ["clone", "--depth", "1", options.starterGitUrl, targetDirectory], {
    env: authorEnv,
  });
  if (cloneResult.exitCode !== 0) {
    await rm(targetDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(cloneResult.stderr || cloneResult.stdout || "Failed to clone starter repository");
  }

  await rm(join(targetDirectory, ".git"), { recursive: true, force: true });

  const repo = await github.createRepository({
    owner: options.githubOwner,
    name: options.githubRepo,
    private: options.privateRepo,
    description: `Generated from Wingman starter "${options.appName}"`,
    authenticatedLogin: actor.login,
  });

  const initResult = await runCommand("git", ["init", "-b", "main"], { cwd: targetDirectory, env: authorEnv });
  if (initResult.exitCode !== 0) {
    await runGitOrThrow(["init"], { cwd: targetDirectory, env: authorEnv });
    await runGitOrThrow(["checkout", "-b", "main"], { cwd: targetDirectory, env: authorEnv });
  }
  await runGitOrThrow(["remote", "add", "origin", repo.cloneUrl], { cwd: targetDirectory, env: authorEnv });
  await runGitOrThrow(["add", "."], { cwd: targetDirectory, env: authorEnv });
  await runGitOrThrow(["commit", "-m", "Initial starter app"], { cwd: targetDirectory, env: authorEnv });
  await runGitOrThrow(["push", "-u", "origin", "main"], { cwd: targetDirectory, env: authorEnv });

  let deployedBranchCreated = false;
  if (options.createDeployedBranch) {
    await runGitOrThrow(["branch", "deployed"], { cwd: targetDirectory, env: authorEnv });
    await runGitOrThrow(["push", "-u", "origin", "deployed"], { cwd: targetDirectory, env: authorEnv });
    deployedBranchCreated = true;
  }

  const protection: {
    requested: boolean;
    main: "applied" | "skipped" | "failed";
    deployed: "applied" | "skipped" | "failed";
    warnings: string[];
  } = {
    requested: options.protectBranches,
    main: options.protectBranches ? "failed" : "skipped",
    deployed: options.protectBranches && deployedBranchCreated ? "failed" : "skipped",
    warnings: [],
  };

  if (options.protectBranches) {
    try {
      await github.protectBranch({
        owner: repo.owner,
        repo: repo.name,
        branch: "main",
        actorLogin: actor.login,
        mode: "main",
      });
      protection.main = "applied";
    } catch (error) {
      protection.main = "failed";
      protection.warnings.push(`main protection failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (deployedBranchCreated) {
      try {
        await github.protectBranch({
          owner: repo.owner,
          repo: repo.name,
          branch: "deployed",
          actorLogin: actor.login,
          mode: "deployed",
        });
        protection.deployed = "applied";
      } catch (error) {
        protection.deployed = "failed";
        protection.warnings.push(`deployed protection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const scripts = await collectBunScriptDefaults(targetDirectory);
  const label = options.appName || humaniseAppLabel(sanitizedDirectory) || sanitizedDirectory;
  const resolvedRoot = await realpath(targetDirectory).catch(() => targetDirectory);
  return {
    root: resolvedRoot,
    label,
    scripts,
    github: {
      owner: repo.owner,
      repo: repo.name,
      cloneUrl: repo.cloneUrl,
      htmlUrl: repo.htmlUrl,
      defaultBranch: "main",
      deployedBranchCreated,
      protection,
    },
  };
};

void ensureWingmanCoreRegistration(appRegistry, {
  projectRoot: projectRootPath,
  adminNpub,
});

const isAdminContext = (authContext: RequestAuthContext): boolean => {
  const normalized = normaliseNpub(authContext.npub ?? null);
  return isConfiguredAdminNpub(normalized);
};

/**
 * Verify a NIP-98 Authorization header and return its signer and any broker-attested session binding.
 * Returns null if no valid NIP-98 header is present.
 */
const nip98ReplayCache = new Nip98ReplayCache();

const verifyNip98AuthHeader = async (request: Request, url: URL): Promise<{
  signerNpub: string;
  capabilitySessionId: string | null;
} | null> => {
  const verified = await verifyNip98Request({
    request,
    requestUrl: url,
    configuredBaseUrl: config.baseUrl,
    replayCache: nip98ReplayCache,
  });
  if (!verified) return null;
  return {
    signerNpub: verified.signerNpub,
    capabilitySessionId: capabilityBroker.verifyNip98SessionBinding(verified.event),
  };
};

const resolveInternalNip98AuthContext = (
  request: Request,
  url: URL,
  authContext: RequestAuthContext,
): Promise<RequestAuthContext> =>
  resolveNip98AuthContext(request, url, authContext, {
    verifyNip98AuthHeader,
    lookupBotOwnerNpub: (botNpub) => botKeyStore.getActiveKeyForBotNpub(botNpub)?.userNpub ?? null,
  });

const requireAdminAccess = (): AccessRule => {
  return (context) => {
    if (!adminNpub) {
      return deny("admin-only", 403);
    }
    return isAdminContext(context.auth) ? allow() : deny("admin-only", 403);
  };
};

registerAccessRule(AccessActions.SystemManage, requireAdminAccess());
registerAccessRule(AccessActions.AdminUsers, requireAdminAccess());
registerAccessRule(AccessActions.FeatureFlagsManage, requireAdminAccess());
registerAccessRule(AccessActions.TerminalAccess, requireAdminAccess());

const accessDeniedJson = (decision: AccessDecision): Response => {
  const headers = new Headers({
    "cache-control": "no-store",
    ...(decision.headers ?? {}),
  });
  return Response.json({ error: decision.reason ?? "forbidden" }, { status: decision.status ?? 403, headers });
};

const ensureApiAccess = async (
  action: AccessAction,
  request: Request,
  url: URL,
  authContext: RequestAuthContext,
): Promise<Response | null> => {
  const decision = await evaluateAccess(action, { request, url, auth: authContext });
  if (!decision.allowed) {
    return accessDeniedJson(decision);
  }
  return null;
};

const ensurePageAccess = async (
  action: AccessAction,
  request: Request,
  url: URL,
  authContext: RequestAuthContext,
): Promise<Response | null> => {
  const decision = await evaluateAccess(action, { request, url, auth: authContext });
  if (!decision.allowed) {
    const headers = new Headers({
      "cache-control": "no-store",
      ...(decision.headers ?? {}),
    });
    return new Response("Unauthorized", { status: decision.status ?? 403, headers });
  }
  return null;
};

// serialiseFeatureFlag and serialiseFeatureFlagsForViewer moved to ./server/feature-flags-routes.ts

const resolveFeatureFlagStateForViewer = (
  key: string,
  viewerIsAdmin: boolean,
  fallbackState: FeatureFlagState = "off",
) => {
  const normalizedKey = normaliseFeatureFlagKey(key);
  const flag = normalizedKey ? featureFlagStore.getFlag(normalizedKey) : null;
  const baseState = flag?.state ?? fallbackState;
  const effectiveState = resolveFeatureFlagEffectiveState(baseState, viewerIsAdmin);
  return { flag, state: baseState, effectiveState };
};

const sessionApiContext: SessionApiContext = {
  manager,
  adminNpub,
  adminNpubs: configuredAdminNpubs,
  isAdminNpub: isConfiguredAdminNpub,
  agentHost,
  messageStore,
  userSettingsStore,
  sessionArchiveStore,
  identityUserStore,
  promptQueueStore,
  artifactsStore,
  userIdentityRoot,
  attachmentRoot,
  imageRoot,
  ensureApiAccess,
  resolveWorkspace,
  serializeSession,
  sessionBelongsToViewer,
  getViewerNormalizedNpub,
  buildIdentitySummaries,
  createSessionSubscribeResponse,
  handleSessionEvents,
  syncSessionMessages,
  waitForMessageUpdate,
  scheduleSessionArchive,
  cancelPendingArchive,
  isAgentType,
  normaliseSessionNameInput,
  parseSessionWorkspaceRequest,
  resolveSessionWorkingDirectory,
  parseSessionOriginInput,
  parseNightWatchStartOptions,
  buildAgentUrl,
  enableNightWatch: (sessionId, options) => {
    nightWatchStore.enableSession(sessionId, {
      prompt: options?.prompt,
      intervalMinutes: options?.intervalMinutes,
      maxCycles: options?.maxCycles,
    });
  },
  queueDispatchInFlight,
  maybeAutoDispatchQueuedPrompt,
  dispatchNextQueuedPromptForSession,
  getPromptReadinessForSession: (session) =>
    getSessionPromptReadiness({
      session,
      adapter: manager.getAdapter(session.id),
      timeoutMs: 750,
    }),
  validateForkInput,
  getRecentMessages,
  formatMessagesAsContext,
  createGitWorktree,
  forkCodexSession: forkCodexSessionFile,
  workspaceDelegationStore,
  AccessActions,
  documentDirectStore,
  canViewDocumentSubscription: (subscriptionId, viewerNpub) =>
    Boolean(workspaceSubscriptionManager.getForManager(subscriptionId, viewerNpub)),
  resolveDocumentSessionStatus: (sessionId) => {
    if (!sessionId) return 'absent';
    return manager.getSession(sessionId)?.status
      ?? messageStore.getSession(sessionId)?.runtimeStatus
      ?? (sessionArchiveStore.getArchivedSession(sessionId) ? 'archived' : 'absent');
  },
};
sessionApiContextRef = sessionApiContext;
const sessionDispatchService = new SessionDispatchService(
  sessionDispatchStore,
  manager,
  promptQueueStore,
  (session) => maybeAutoDispatchQueuedPrompt(session),
  {},
  (sessionId) => closeDispatchedWorker(
    sessionId,
    manager,
    (workerSessionId) => scheduleSessionArchive(workerSessionId, manager),
  ),
  sessionDispatchInbox,
  (sessionId) => maybeAutoDispatchQueuedPrompt(manager.getSession(sessionId) ?? null),
);
sessionDispatchService.start();
const dispatchPipelineRuntime = new DispatchPipelineRuntime({
  pipelineStore,
  getSessionApiContext: () => sessionApiContextRef,
  getBotIdentityForSubscription: (subscriptionId) =>
    workspaceSubscriptionManager.getRuntimeBotIdentity(subscriptionId),
  callbackOrigin: `http://127.0.0.1:${config.port}`,
  requirePipelineRoutes: true,
  defaultAgent: config.defaultAgent,
  publicationFilter: duplicateCallbackPublicationFilter,
});
workspaceSubscriptionManager.setDispatchPipelineRuntime(dispatchPipelineRuntime);

await workspaceSubscriptionManager.startupReload();
const agentProfileMetadataCache = new AgentProfileMetadataCache({
  store: agentDefinitionStore,
  defaultAgentNpub: wingmanInstanceIdentity?.npub ?? null,
  relays: config.connectRelays,
  log: console,
});
await agentProfileMetadataCache.start();
flightDeckSessionTurnBridge.recover();
agentDirectDeliveryReconciler.start();

void resumeRunningPipelineRuns({
  store: pipelineStore,
  sessionApiContext,
  callbackOrigin: `http://127.0.0.1:${config.port}`,
  loadRegistryForRun: ({ run, definition }) =>
    dispatchPipelineRuntime.loadRegistryForStoredRun({ run, definition, sessionApiContext }),
  ensureApiAccess,
  AccessActions,
}, `http://127.0.0.1:${config.port}`).catch((error) => {
  console.warn("[pipelines] failed to resume running pipeline runs:", error instanceof Error ? error.message : String(error));
});

const docsApiContext: DocsApiContext = {
  resolveWorkspace,
  ensureApiAccess,
  AccessActions,
  ensureDirectory,
  createGitWorktree,
  executeGitCommand,
  describeGitRepository,
};

const providerProxyApiContext: ProviderProxyApiContext = {
  billingService: teamBillingService,
  getSession: (sessionId) => manager.getSession(sessionId) ?? null,
  ensureProviderApiKey: () => teamBillingService.getProviderApiKey(),
};

const billingApiContext: BillingApiContext = {
  billingService: teamBillingService,
  ensureApiAccess,
  AccessActions,
};

// Mutable reference filled in after Bun.serve() returns its server object.
// Used to provide request IP resolution to the API route handler without a
// forward-reference issue (the server const is defined after handleApi).
const serverRef: { current: { requestIP: (req: Request) => { address: string } | null } | null } = { current: null };
const terminalConfig = resolveTerminalConfig({ defaultCwd: projectRootPath });
const terminalTickets = new TerminalTicketStore({ ttlMs: terminalConfig.ticketTtlMs });
const terminalSessions = new TerminalSessionManager(terminalConfig);
const terminalPinService = new TerminalPinService(instanceSettingsStore);
const terminalPinRateLimiter = new TerminalPinRateLimiter();
const terminalWebSocketContext = {
  tickets: terminalTickets,
  sessions: terminalSessions,
  pinService: terminalPinService,
  isAdminNpub: isConfiguredAdminNpub,
};
const remoteInstructRoutesContext: RemoteInstructRoutesContext = {
  promptPath: join(projectRootPath, "data", "remote-instruct.md"),
  config: {
    baseUrl: config.baseUrl,
    agents: config.agents,
  },
  getDefaultWorkdir: (context) => resolveWorkspace(context).defaultDirectory,
  projectReference: Bun.env.REMOTE_INSTRUCT_PROJECT_REFERENCE?.trim() || null,
  resolveNip98AuthContext: resolveInternalNip98AuthContext,
  ensureApiAccess,
  ensureTemplateManageAccess: (request, url, authContext) =>
    ensureApiAccess(AccessActions.SystemManage, request, url, authContext),
  AccessActions,
};

const handleApi = createApiRouteHandler({
  sessionDispatchService,
  getRequestIP: (req) => serverRef.current?.requestIP(req) ?? null,
  config: {
    port: config.port,
    baseUrl: config.baseUrl,
    agentPortStart: config.agentPortStart,
    agentPortMax: config.agentPortMax,
    hostUrlBase: config.hostUrlBase,
    appRoutingMode: config.appRoutingMode,
    subdomainBaseDomain: config.subdomainBaseDomain,
    subdomainProxyEnabled: config.subdomainProxyEnabled,
    connectRelays: config.connectRelays,
    agents: config.agents,
    defaultAgent: config.defaultAgent,
    giteaUrl: config.giteaUrl,
  },
  adminNpub,
  adminNpubs: configuredAdminNpubs,

  // Pre-instantiated API handlers
  todoApiHandler,
  projectApiHandler,
  npubProjectApiHandler,
  browserLogHandler,
  caproverApiHandler,
  nightWatchApiHandler,
  nip98ApiHandler,
  botCryptoApiHandler,
  capabilityBrokerApiHandler: (request, url, method) => capabilityBroker.handle(request, url, method),
  botKeyApiHandler,
  giteaApiHandler,
  gitWorkflowApiHandler,
  ngitApiHandler,
  wingmanMcpApiHandler,
  schedulerApiHandler,
  schedulerStore,
  auditExecution: trustedExecutionRuleOptions.audit,

  // Pre-built route contexts (request-independent)
  sessionApiContext,
  docsApiContext,
  providerProxyApiContext,
  billingApiContext,
  systemRoutesContext: {
    restartMarkerPath,
    warmRestartManagerScriptPath,
    projectRoot,
    configPort: config.port,
    wingmanCoreTmuxSession: WINGMAN_CORE_TMUX_SESSION,
    manager,
    ensureApiAccess,
    AccessActions,
    isAgentType,
    isTrustedRestartAuthority: (authContext) => {
      const instanceNpub = wingmanInstanceIdentity?.npub ?? null;
      if (
        instanceNpub &&
        (authContext.actorNpub === instanceNpub || authContext.npub === instanceNpub)
      ) return true;
      const signerNpub = authContext.signerNpub ?? authContext.actorNpub ?? authContext.npub;
      if (!signerNpub || authContext.authMethod !== "nip98") return false;
      const botRecord = botKeyStore.getActiveKeyForBotNpub(signerNpub);
      if (!botRecord) return false;
      return manager.listSessions().some((session) =>
        session.npub === botRecord.userNpub &&
        (session.status === "starting" || session.status === "running")
      );
    },
    setSessionsStoppedForRestart: (v) => { sessionsStoppedForRestart = v; },
    initiateShutdown: (reason: string) => initiateShutdown(reason),
    performSystemCleanup: (deps: Parameters<typeof performSystemCleanup>[0]) => performSystemCleanup(deps),
    messageStore,
    appProcessManager,
    appRegistry,
  },
  authApiContext: {
    config: {
      baseUrl: config.baseUrl,
      registrationEnabled: config.registrationEnabled,
      connectRelays: config.connectRelays,
      giteaUrl: config.giteaUrl,
      giteaApiToken: config.giteaApiToken,
      giteaOwner: config.giteaOwner,
    },
    adminNpub,
    isAdminNpub: isConfiguredAdminNpub,
    identityUserStore,
    mintSessionCookie,
    getSessionCookieName,
    SessionCookieError,
    SESSION_COOKIE_NAME,
    shouldUseSecureCookies,
    loginChallengeStore,
    generateIdentityAlias,
    handleKeyTeleport,
    handleKeyTeleportRegistration,
    ensureGiteaUser,
    ensureApiAccess,
    AccessActions,
    getViewerNormalizedNpub,
    normaliseOptionalString,
    resolveAndCacheNostrProfile,
    onSessionAuthenticated: (npub: string) => {
      try {
        identityUserStore.touch(npub);
        teamBillingService.syncTeamMembers();
        if (teamBillingService.isCreditsEnabled()) {
          void teamBillingService.primeProviderKeyCache().catch((error) => {
            console.warn(`[billing] failed to prime provider key cache at login: ${(error as Error).message}`);
          });
        }
      } catch (error) {
        console.warn(`[billing] failed to update team members for ${npub}: ${(error as Error).message}`);
      }
    },
  },
  adminUsersApiContext: {
    adminNpub,
    isAdminNpub: isConfiguredAdminNpub,
    config: { connectRelays: config.connectRelays },
    identityUserStore,
    manager,
    ensureApiAccess,
    AccessActions,
    normaliseOptionalString,
    stopSessionsForUser,
    resolveAndCacheNostrProfile,
    buildIdentitySummaries,
  },
  uploadApiContext: {
    imageRoot,
    attachmentRoot,
    isAdminContext,
    isAgentType,
    ensureImageDirectory,
    ensureAttachmentDirectory,
    createImageFilename,
    createAttachmentFilename,
    buildAgentImagePlaceholder,
    buildAgentFilePlaceholder,
    ensureApiAccess,
    AccessActions,
  },
  agentChatApiContext: {
    manager: workspaceSubscriptionManager,
    adminNpub,
    sharedAgentDispatch: sharedAgentDispatchEnabled,
    isAdminContext,
    publishAgentProfile: async ({ event, agent }) => {
      const record = botKeyStore.getActiveKeyForBotNpub(agent.botNpub);
      if (!record || record.userNpub !== agent.managedByNpub) throw new Error('Agent identity binding is unavailable.');
      ensureLegacyBrokerRecordProvisioned({ vault: brokerKeyVault, record, instanceIdentity: wingmanInstanceIdentity });
      return publishBotProfileEvent({
        botPubkeyHex: record.botPubkeyHex,
        signedEvent: event,
        defaultRelays: config.connectRelays,
      });
    },
    republishAgentProfile: async (agent) => {
      const record = botKeyStore.getActiveKeyForBotNpub(agent.botNpub);
      if (!record || record.userNpub !== agent.managedByNpub) throw new Error('Agent identity binding is unavailable.');
      ensureLegacyBrokerRecordProvisioned({ vault: brokerKeyVault, record, instanceIdentity: wingmanInstanceIdentity });
      return brokerKeyVault.withKey(record, async (secretKey) => {
        const signedEvent = signBotProfileEvent(secretKey, agent.publicProfile?.name || agent.label, agent.publicProfile);
        const result = await publishBotProfileEvent({
          botPubkeyHex: record.botPubkeyHex,
          signedEvent,
          defaultRelays: config.connectRelays,
        });
        return { ...result, createdAt: signedEvent.created_at };
      });
    },
    rotateAgentProfileKey: (input) => agentProfileKeyRotation.rotate(input),
  },
  voiceNoteUploadApiContext: {
    imageRoot,
    attachmentRoot,
    isAdminContext,
    isAgentType,
    ensureImageDirectory,
    ensureAttachmentDirectory,
    createImageFilename,
    createAttachmentFilename,
    buildAgentImagePlaceholder,
    buildAgentFilePlaceholder,
    ensureApiAccess,
    AccessActions,
  },
  delegationRoutesContext: {
    workspaceDelegationStore,
    ensureApiAccess,
    AccessActions,
  },
  pipelineApiContext: {
    store: pipelineStore,
    sessionApiContext,
    callbackOrigin: `http://127.0.0.1:${config.port}`,
    sharedInstanceAccess: sharedInstanceAccessEnabled,
    loadRegistryForRun: ({ run, definition }) =>
      dispatchPipelineRuntime.loadRegistryForStoredRun({ run, definition, sessionApiContext }),
    ensureApiAccess,
    AccessActions,
  },
  signingApiContext: {
    signingSecret: instanceSettingsService.get("internal.signing_secret"),
    getSession: (sid: string) => manager.getSession(sid),
    getInstanceIdentity: () => loadWingmanInstanceIdentity(),
  },
  terminalRoutesContext: {
    config: terminalConfig,
    tickets: terminalTickets,
    sessions: terminalSessions,
    pinService: terminalPinService,
    rateLimiter: terminalPinRateLimiter,
    ensureApiAccess,
    AccessActions,
  },
  userSettingsRoutesContext: {
    agents: config.agents,
    userSettingsStore,
    ensureApiAccess,
    AccessActions,
  },
  instanceSettingsRoutesContext: {
    service: instanceSettingsService,
    ensureApiAccess,
    AccessActions,
  },
  remoteInstructRoutesContext,
  cloudflareTunnelRoutesContext: {
    AccessActions,
    ensureApiAccess,
    getClient: createCloudflareTunnelClientFromEnv,
  },
  workspaceDelegationStore,

  // Stores accessed directly
  featureFlagStore,
  userSettingsStore,
  artifactsStore,

  // Constants
  PROJECTS_FLAG_KEY,

  // Core helpers
  resolveWorkspace,
  verifyNip98AuthHeader,
  resolveNip98AuthContext: resolveInternalNip98AuthContext,
  resolveFeatureFlagStateForViewer,
  ensureApiAccess,
  serialiseFeatureFlagsForViewer: (isAdmin: boolean) =>
    serialiseFeatureFlagsForViewer(featureFlagStore, isAdmin),
  listDirectories,
  createDirectoryEntry,
  AccessActions,

  // Per-request context builders
  buildStarterProjectsContext: (workspaceScope, viewerNpub) => {
    const defaultTowerBinding = wappStore.getDefaultTowerBinding();
    return {
      adminNpub,
      workspaceScope,
      viewerNpub,
      AccessActions,
      ensureApiAccess,
      normaliseOptionalString,
      normaliseNpub,
      createRepositoryFromStarter,
      buildAppResponse,
      appRegistry,
      appProcessManager,
      appAliasRegistry,
      wingmanUrl: `http://127.0.0.1:${config.port}`,
      towerUrl: defaultTowerBinding?.towerUrl ?? defaultTowerUrl,
      towerWorkspaceOwnerNpub: defaultTowerBinding?.workspaceOwnerNpub ?? null,
      towerRegistrationIdentity,
      towerWappRegistrar,
      starterProjectStore,
      npubProjectStore,
    };
  },
  buildAppsContext: (appsAuthContext, workspaceScopeOverride, canAccessAppOverride) => {
    const effectiveAppsAuthContext = getEffectiveOwnerAuthContext(appsAuthContext);
    const appsWorkspaceScope = workspaceScopeOverride ?? resolveWorkspace(effectiveAppsAuthContext);
    const appsViewerNpub = getEffectiveOwnerNpub(effectiveAppsAuthContext);
    const canAccessAppForRequest = (app: AppRecord): boolean => {
      if (canAccessAppOverride) {
        return canAccessAppOverride(app);
      }
      if (sharedInstanceAccessEnabled && appsViewerNpub) return true;
      if (appsWorkspaceScope.isAdmin) return true;
      if (!appsViewerNpub) return false;
      return app.ownerNpub === appsViewerNpub;
    };
    return {
      adminNpub,
      sharedInstanceAccess: sharedInstanceAccessEnabled,
      workspaceScope: appsWorkspaceScope,
      viewerNpub: appsViewerNpub,
      AccessActions,
      ensureApiAccess,
      normaliseOptionalString,
      normaliseNpub,
      ensureDirectory,
      ensureWithinAllowedDirectories,
      parseAppScripts,
      parseBooleanInput,
      parsePortInput,
      parseBooleanFlag,
      appActions: APP_ACTIONS,
      canAccessApp: canAccessAppForRequest,
      deriveDirectoryNameFromUrl,
      cloneRepositoryIntoWorkspace,
      scanDirectoryTree,
      buildAppOwnerFilters,
      defaultAppProcessStatus,
      resolveOwnerAliasCached,
      buildAppResponse,
      appRegistry,
      appProcessManager,
      appAliasRegistry,
      appDomainRegistry,
      wappStore,
      npubProjectStore,
      createCaproverTargetClientsFromEnv,
      createAppTarball,
      caproverStore,
    };
  },
  buildFeatureFlagsContext: (viewerIsAdmin) => ({
    featureFlagStore,
    viewerIsAdmin,
    ensureApiAccess,
    AccessActions,
  }),
  buildChatContext: (npub, isAdmin) => ({
    config,
    npub,
    isAdmin,
    recordUsage: async (data) => {
      await teamBillingService.recordProxyUsage({
        sessionId: data.sessionId,
        npub: npub ?? null,
        agent: 'chat',
        endpoint: '/v1/chat/completions',
        method: 'POST',
        statusCode: 200,
        costUsd: null,
      });
    },
  }),
  buildWappsContext: (wappsAuthContext, canAccessAppOverride) => {
    const effectiveAuthContext = getEffectiveOwnerAuthContext(wappsAuthContext);
    const appsWorkspaceScope = resolveWorkspace(effectiveAuthContext);
    const appsViewerNpub = getEffectiveOwnerNpub(effectiveAuthContext);
    const canAccessAppForRequest = (app: AppRecord): boolean => {
      if (canAccessAppOverride) return canAccessAppOverride(app);
      if (sharedInstanceAccessEnabled && appsViewerNpub) return true;
      if (appsWorkspaceScope.isAdmin) return true;
      if (!appsViewerNpub) return false;
      return app.ownerNpub === appsViewerNpub;
    };
    return {
      adminNpub,
      viewerNpub: appsViewerNpub,
      actorNpub: wappsAuthContext.subjectNpub ?? wappsAuthContext.signerNpub ?? wappsAuthContext.npub,
      sourceWingmanUrl: config.baseUrl,
      flightDeckAppNamespace: wingmanInstanceIdentity?.npub ?? adminNpub ?? "autopilot",
      AccessActions,
      ensureApiAccess,
      ensureDirectory: (root: string) => ensureDirectory(root, appsWorkspaceScope),
      canAccessApp: canAccessAppForRequest,
      appRegistry,
      appAliasRegistry,
      wappStore,
      publisher: wappPublisher,
      scopeAccessResolver: wappScopeAccessResolver,
      towerRegistrationIdentity,
      towerWappRegistrar,
      installationIntentConsumer,
      hasWappActivityAuthority: (requestAuthContext, installationId) =>
        hasWappActivityAuthority(
          requestAuthContext,
          installationId,
          (sessionId) => manager.getSession(sessionId),
          (triggerId) => schedulerStore.getJob(triggerId)?.wappActivityInstallationId,
        ),
      buildLaunchUrl: (alias, app) => {
        const aliasUrl = buildAppHostUrl(alias);
        if (aliasUrl) {
          return aliasUrl.startsWith("http") ? aliasUrl : new URL(aliasUrl, config.baseUrl).toString();
        }
        const fallbackUrl = app.webApp && app.webAppPort ? buildHostedWebAppUrl(app.webAppPort) : null;
        return fallbackUrl ?? config.baseUrl;
      },
    };
  },
});

/**
 * Apply browser security headers to every control-plane response.
 * CSP is deferred to report-only mode in a follow-up — it requires
 * an inventory of script/style/image/connect sources first.
 */
function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const server = Bun.serve<WingmanWebSocketData>({
  port: config.port,
  // Disable idle timeout for SSE connections (default is 10 seconds)
  idleTimeout: 255, // Max value in seconds (about 4 minutes)
  async fetch(request: Request, requestServer): Promise<Response | undefined> {
    const url = new URL(request.url);
    const method = request.method as HttpMethod;
    const authContext = resolveRequestAuthContext(request);

    const response = await runWithRequestContext(authContext, async () => {
      if (authContext.error) {
        console.warn(`[auth] ignoring invalid session cookie: ${authContext.error}`);
      }

      const pathname = url.pathname;
      const httpsRedirect = redirectInsecurePublicRequest(request, url, config.baseUrl);
      if (httpsRedirect) {
        return httpsRedirect;
      }

      const appHostResponse = await handleAppHostRequest(request, subdomainProxyConfig, requestServer);
      if (appHostResponse) {
        return appHostResponse;
      }

      const terminalUpgradeResponse = await handleTerminalWebSocketUpgrade(
        request,
        url,
        authContext,
        requestServer,
        terminalWebSocketContext,
      );
      if (terminalUpgradeResponse !== null) {
        return terminalUpgradeResponse;
      }

      const webhookResponse = await handleWebhookRequest(request, url, authContext);
      if (webhookResponse) {
        return webhookResponse;
      }

      // Handle path-based app routing (/host/<alias> and /host/<alias>/*)
      if (pathname.startsWith("/host/")) {
        const pathHostResponse = await handlePathBasedAppRequest(request, pathname, requestServer);
        if (pathHostResponse) {
          return pathHostResponse;
        }
      }

      if (pathname === "/" && method === "GET") {
        const homeUrl = configuredPublicRequestUrl(url, config.baseUrl) ?? forwardedRequestUrl(request, url);
        homeUrl.pathname = "/home";
        return Response.redirect(homeUrl.toString(), 302);
      }

      // Serve UI module assets before API routing so paths like
      // /api/admin-users.js resolve to src/ui/api/ instead of the
      // JSON API handler.
      const earlyStaticResponse = await staticRoutes.serveBeforeApi(request, pathname);
      if (earlyStaticResponse) {
        return earlyStaticResponse;
      }

      if (pathname.startsWith("/api/")) {
        return handleApi(request, url, method, authContext);
      }

      const tempAttachment = resolveTempAttachment(pathname, authContext, { attachmentRoot, isAdminContext });
      if (tempAttachment) {
        return tempAttachment;
      }

      const tempImage = resolveTempImage(pathname, authContext, { imageRoot, isAdminContext });
      if (tempImage) {
        return tempImage;
      }

      return staticRoutes.serveAfterApi(request, pathname);
    });

    if (!response) {
      return undefined;
    }
    return maybeRefreshSessionCookie(
      applySecurityHeaders(response),
      authContext,
      { secureCookie: shouldUseSecureCookies(request) },
    );
  },
  error(error: Error): Response {
    console.error("[server] unhandled request error:", error);
    return Response.json(
      { error: error.message || "Internal Server Error" },
      { status: 500 },
    );
  },
  websocket: createWingmanWebSocketHandler(terminalWebSocketContext),
});

// Wire up the request-IP resolver now that the server object exists.
serverRef.current = server;

const stopAllSessions = async () => {
  if (sessionsStoppedForRestart) {
    console.log("[shutdown] agent sessions were stopped for managed restart");
    return;
  }

  const sessions = manager.listSessions();
  for (const session of sessions) {
    try {
      await manager.stopSession(session.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[shutdown] failed to stop session ${session.id}: ${message}`);
    }
  }
};

let shuttingDown = false;
const initiateShutdown = async (reason: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] initiated by ${reason}. Shutting down services...`);

  try {
    schedulerEngine.stop();
  } catch (error) {
    console.warn(`[shutdown] failed to stop scheduler engine: ${error instanceof Error ? error.message : String(error)}`);
  }

  agentProfileMetadataCache.stop();

  try {
    fileWatcherRunner.stop();
  } catch (error) {
    console.warn(`[shutdown] failed to stop file watcher runner: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    server.stop();
  } catch (error) {
    console.warn(`[shutdown] failed to stop server: ${error instanceof Error ? error.message : String(error)}`);
  }

  await stopAllSessions();
  process.exit(0);
};

const registerShutdownHandlers = () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGQUIT"] as const) {
    process.on(signal, () => {
      void initiateShutdown(signal);
    });
  }
};

registerShutdownHandlers();

console.log(
  `Wingman V2 listening on http://localhost:${config.port} (agents ${config.agentPortStart} - ${config.agentPortStart + config.agentPortMax - 1})`,
);

// Start scheduler engine (loads enabled jobs from DB)
schedulerEngine.start();

export { server, manager, config };
