import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";

import type { AgentDefinition, AgentType, WingmanConfig } from "../config";
import { getAuthenticatedNpub } from "../auth/request-context";
import { generateIdentityAlias } from "../identity/identity-alias";
import { getConfiguredAdminNpubs, isNpubInList, normaliseNpub } from "../identity/npub-utils";
import { isPortAvailable } from "../utils/port-utils.js";
import { sanitizeLogEntry } from "../logging/log-sanitizer";
import { trackProjectForSession } from "../projects/npub-project-tracker";
import type { AgentRuntimeStatus } from "../types/agent-status";
import type { AgentAdapter, AdapterSessionContext, AgentTransport } from "./agent-adapter";
import {
  resolveAdapterFactory,
  resolveAgentTransport,
  OPENCODE_NATIVE_SDK_FLAG,
} from "./agent-adapter";
import {
  DEFAULT_ACP_PERMISSION_POLICY,
  LEGACY_ACP_PERMISSION_POLICY,
  parseAcpPermissionPolicy,
} from "./acp-permission-policy";
import { featureFlagStore, resolveFeatureFlagEffectiveState } from "../storage/feature-flag-store";
import {
  type SessionMetadata,
  type SessionMetadataInput,
  normaliseSessionMetadata,
} from "../sessions/session-metadata";
import {
  createAgentPm2StartOptions,
  getLogsDirectory,
  removeAppFromEcosystem,
  type SessionConfig,
} from "./ecosystem-generator";
import {
  startProcess,
  stopProcess,
  deleteProcess,
  getProcessByName,
  waitForStatus,
} from "./pm2-wrapper";
import { injectMcpConfig, cleanupMcpConfig } from "./mcp-injector";
import { stopManagedSubprocess } from "./process-stop";
import { buildWingmanIdentityEnv, loadWingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import { buildInheritedAgentEnvironment, sanitizeInjectedAgentEnvironment } from "./agent-environment";
import { BROKER_KEY_NOT_PROVISIONED } from "../signing/broker-key-vault";
import { parseAllowedHosts, pickAgentHost, normaliseHostForUrl, waitForAgentReady } from "./agent-client";
import { buildSessionGitCredentialEnv } from "../git/credential-env";
import { resolveGiteaCredentials } from "../gitea/gitea-user-manager";
import { discoverCodexSessionIdForPrompt } from "./codex-session-discovery";
import {
  buildTmuxLogFile,
  hasTmuxWindow,
  startTmuxProcess,
  stopTmuxWindow,
} from "./tmux-wrapper";
import {
  buildNativeAgentCommand,
  createNativeAgentSessionMetadata,
  getAdapterNativeSessionId,
  prepareNativeAgentSessionMetadata,
} from "./native-session";
import { instanceSettingsService } from "../settings/instance-settings-service";
import {
  getConfiguredOpenRouterModels,
  MODEL_PROVIDERS_SETTING_KEY,
  resolveRuntimeModel,
} from "../settings/openrouter-models";
import {
  OPENCODE_CONFIG_CONTENT_ENV,
  withOpenCodeModelConfigEnvironment,
} from "./opencode-model-config";

const MAX_LOG_LINES = 500;
const DEFAULT_PM2_AGENT_START_TIMEOUT_MS = 60_000;
const DEFAULT_GOOSE_PROVIDER = "openrouter";
const TMUX_AGENT_START_TIMEOUT_MS = 60_000;
const projectRootDirectory = normalize(new URL("../..", import.meta.url).pathname);
const CODEX_AGENTAPI_DISCOVERY_ATTEMPTS = 8;
const CODEX_AGENTAPI_DISCOVERY_RETRY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function shellQuoteAgentArgument(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Keep direct Bun-spawned AgentAPI sessions on the same process boundary as
 * PM2 sessions. In particular, run through a login shell and close stdin so
 * AgentAPI cannot inherit the Autopilot server's input stream. Athena exposed
 * a failure where the direct process bridge delivered a Direct Chat bootstrap
 * to Codex twice, while the equivalent PM2 wrapper delivered it once.
 */
export function buildBunAgentLaunchCommand(command: string[]): string[] {
  const quotedCommand = command.map(shellQuoteAgentArgument).join(" ");
  return ["bash", "-lc", `exec ${quotedCommand} < /dev/null`];
}

export function transportSkipsAgentApiSpawn(transport: AgentTransport): boolean {
  return ["codex-acp", "codex-sdk", "goose-acp", "maple-acp", "pi-acp"].includes(transport);
}

export function transportRequiresEagerReadiness(transport: AgentTransport): boolean {
  return transport === "codex-acp" ||
    transport === "goose-acp" ||
    transport === "maple-acp" ||
    transport === "pi-acp" ||
    transport === "opencode-sdk";
}

export function transportUsesAcpPermissionPolicy(transport: AgentTransport): boolean {
  return transport === "codex-acp" || transport === "goose-acp" || transport === "maple-acp" || transport === "pi-acp";
}

export function resolveNewSessionAcpPermissionPolicy(
  transport: AgentTransport,
  requestedPolicy: unknown,
  configuredPolicy: unknown,
) {
  if (!transportUsesAcpPermissionPolicy(transport)) return undefined;
  if (requestedPolicy !== undefined && requestedPolicy !== null && requestedPolicy !== "") {
    const requested = parseAcpPermissionPolicy(requestedPolicy);
    if (!requested) throw new Error("ACP permission policy must be auto_approve or ask");
    return requested;
  }
  return parseAcpPermissionPolicy(configuredPolicy) ?? DEFAULT_ACP_PERMISSION_POLICY;
}

export type SessionStatus = "starting" | "running" | "stopped" | "error";

export interface SessionOrigin {
  type: string;
  id: string;
  url?: string;
  label?: string;
}

export interface SessionSnapshot {
  id: string;
  agent: AgentType;
  port: number;
  name: string;
  status: SessionStatus;
  agentRuntimeStatus?: AgentRuntimeStatus;
  startedAt: string;
  npub?: string;
  pid?: number;
  command: string[];
  workingDirectory: string;
  exitCode?: number;
  logs: string[];
  origin?: SessionOrigin;
  userAlias?: string;
  isAdmin?: boolean;
  /** PM2 process name if spawned via PM2 */
  pm2Name?: string;
  /** Tmux session name if spawned in tmux */
  tmuxSession?: string;
  /** Tmux window name if spawned in tmux */
  tmuxWindow?: string;
  /** Target file for writer-mode sessions */
  targetFile?: string;
  /** File pinned as artifact in the UI right-hand panel */
  pinnedFile?: string;
  /** Explicit 1-based ordering for live session tabs */
  tabOrder?: number | null;
  metadata?: SessionMetadata;
  /** Selected model for the session */
  model?: string;
}

type SessionEvent =
  | { type: "session-started"; session: SessionSnapshot }
  | {
      type: "session-updated";
      session: SessionSnapshot;
      artifactIntent?: {
        action: "open";
        filePath: string;
        pinnedFiles: string[];
      };
    }
  | { type: "session-stopped"; session: SessionSnapshot }
  | { type: "session-deleted"; session: SessionSnapshot };

export interface RehydrateSessionInput {
  id: string;
  agent: AgentType;
  port: number;
  name: string;
  startedAt: string;
  workingDirectory: string;
  command?: string[];
  pid?: number;
  logs?: string[];
  npub?: string;
  agentRuntimeStatus?: AgentRuntimeStatus | null;
  origin?: SessionOrigin | null;
  /** PM2 process name if this was a PM2-managed session */
  pm2Name?: string;
  /** Tmux session name if this was a tmux-managed session */
  tmuxSession?: string;
  /** Tmux window name if this was a tmux-managed session */
  tmuxWindow?: string;
  /** Target file for writer-mode sessions */
  targetFile?: string;
  /** File pinned as artifact in the UI right-hand panel */
  pinnedFile?: string;
  /** Explicit 1-based ordering for live session tabs */
  tabOrder?: number | null;
  metadata?: SessionMetadataInput;
  /** Selected model for the session */
  model?: string;
}

export interface BillingLaunchInput {
  sessionId: string;
  agent: AgentType;
  npub: string | null;
}

export interface BillingLaunchResult {
  billingMode: "credits" | "subscription";
  env: Record<string, string>;
  commandArgs?: string[];
  /** Structured Codex `--config` overrides for the native SDK adapter. */
  codexConfig?: Record<string, unknown>;
  fallbackReason: string | null;
}

/** Callback for native SDK adapters to report usage to the billing ledger */
export type RecordAdapterUsage = (data: {
  sessionId: string;
  npub: string | null;
  agent: string;
  endpoint: string;
  costUsd?: number | null;
  inputTokens?: number;
  outputTokens?: number;
}) => Promise<void>;

export interface ProcessManagerOptions {
  resolveBillingLaunchConfig?: (input: BillingLaunchInput) => Promise<BillingLaunchResult>;
  recordAdapterUsage?: RecordAdapterUsage;
  issueSessionCapability?: (input: {
    sessionId: string;
    ownerNpub: string;
    profileId?: string | null;
    botNpub?: string | null;
  }) => {
    token: string;
    botNpub: string;
    botPubkeyHex: string;
    expiresAt: string;
  };
  revokeSessionCapabilities?: (sessionId: string) => void;
  resolveTowerGitGatewayOrigins?: (input: {
    sessionId: string;
    capabilityToken: string;
    brokerUrl: string;
  }) => Promise<string[]>;
}

interface AgentSession {
  id: string;
  agent: AgentType;
  port: number;
  name: string;
  status: SessionStatus;
  startedAt: Date;
  process: Bun.Subprocess | null;
  definition: AgentDefinition;
  workingDirectory: string;
  command: string[];
  logs: string[];
  exitCode?: number;
  detachedPid?: number;
  npub?: string;
  agentRuntimeStatus?: AgentRuntimeStatus;
  origin?: SessionOrigin;
  userAlias?: string;
  isAdmin?: boolean;
  /** PM2 process name when spawned via PM2 */
  pm2Name?: string;
  /** Tmux session name when spawned in tmux */
  tmuxSession?: string;
  /** Tmux window name when spawned in tmux */
  tmuxWindow?: string;
  /** Log file populated by tmux pipe-pane. */
  tmuxLogFile?: string;
  /** Target file for writer-mode sessions */
  targetFile?: string;
  /** File pinned as artifact in the UI right-hand panel */
  pinnedFile?: string;
  /** Explicit 1-based ordering for live session tabs */
  tabOrder?: number | null;
  metadata: SessionMetadata;
  /** Files created by MCP config injection to clean up on session stop. */
  mcpCleanupFiles?: string[];
  /** Model selection for this session */
  model?: string;
  /**
   * Structured Codex `--config` overrides (MCP, billing) merged at launch and
   * handed to the native Codex SDK adapter, which spawns no CLI to receive
   * `-c` flags.
   */
  codexConfig?: Record<string, unknown>;
  /** Protocol adapter for communicating with this agent */
  adapter?: AgentAdapter;
}

type McpCleanupSessionLike = Pick<AgentSession, "id" | "status" | "mcpCleanupFiles">;

/**
 * Determines whether a PM2-managed session should be marked as stopped
 * based on whether the PM2 entry was successfully removed.
 */
export function pm2StopShouldMarkStopped(result: { deletedFromPm2: boolean }): boolean {
  return result.deletedFromPm2;
}

export function shouldCleanupMcpFiles(
  sessions: Iterable<McpCleanupSessionLike>,
  sessionId: string,
  cleanupFiles: string[],
): boolean {
  if (cleanupFiles.length === 0) {
    return false;
  }

  const targetFiles = new Set(cleanupFiles);
  for (const candidate of sessions) {
    if (candidate.id === sessionId) continue;
    if (candidate.status !== "starting" && candidate.status !== "running") continue;
    if (!candidate.mcpCleanupFiles || candidate.mcpCleanupFiles.length === 0) continue;

    for (const filePath of candidate.mcpCleanupFiles) {
      if (targetFiles.has(filePath)) {
        return false;
      }
    }
  }

  return true;
}

async function prepareCodexApiAuthHome(env: Record<string, string>): Promise<void> {
  const codexHome = typeof env.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  if (!codexHome) return;

  const apiKeyCandidate =
    (typeof env.CODEX_API_KEY === "string" ? env.CODEX_API_KEY : "") ||
    (typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY : "");
  const apiKey = apiKeyCandidate.trim();
  if (!apiKey) return;

  await mkdir(codexHome, { recursive: true });
  const authPath = join(codexHome, "auth.json");
  const authPayload = JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2) + "\n";
  await writeFile(authPath, authPayload, { encoding: "utf8", mode: 0o600 });
}

/**
 * Build a direct OpenCode server command from the AgentAPI-wrapped command.
 * OpenCode's native HTTP API is exposed by `opencode serve`; model selection
 * is sent per prompt by the SDK, so process-level model flags are removed.
 */
export function resolveNativeOpenCodeCommand(agentapiCommand: string[], port: number): string[] {
  const separatorIndex = agentapiCommand.indexOf("--");
  if (separatorIndex === -1) {
    return ["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"];
  }
  const [binary, ...cliArgs] = agentapiCommand.slice(separatorIndex + 1);
  return [
    binary ?? "opencode",
    "serve",
    "--port",
    String(port),
    "--hostname",
    "127.0.0.1",
    ...withoutModelArgs(cliArgs),
  ];
}

function resolveWrappedAgentCli(command: string[]): string | undefined {
  const separatorIndex = command.indexOf("--");
  const cli = separatorIndex >= 0 ? command[separatorIndex + 1] : undefined;
  return cli && cli.trim().length > 0 ? cli : undefined;
}

function withoutModelArgs(args: string[]): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--model") {
      index += 1;
      continue;
    }
    if (arg?.startsWith("--model=")) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function extractModelOverride(args: string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model") {
      return args[index + 1]?.trim() ?? "";
    }
    if (arg?.startsWith("--model=")) {
      return arg.slice("--model=".length).trim();
    }
  }
  return "";
}

function withModelOverride(command: string[], modelValue: string): string[] {
  const normalizedModel = modelValue.trim();
  if (!normalizedModel.length) {
    return command;
  }

  const nextCommand = [...command];
  const explicitArgIndex = nextCommand.findIndex((arg) => arg === "--model");
  if (explicitArgIndex >= 0) {
    const valueIndex = explicitArgIndex + 1;
    if (valueIndex < nextCommand.length) {
      nextCommand[valueIndex] = normalizedModel;
      return nextCommand;
    }
    nextCommand.push(normalizedModel);
    return nextCommand;
  }

  const inlineIndex = nextCommand.findIndex((arg) => arg.startsWith("--model="));
  if (inlineIndex >= 0) {
    nextCommand[inlineIndex] = `--model=${normalizedModel}`;
    return nextCommand;
  }

  nextCommand.push("--model", normalizedModel);
  return nextCommand;
}

export function normalizeAgentModelOverride(model: string | undefined): string {
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  return normalizedModel.toLowerCase() === "default" ? "" : normalizedModel;
}

export function resolveGooseModelOverride(
  launcherModel: string | undefined,
  operatorModel: string | null | undefined,
): string | undefined {
  return normalizeAgentModelOverride(launcherModel)
    || normalizeAgentModelOverride(operatorModel ?? undefined)
    || undefined;
}

export class ProcessManager {
  private readonly config: WingmanConfig;
  private readonly resolveBillingLaunchConfig?: (input: BillingLaunchInput) => Promise<BillingLaunchResult>;
  private readonly recordAdapterUsage?: RecordAdapterUsage;
  private readonly issueSessionCapability?: ProcessManagerOptions["issueSessionCapability"];
  private readonly revokeSessionCapabilities?: ProcessManagerOptions["revokeSessionCapabilities"];
  private readonly resolveTowerGitGatewayOrigins?: ProcessManagerOptions["resolveTowerGitGatewayOrigins"];
  private readonly sessions = new Map<string, AgentSession>();
  private readonly allocatedPorts = new Set<number>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly adminNpubs = getConfiguredAdminNpubs();
  private readonly adminNpub = this.adminNpubs[0] ?? null;
  /** Debounce timers for log-driven session-updated events */
  private readonly logUpdateDebounce = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: WingmanConfig, options: ProcessManagerOptions = {}) {
    this.config = config;
    this.resolveBillingLaunchConfig = options.resolveBillingLaunchConfig;
    this.recordAdapterUsage = options.recordAdapterUsage;
    this.issueSessionCapability = options.issueSessionCapability;
    this.revokeSessionCapabilities = options.revokeSessionCapabilities;
    this.resolveTowerGitGatewayOrigins = options.resolveTowerGitGatewayOrigins;
  }

  on(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listSessions(): SessionSnapshot[] {
    return Array.from(this.sessions.values()).map((session) => this.toSnapshot(session));
  }

  getSession(id: string): SessionSnapshot | undefined {
    const session = this.sessions.get(id);
    return session ? this.toSnapshot(session) : undefined;
  }

  renameSession(id: string, name: string): SessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.name = this.normaliseSessionName(name, session.agent, session.port);
    const snapshot = this.toSnapshot(session);
    this.emit({ type: "session-updated", session: snapshot });
    return snapshot;
  }

  updateSessionTabOrder(id: string, tabOrder: number | null): SessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.tabOrder = typeof tabOrder === "number" && Number.isFinite(tabOrder)
      ? Math.max(1, Math.floor(tabOrder))
      : null;
    const snapshot = this.toSnapshot(session);
    this.emit({ type: "session-updated", session: snapshot });
    return snapshot;
  }

  updateSessionMetadata(id: string, metadata: SessionMetadataInput): SessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }
    session.metadata = normaliseSessionMetadata({
      ...session.metadata,
      ...(metadata ?? {}),
    });
    const snapshot = this.toSnapshot(session);
    this.emit({ type: "session-updated", session: snapshot });
    return snapshot;
  }

  /**
   * Persist the effective broker identity before a capability is issued.
   *
   * The broker deliberately re-reads the live session and rejects an identity
   * that is not bound in its metadata. Identity recovery therefore has to
   * update the session synchronously before calling the broker.
   */
  bindSessionCapabilityIdentity(id: string, botNpub: string, profileId?: string | null): SessionSnapshot | null {
    const session = this.sessions.get(id);
    const normalizedBotNpub = botNpub.trim();
    if (!session || !normalizedBotNpub) return null;

    session.metadata = normaliseSessionMetadata({
      ...session.metadata,
      ...(!session.metadata.agentChatAgentId && profileId ? { agentProfileId: profileId } : {}),
      agentChatBotNpub: normalizedBotNpub,
      ...(session.metadata.flightdeckAgentNpub
        ? { flightdeckAgentNpub: normalizedBotNpub }
        : {}),
    });
    const snapshot = this.toSnapshot(session);
    this.emit({ type: "session-updated", session: snapshot });
    return snapshot;
  }

  async getLogs(id: string): Promise<string[] | undefined> {
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }
    return session.logs.slice();
  }

  async createSession(
    agent: AgentType,
    workingDirectory?: string,
    name?: string,
    origin?: SessionOrigin | null,
    targetFile?: string,
    explicitNpub?: string,
    metadata?: SessionMetadataInput,
    model?: string,
  ): Promise<SessionSnapshot> {
    const launchStartedAt = Date.now();
    const requestNpub = explicitNpub ?? getAuthenticatedNpub() ?? undefined;
    const definition = this.config.agents[agent];
    if (!definition) {
      throw new Error(`Unknown agent: ${agent}`);
    }

    const port = this.allocatePort();
    const id = crypto.randomUUID();
    const sessionName = this.normaliseSessionName(name, agent, port);
    let command = definition.command({ port, agent, config: this.config });

    const requestedModel = normalizeAgentModelOverride(model);
    const configuredOpenRouterModels = getConfiguredOpenRouterModels(
      instanceSettingsService.getAppValue(MODEL_PROVIDERS_SETTING_KEY),
    );
    const resolvedModel = agent === "goose"
      ? requestedModel
      : resolveRuntimeModel(agent, requestedModel, configuredOpenRouterModels);
    let sessionModel = agent === "goose"
      ? resolveGooseModelOverride(model, instanceSettingsService.get("agents.goose_model"))
      : resolvedModel || undefined;

    // When the OpenCode native SDK flag is on, spawn opencode directly
    // instead of wrapping it with agentapi.  The OpenCodeAdapter SDK client
    // connects to OpenCode's own HTTP server on the allocated port.
    if (agent !== "goose" && resolvedModel.length > 0) {
      command = withModelOverride(command, resolvedModel);
    }
    if (agent === "opencode") {
      const ocFlag = featureFlagStore.getFlag(OPENCODE_NATIVE_SDK_FLAG);
      if (ocFlag && resolveFeatureFlagEffectiveState(ocFlag.state, true) === "on") {
        sessionModel = extractModelOverride(command) || undefined;
        command = resolveNativeOpenCodeCommand(command, port);
      }
    }

    let sessionMetadata = normaliseSessionMetadata(metadata);
    const agentTransport = resolveAgentTransport(agent, sessionMetadata.agentTransport);
    const acpPermissionPolicy = resolveNewSessionAcpPermissionPolicy(
      agentTransport,
      metadata?.acpPermissionPolicy,
      instanceSettingsService.get("agents.acp_permission_policy"),
    );
    sessionMetadata = normaliseSessionMetadata({ ...sessionMetadata, agentTransport, acpPermissionPolicy });
    const rawWorkingDirectory =
      typeof workingDirectory === "string" && workingDirectory.length > 0
        ? workingDirectory
        : await this.resolveDefaultWorkingDirectory(requestNpub);
    // Expand ~ to user home so Bun.spawn gets an absolute path
    const sessionWorkingDirectory = rawWorkingDirectory.startsWith("~/")
      ? resolve(homedir(), rawWorkingDirectory.slice(2))
      : rawWorkingDirectory;
    sessionMetadata = prepareNativeAgentSessionMetadata(agent, sessionWorkingDirectory, sessionMetadata);
    command = buildNativeAgentCommand(command, agent, sessionMetadata);

    // Resolve user info
    const npub = requestNpub;
    const isAdmin = this.isAdminUser(npub);
    const userAlias = this.resolveUserAlias(npub);

    console.log(`[manager] launching ${definition.label} with command: ${command.join(" ")}`);
    const session: AgentSession = {
      id,
      agent,
      port,
      name: sessionName,
      status: "starting",
      startedAt: new Date(),
      process: null,
      definition,
      workingDirectory: sessionWorkingDirectory,
      command,
      logs: [],
      detachedPid: undefined,
      npub,
      agentRuntimeStatus: undefined,
      origin: origin ?? undefined,
      userAlias,
      isAdmin,
      targetFile: targetFile ?? undefined,
      metadata: sessionMetadata,
      model: sessionModel,
    };

    if (agent === "goose" && sessionModel) {
      session.definition = {
        ...session.definition,
        env: {
          ...session.definition.env,
          GOOSE_PROVIDER: DEFAULT_GOOSE_PROVIDER,
          GOOSE_MODEL: sessionModel,
        },
      };
    }
    if (agent === "opencode" && configuredOpenRouterModels !== null) {
      session.definition = {
        ...session.definition,
        env: withOpenCodeModelConfigEnvironment(
          session.definition.env,
          configuredOpenRouterModels,
          Bun.env[OPENCODE_CONFIG_CONTENT_ENV],
        ),
      };
    }

    this.sessions.set(id, session);
    this.emit({ type: "session-started", session: this.toSnapshot(session) });

    let botKeyLookupMs = 0;
    let mcpInjectMs = 0;
    let giteaInjectMs = 0;
    let billingInjectMs = 0;
    let spawnMs = 0;

    let capabilityToken: string | undefined;
    let capabilityBrokerUrl: string | undefined;

    // Inject MCP config so the agent discovers the Wingman MCP server
    try {
      const botKeyLookupStartedAt = Date.now();
      // Public instance identity is informational only. Agent operations use
      // the session's stable bot identity through an opaque broker capability.
      let wingmanNpub: string | undefined;
      let botPubkeyHex: string | undefined;
      let botNpub: string | undefined;
      const instanceIdentity = loadWingmanInstanceIdentity();
      if (instanceIdentity) {
        const identityEnv = buildWingmanIdentityEnv(instanceIdentity);
        wingmanNpub = identityEnv.WINGMAN_NPUB;
      }
      if (npub && this.issueSessionCapability) {
        const capabilityMetadata = sessionMetadata as unknown as Record<string, unknown>;
        const profileId = typeof capabilityMetadata.agentChatAgentId === "string"
          ? capabilityMetadata.agentChatAgentId
          : typeof capabilityMetadata.agentProfileId === "string" ? capabilityMetadata.agentProfileId : null;
        const requestedBotNpub = typeof sessionMetadata.agentChatBotNpub === "string"
          ? sessionMetadata.agentChatBotNpub
          : typeof sessionMetadata.flightdeckAgentNpub === "string" ? sessionMetadata.flightdeckAgentNpub : null;
        const issued = this.issueSessionCapability({
          sessionId: id,
          ownerNpub: npub,
          profileId,
          botNpub: requestedBotNpub,
        });
        capabilityToken = issued.token;
        botPubkeyHex = issued.botPubkeyHex;
        botNpub = issued.botNpub;
        this.appendLog(session, `[manager] capability broker bound agent identity ${issued.botNpub.slice(0, 20)}…`);
      } else if (!npub) {
        this.appendLog(session, "[manager] session has no owner identity — cryptographic capability not issued");
      }
      botKeyLookupMs = Date.now() - botKeyLookupStartedAt;
      const mcpInjectStartedAt = Date.now();
      const mcpResult = await injectMcpConfig({
        sessionId: id,
        agent,
        workingDirectory: sessionWorkingDirectory,
        config: this.config,
        wingmanNpub,
        botPubkeyHex,
        botNpub,
        userNpub: npub,
        capabilityToken,
      });
      capabilityBrokerUrl = mcpResult.env.WINGMAN_BROKER_URL;
      session.mcpCleanupFiles = mcpResult.cleanupFiles;
      if (mcpResult.codexConfig) {
        session.codexConfig = { ...session.codexConfig, ...mcpResult.codexConfig };
      }
      // Merge MCP env vars into the agent definition for spawning
      session.definition = {
        ...session.definition,
        env: { ...session.definition.env, ...mcpResult.env },
      };
      if (agentTransport !== "codex-acp" && Array.isArray(mcpResult.commandArgs) && mcpResult.commandArgs.length > 0) {
        session.command = [...session.command, ...mcpResult.commandArgs];
      }
      this.appendLog(
        session,
        `[manager] post-injection command: ${session.command.join(" ")}`,
      );
      const injectedEnvKeys = Object.keys(mcpResult.env ?? {}).sort();
      if (injectedEnvKeys.length > 0) {
        this.appendLog(session, `[manager] post-injection env keys: ${injectedEnvKeys.join(", ")}`);
      }
      mcpInjectMs = Date.now() - mcpInjectStartedAt;
    } catch (mcpError) {
      const fatalMcpFailure = Boolean(npub && this.issueSessionCapability)
        || sessionMetadata.AGENT === true
        || origin?.type === "scheduler"
        || agent === "claude"
        || (mcpError as { code?: unknown }).code === BROKER_KEY_NOT_PROVISIONED
        || (mcpError as Error).message.startsWith(`${BROKER_KEY_NOT_PROVISIONED}:`);
      this.appendLog(session, `[manager] MCP config injection failed (${fatalMcpFailure ? "fatal" : "non-fatal"}): ${(mcpError as Error).message}`);
      if (fatalMcpFailure
      ) {
        session.status = "error";
        this.revokeSessionCapabilities?.(session.id);
        this.releasePort(session.port);
        this.sessions.delete(session.id);
        this.emit({ type: "session-stopped", session: this.toSnapshot(session) });
        throw mcpError;
      }
    }

    // Inject host-scoped git credentials so sessions can authenticate to
    // GitHub HTTPS remotes and per-user Gitea remotes without mutating ~/.gitconfig.
    try {
      const gitCredentialInjectStartedAt = Date.now();
      const dataDir = new URL("../../data", import.meta.url).pathname;
      const giteaCreds = resolveGiteaCredentials(npub, this.config);
      let towerGitGatewayOrigins: string[] = [];
      if (capabilityToken && capabilityBrokerUrl && this.resolveTowerGitGatewayOrigins) {
        try {
          towerGitGatewayOrigins = await this.resolveTowerGitGatewayOrigins({
            sessionId: id,
            capabilityToken,
            brokerUrl: capabilityBrokerUrl,
          });
        } catch (error) {
          this.appendLog(session, `[manager] Native Forgejo host configuration failed; no helper was configured: ${(error as Error).message}`);
        }
      }
      const gitCredentialEnv = buildSessionGitCredentialEnv({
        npub,
        dataDir,
        giteaConfig: giteaCreds,
        towerGitGatewayOrigins,
      });

      const nextEnv: Record<string, string> = {};
      if (Object.keys(gitCredentialEnv).length > 0) {
        Object.assign(nextEnv, gitCredentialEnv);
      }

      const hasGitAuthorIdentity =
        Boolean(nextEnv.GIT_AUTHOR_NAME) &&
        Boolean(nextEnv.GIT_AUTHOR_EMAIL) &&
        Boolean(nextEnv.GIT_COMMITTER_NAME) &&
        Boolean(nextEnv.GIT_COMMITTER_EMAIL);

      if (giteaCreds && !hasGitAuthorIdentity) {
        Object.assign(nextEnv, {
          GIT_AUTHOR_NAME: giteaCreds.owner,
          GIT_AUTHOR_EMAIL: `${giteaCreds.owner}@wingman-os.ai`,
          GIT_COMMITTER_NAME: giteaCreds.owner,
          GIT_COMMITTER_EMAIL: `${giteaCreds.owner}@wingman-os.ai`,
        });
      }

      if (Object.keys(nextEnv).length > 0) {
        session.definition = {
          ...session.definition,
          env: { ...session.definition.env, ...nextEnv },
        };
      }

      if (gitCredentialEnv.WINGMAN_GITHUB_TOKEN) {
        this.appendLog(session, "[manager] GitHub HTTPS credentials configured for this session");
      }
      if (giteaCreds) {
        this.appendLog(session, `[manager] Gitea credentials configured for ${giteaCreds.owner}@${this.config.giteaUrl}`);
      }
      if (towerGitGatewayOrigins?.length) {
        this.appendLog(session, `[manager] Native Forgejo credentials configured for ${towerGitGatewayOrigins.length} host(s)`);
      }

      giteaInjectMs = Date.now() - gitCredentialInjectStartedAt;
    } catch (gitCredentialError) {
      this.appendLog(session, `[manager] git credential setup failed (non-fatal): ${(gitCredentialError as Error).message}`);
    }

    // Inject billing proxy env for supported providers when credits billing is enabled.
    try {
      const billingInjectStartedAt = Date.now();
      if (this.resolveBillingLaunchConfig) {
        const launchConfig = await this.resolveBillingLaunchConfig({
          sessionId: id,
          agent,
          npub: npub ?? null,
        });
        session.metadata = normaliseSessionMetadata({
          ...session.metadata,
          billingMode: launchConfig.billingMode,
        });
        const billingEnv = launchConfig.env ?? {};
        const billingEnvKeys = Object.keys(billingEnv).sort();
        await prepareCodexApiAuthHome(billingEnv);
        if (billingEnvKeys.length > 0) {
          session.definition = {
            ...session.definition,
            env: { ...session.definition.env, ...billingEnv },
          };
          this.appendLog(session, `[manager] billing env keys: ${billingEnvKeys.join(", ")}`);
        }
        if (agentTransport !== "codex-acp" && Array.isArray(launchConfig.commandArgs) && launchConfig.commandArgs.length > 0) {
          session.command = [...session.command, ...launchConfig.commandArgs];
          this.appendLog(session, `[manager] billing command args: ${launchConfig.commandArgs.join(" ")}`);
        }
        if (launchConfig.codexConfig) {
          session.codexConfig = { ...session.codexConfig, ...launchConfig.codexConfig };
        }
        if (launchConfig.fallbackReason) {
          this.appendLog(
            session,
            `[manager] billing mode ${launchConfig.billingMode} (${launchConfig.fallbackReason})`,
          );
        } else {
          this.appendLog(session, `[manager] billing mode ${launchConfig.billingMode}`);
        }
      }
      billingInjectMs = Date.now() - billingInjectStartedAt;
    } catch (billingError) {
      session.metadata = normaliseSessionMetadata({
        ...session.metadata,
        billingMode: "subscription",
      });
      this.appendLog(
        session,
        `[manager] billing launch setup failed (fallback subscription): ${(billingError as Error).message}`,
      );
    }

    try {
      const spawnStartedAt = Date.now();
      if (transportSkipsAgentApiSpawn(agentTransport)) {
        this.appendLog(session, `[manager] ${agentTransport} transport selected — skipping agentapi spawn`);
      } else if (this.config.agentSpawnMode === "pm2") {
        await this.spawnAgentProcessViaPM2(session);
      } else if (this.config.agentSpawnMode === "tmux") {
        await this.spawnAgentProcessViaTmux(session);
      } else {
        session.process = this.spawnAgentProcess(session);
        await this.monitorSession(session);
      }
      spawnMs = Date.now() - spawnStartedAt;
      session.status = "running";

      // Create protocol adapter for agent communication
      const adapterFactory = resolveAdapterFactory(agent, agentTransport);
      session.adapter = adapterFactory({
        id: session.id,
        port: session.port,
        agent: session.agent,
        host: normaliseHostForUrl(pickAgentHost(parseAllowedHosts(this.config.allowedHosts))),
        pm2Name: session.pm2Name,
        workingDirectory: session.workingDirectory,
        env: session.definition.env as Record<string, string> | undefined,
        model: session.model,
        acpPermissionPolicy: session.metadata.acpPermissionPolicy,
        codexThreadId: session.metadata.nativeAgentSession?.agent === "codex"
          ? session.metadata.nativeAgentSession.sessionId
          : undefined,
        codexCli: agent === "codex" ? resolveWrappedAgentCli(session.command) : undefined,
        codexAcpCli: agent === "codex"
          ? instanceSettingsService.get("agents.codex_acp_cli") || undefined
          : undefined,
        codexConfig: session.agent === "codex" ? session.codexConfig : undefined,
        opencodeSdkSessionId: session.metadata.nativeAgentSession?.agent === "opencode"
          ? session.metadata.nativeAgentSession.sessionId
          : undefined,
        gooseSessionId: session.metadata.nativeAgentSession?.agent === "goose"
          ? session.metadata.nativeAgentSession.sessionId
          : undefined,
        gooseCli: agent === "goose" ? resolveWrappedAgentCli(session.command) : undefined,
        gooseProvider: agent === "goose"
          ? configuredOpenRouterModels !== null
            ? DEFAULT_GOOSE_PROVIDER
            : instanceSettingsService.get("agents.goose_provider") || DEFAULT_GOOSE_PROVIDER
          : undefined,
        piSessionId: session.metadata.nativeAgentSession?.agent === "pi"
          ? session.metadata.nativeAgentSession.sessionId
          : undefined,
        piCli: agent === "pi" ? resolveWrappedAgentCli(session.command) : undefined,
        piAcpCli: agent === "pi"
          ? instanceSettingsService.get("agents.pi_acp_cli") || undefined
          : undefined,
        piOpenRouterApiKey: agent === "pi" && agentTransport === "pi-acp"
          ? instanceSettingsService.get("integrations.openrouter_api_key") || undefined
          : undefined,
        mapleAcpCli: agent === "maple"
          ? instanceSettingsService.get("agents.maple_acp_cli") || resolveWrappedAgentCli(session.command)
          : undefined,
        mapleSessionId: session.metadata.nativeAgentSession?.agent === "maple"
          ? session.metadata.nativeAgentSession.sessionId
          : undefined,
        onNativeSessionId: (nativeSessionId) => {
          this.setNativeAgentSessionMetadata(session, nativeSessionId, { emit: true });
        },
        recordUsage: this.buildRecordUsageCallback(session),
      });
      if (transportRequiresEagerReadiness(agentTransport)) {
        await session.adapter.waitForReady({ timeoutMs: 30_000 });
        this.appendLog(
          session,
          agentTransport === "opencode-sdk"
            ? `[manager] ${session.definition.label} SDK readiness probe completed`
            : `[manager] ${session.definition.label} ACP initialization and session negotiation completed`,
        );
      }

      this.emit({ type: "session-updated", session: this.toSnapshot(session) });
      const totalLaunchMs = Date.now() - launchStartedAt;
      console.log(
        `[manager] session ${id} (${agent}:${port}) launch timings total=${totalLaunchMs}ms ` +
          `botKey=${botKeyLookupMs}ms mcp=${mcpInjectMs}ms gitea=${giteaInjectMs}ms billing=${billingInjectMs}ms spawn=${spawnMs}ms`,
      );
    } catch (error) {
      if (session.tmuxSession && session.tmuxWindow) {
        await stopTmuxWindow(session.tmuxSession, session.tmuxWindow).catch(() => false);
        session.tmuxSession = undefined;
        session.tmuxWindow = undefined;
      }
      session.status = "error";
      this.revokeSessionCapabilities?.(session.id);
      this.appendLog(session, `[manager] failed to launch session: ${(error as Error).message}`);
      this.releasePort(session.port);
      this.emit({ type: "session-updated", session: this.toSnapshot(session) });
      throw error;
    }

    // Track project for authenticated users (fire and forget)
    trackProjectForSession(npub, sessionWorkingDirectory).catch(() => {});

    return this.toSnapshot(session);
  }

  rehydrateSession(input: RehydrateSessionInput): SessionSnapshot | null {
    const definition = this.config.agents[input.agent];
    if (!definition) {
      return null;
    }

    if (this.sessions.has(input.id)) {
      return this.toSnapshot(this.sessions.get(input.id)!);
    }

    if (this.allocatedPorts.has(input.port)) {
      return null;
    }

    const command =
      Array.isArray(input.command) && input.command.length > 0
        ? input.command
        : definition.command({ port: input.port, agent: input.agent, config: this.config });

    const sanitizedLogs = Array.isArray(input.logs)
      ? input.logs.map((entry) => sanitizeLogEntry(entry)).filter((entry) => entry.length > 0)
      : [];

    // Derive user alias from npub
    const npub = input.npub ?? undefined;
    const isAdmin = this.isAdminUser(npub);
    const userAlias = this.resolveUserAlias(npub);

    let rehydratedMetadata = normaliseSessionMetadata(input.metadata);
    const agentTransport = resolveAgentTransport(input.agent, rehydratedMetadata.agentTransport);
    const rehydratedAcpPermissionPolicy = rehydratedMetadata.acpPermissionPolicy
      ?? (agentTransport === "maple-acp" ? DEFAULT_ACP_PERMISSION_POLICY : LEGACY_ACP_PERMISSION_POLICY);
    rehydratedMetadata = normaliseSessionMetadata({
      ...rehydratedMetadata,
      agentTransport,
      acpPermissionPolicy: transportUsesAcpPermissionPolicy(agentTransport)
        ? rehydratedAcpPermissionPolicy
        : undefined,
    });

    const session: AgentSession = {
      id: input.id,
      agent: input.agent,
      port: input.port,
      name: input.name,
      status: "running",
      startedAt: new Date(input.startedAt),
      process: null,
      definition,
      workingDirectory: input.workingDirectory,
      command,
      logs: sanitizedLogs,
      detachedPid: typeof input.pid === "number" ? input.pid : undefined,
      npub,
      agentRuntimeStatus: input.agentRuntimeStatus ?? undefined,
      origin: input.origin ?? undefined,
      userAlias,
      isAdmin,
      pm2Name: input.pm2Name,
      tmuxSession: input.tmuxSession,
      tmuxWindow: input.tmuxWindow,
      targetFile: input.targetFile,
      pinnedFile: input.pinnedFile,
      metadata: rehydratedMetadata,
      model: normalizeAgentModelOverride(input.model) || undefined,
    };
    // Create protocol adapter for rehydrated session
    const adapterFactory = resolveAdapterFactory(input.agent, agentTransport);
    session.adapter = adapterFactory({
      id: session.id,
      port: session.port,
      agent: session.agent,
      host: normaliseHostForUrl(pickAgentHost(parseAllowedHosts(this.config.allowedHosts))),
      pm2Name: session.pm2Name,
      workingDirectory: session.workingDirectory,
      env: session.definition.env as Record<string, string> | undefined,
      model: normalizeAgentModelOverride(session.model),
      acpPermissionPolicy: session.metadata.acpPermissionPolicy,
      codexThreadId: session.metadata.nativeAgentSession?.agent === "codex"
        ? session.metadata.nativeAgentSession.sessionId
        : undefined,
      codexCli: input.agent === "codex"
        ? resolveWrappedAgentCli(definition.command({ port: input.port, agent: input.agent, config: this.config }))
        : undefined,
      codexAcpCli: input.agent === "codex"
        ? instanceSettingsService.get("agents.codex_acp_cli") || undefined
        : undefined,
      opencodeSdkSessionId: session.metadata.nativeAgentSession?.agent === "opencode"
        ? session.metadata.nativeAgentSession.sessionId
        : undefined,
      gooseSessionId: session.metadata.nativeAgentSession?.agent === "goose"
        ? session.metadata.nativeAgentSession.sessionId
        : undefined,
      gooseCli: input.agent === "goose" ? resolveWrappedAgentCli(session.command) : undefined,
      gooseProvider: input.agent === "goose"
        ? getConfiguredOpenRouterModels(instanceSettingsService.getAppValue(MODEL_PROVIDERS_SETTING_KEY)) !== null
          ? DEFAULT_GOOSE_PROVIDER
          : instanceSettingsService.get("agents.goose_provider") || DEFAULT_GOOSE_PROVIDER
        : undefined,
      piSessionId: session.metadata.nativeAgentSession?.agent === "pi"
        ? session.metadata.nativeAgentSession.sessionId
        : undefined,
      piCli: input.agent === "pi"
        ? resolveWrappedAgentCli(definition.command({ port: input.port, agent: input.agent, config: this.config }))
        : undefined,
      piAcpCli: input.agent === "pi"
        ? instanceSettingsService.get("agents.pi_acp_cli") || undefined
        : undefined,
      piOpenRouterApiKey: input.agent === "pi" && agentTransport === "pi-acp"
        ? instanceSettingsService.get("integrations.openrouter_api_key") || undefined
        : undefined,
      mapleSessionId: session.metadata.nativeAgentSession?.agent === "maple"
        ? session.metadata.nativeAgentSession.sessionId
        : undefined,
      onNativeSessionId: (nativeSessionId) => {
        this.setNativeAgentSessionMetadata(session, nativeSessionId, { emit: this.sessions.has(session.id) });
      },
      recordUsage: this.buildRecordUsageCallback(session),
    });

    this.sessions.set(session.id, session);
    this.allocatedPorts.add(session.port);
    return this.toSnapshot(session);
  }

  async stopSession(id: string): Promise<SessionSnapshot | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;

    // Stop via PM2 if this is a PM2-managed session
    if (session.pm2Name) {
      const pm2Name = session.pm2Name;
      let deletedFromPm2 = false;

      // Stop failures should not prevent delete; we still want the PM2 entry removed.
      try {
        await stopProcess(pm2Name);
      } catch (error) {
        this.appendLog(session, `[manager] PM2 stop error: ${(error as Error).message}`);
      }

      try {
        await deleteProcess(pm2Name);
        deletedFromPm2 = true;
      } catch (error) {
        this.appendLog(session, `[manager] PM2 delete error: ${(error as Error).message}`);
      }

      // Best-effort cleanup of ecosystem config.
      try {
        await removeAppFromEcosystem(
          session.workingDirectory,
          session.isAdmin ?? false,
          pm2Name,
        );
      } catch (error) {
        this.appendLog(session, `[manager] PM2 ecosystem cleanup error: ${(error as Error).message}`);
      }

      if (!deletedFromPm2) {
        try {
          const proc = await getProcessByName(pm2Name);
          if (!proc) {
            deletedFromPm2 = true;
          } else {
            this.appendLog(session, `[manager] PM2 process ${pm2Name} still present after stop`);
          }
        } catch (error) {
          this.appendLog(session, `[manager] PM2 cleanup verify error: ${(error as Error).message}`);
        }
      }

      if (deletedFromPm2) {
        session.pm2Name = undefined;
      } else {
        // PM2 process is still alive — do NOT mark stopped or release the port.
        // The session stays in its current state so the operator can investigate.
        this.appendLog(session, `[manager] PM2 cleanup failed — session NOT marked stopped, port NOT released`);
        throw new Error(`PM2 process ${pm2Name} still present after stop/delete — session ${session.id} not marked stopped`);
      }
      session.detachedPid = undefined;
    } else if (session.tmuxSession && session.tmuxWindow) {
      const stopped = await stopTmuxWindow(session.tmuxSession, session.tmuxWindow);
      if (!stopped) {
        const exists = await hasTmuxWindow(session.tmuxSession, session.tmuxWindow).catch(() => true);
        if (exists) {
          this.appendLog(session, `[manager] tmux window ${session.tmuxSession}:${session.tmuxWindow} still present after stop`);
          throw new Error(`tmux window ${session.tmuxSession}:${session.tmuxWindow} still present after stop`);
        }
      }
      session.tmuxWindow = undefined;
      session.tmuxSession = undefined;
      session.detachedPid = undefined;
    } else if (session.process) {
      const stopResult = await stopManagedSubprocess(session.process);
      if (stopResult.forced) {
        this.appendLog(session, "[manager] process did not exit after SIGTERM; sent SIGKILL");
      }
      session.process = null;
    } else if (typeof session.detachedPid === "number" && session.detachedPid > 0) {
      try {
        process.kill(session.detachedPid, "SIGTERM");
      } catch {
        // ignore failures when the process already exited or cannot be signalled
      }
      session.detachedPid = undefined;
    }

    // Dispose protocol adapter
    if (session.adapter) {
      try {
        await session.adapter.dispose();
      } catch (error) {
        this.appendLog(session, `[manager] adapter dispose error: ${(error as Error).message}`);
      }
      session.adapter = undefined;
    }

    // Clean up MCP config files only when no other active session still
    // references the same shared config path (for example Claude .mcp.json).
    if (
      session.mcpCleanupFiles &&
      shouldCleanupMcpFiles(this.sessions.values(), session.id, session.mcpCleanupFiles)
    ) {
      cleanupMcpConfig(session.mcpCleanupFiles).catch(() => {});
      session.mcpCleanupFiles = undefined;
    }

    session.status = "stopped";
    this.revokeSessionCapabilities?.(session.id);
    this.releasePort(session.port);
    this.emit({ type: "session-stopped", session: this.toSnapshot(session) });
    return this.toSnapshot(session);
  }

  deleteSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }

    if (session.status === "starting" || session.status === "running") {
      throw new Error("Cannot delete a running session");
    }

    this.revokeSessionCapabilities?.(session.id);

    if (session.process) {
      try {
        session.process.kill("SIGTERM");
      } catch {
        // best effort; process should already be exited
      }
      session.process = null;
    }

    // Snapshot before deleting so we can notify browsers
    const snapshot = this.toSnapshot(session);
    this.releasePort(session.port);
    this.sessions.delete(id);
    this.emit({ type: "session-deleted", session: snapshot });
    return true;
  }

  setAgentRuntimeStatus(id: string, status: AgentRuntimeStatus | null): SessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }
    const nextStatus = status ?? undefined;
    if (session.agentRuntimeStatus === nextStatus) {
      return this.toSnapshot(session);
    }
    session.agentRuntimeStatus = nextStatus;
    const snapshot = this.toSnapshot(session);
    this.emit({ type: "session-updated", session: snapshot });
    return snapshot;
  }

  getAdapter(id: string): AgentAdapter | null {
    const session = this.sessions.get(id);
    return session?.adapter ?? null;
  }

  appendSessionLog(id: string, entry: string): SessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }
    this.appendLog(session, entry);
    return this.toSnapshot(session);
  }

  setPinnedFile(id: string, filePath: string | null): SessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const normalizedFilePath = typeof filePath === "string" && filePath.trim().length > 0
      ? filePath.trim()
      : null;
    const existingPinnedFiles = Array.isArray(session.metadata.pinnedFiles)
      ? session.metadata.pinnedFiles.filter((value) => typeof value === "string" && value.trim().length > 0)
      : [];
    const pinnedFiles = normalizedFilePath
      ? [...existingPinnedFiles.filter((value) => value !== normalizedFilePath), normalizedFilePath]
      : [];
    session.pinnedFile = normalizedFilePath ?? undefined;
    session.metadata = normaliseSessionMetadata({
      ...session.metadata,
      pinnedFiles,
    });
    const snapshot = this.toSnapshot(session);
    this.emit({
      type: "session-updated",
      session: snapshot,
      ...(normalizedFilePath
        ? {
            artifactIntent: {
              action: "open",
              filePath: normalizedFilePath,
              pinnedFiles,
            },
          }
        : {}),
    });
    return snapshot;
  }

  removePinnedFile(id: string, filePath: string): SessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const normalizedFilePath = typeof filePath === "string" && filePath.trim().length > 0
      ? filePath.trim()
      : null;
    if (!normalizedFilePath) {
      return this.toSnapshot(session);
    }
    const pinnedFiles = Array.isArray(session.metadata.pinnedFiles)
      ? session.metadata.pinnedFiles.filter((value) => (
          typeof value === "string" &&
          value.trim().length > 0 &&
          value.trim() !== normalizedFilePath
        ))
      : [];
    const pinnedFile = pinnedFiles.includes(session.pinnedFile ?? "")
      ? session.pinnedFile
      : pinnedFiles[pinnedFiles.length - 1];
    session.pinnedFile = pinnedFile || undefined;
    session.metadata = normaliseSessionMetadata({
      ...session.metadata,
      pinnedFiles,
    });
    const snapshot = this.toSnapshot(session);
    this.emit({ type: "session-updated", session: snapshot });
    return snapshot;
  }

  setPinnedFiles(id: string, filePaths: string[], activeFilePath: string | null = null): SessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const pinnedFiles = Array.isArray(filePaths)
      ? filePaths
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
      : [];
    const normalizedActiveFilePath = typeof activeFilePath === "string" && activeFilePath.trim().length > 0
      ? activeFilePath.trim()
      : null;
    const pinnedFile = normalizedActiveFilePath && pinnedFiles.includes(normalizedActiveFilePath)
      ? normalizedActiveFilePath
      : pinnedFiles[pinnedFiles.length - 1];
    session.pinnedFile = pinnedFile || undefined;
    session.metadata = normaliseSessionMetadata({
      ...session.metadata,
      pinnedFiles,
    });
    const snapshot = this.toSnapshot(session);
    this.emit({ type: "session-updated", session: snapshot });
    return snapshot;
  }

  async captureAgentapiCodexSessionIdFromPrompt(
    id: string,
    prompt: string,
    options: { sentAtMs?: number; attempts?: number; retryMs?: number } = {},
  ): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || session.agent !== "codex") {
      return false;
    }
    if (session.adapter?.deliversPromptsDirectly?.()) {
      return false;
    }
    if (session.metadata.nativeAgentSession?.agent === "codex" && session.metadata.nativeAgentSession.sessionId) {
      return false;
    }

    const sentAtMs = Number.isFinite(options.sentAtMs) ? options.sentAtMs! : Date.now();
    const attempts = Math.max(1, options.attempts ?? CODEX_AGENTAPI_DISCOVERY_ATTEMPTS);
    const retryMs = Math.max(0, options.retryMs ?? CODEX_AGENTAPI_DISCOVERY_RETRY_MS);
    const codexHome = this.resolveCodexHome(session);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await discoverCodexSessionIdForPrompt({
        codexHome,
        workingDirectory: session.workingDirectory,
        prompt,
        sessionStartedAtMs: session.startedAt.getTime(),
        sentAtMs,
      });

      if (result.sessionId) {
        this.setNativeAgentSessionMetadata(session, result.sessionId, {
          emit: true,
          source: "agentapi",
        });
        this.appendLog(
          session,
          `[manager] captured Codex native session ${result.sessionId} from agentapi transcript`,
        );
        return true;
      }

      if (result.reason === "ambiguous") {
        this.appendLog(
          session,
          `[manager] Codex native session discovery ambiguous (${result.candidateCount} matches); waiting for a more unique prompt`,
        );
        return false;
      }

      if (attempt < attempts) {
        await sleep(retryMs);
      }
    }

    return false;
  }

  private buildAgentProcessEnv(session: AgentSession): Record<string, string | undefined> {
    const parentEnv = buildInheritedAgentEnvironment(Bun.env);
    return {
      ...parentEnv,
      SESSION_ID: session.id,
      SESSION_AGENT: session.agent,
      SESSION_PORT: session.port.toString(),
      SESSION_DIRECTORY: session.workingDirectory,
      SESSION_NAME: session.name,
      NATIVE_AGENT_SESSION_ID: session.metadata.nativeAgentSession?.sessionId,
      ...sanitizeInjectedAgentEnvironment(session.definition.env ?? {}),
    };
  }

  private spawnAgentProcess(session: AgentSession): Bun.Subprocess {
    const env = this.buildAgentProcessEnv(session);

    const launchCommand = buildBunAgentLaunchCommand(session.command);

    const proc = Bun.spawn(launchCommand, {
      cwd: session.workingDirectory,
      env,
      stdin: null,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (typeof proc.pid === "number" && proc.pid > 0) {
      session.detachedPid = proc.pid;
    }

    if (proc.stdout) {
      this.captureStream(proc.stdout, session, "stdout");
    }

    if (proc.stderr) {
      this.captureStream(proc.stderr, session, "stderr");
    }

    proc.exited.then((code) => {
      session.exitCode = code ?? undefined;
      session.detachedPid = undefined;
      if (session.status === "running") {
        session.status = code === 0 ? "stopped" : "error";
        this.revokeSessionCapabilities?.(session.id);
        this.releasePort(session.port);
        this.emit({ type: "session-stopped", session: this.toSnapshot(session) });
      }
    }).catch((error) => {
      session.exitCode = undefined;
      session.status = "error";
      this.revokeSessionCapabilities?.(session.id);
      this.appendLog(session, `[manager] spawn monitoring failed: ${(error as Error).message}`);
      this.releasePort(session.port);
      this.emit({ type: "session-stopped", session: this.toSnapshot(session) });
    });

    return proc;
  }

  private buildTmuxWindowName(session: AgentSession): string {
    return `${session.id.slice(0, 8)}-${session.port}`.replace(/[^A-Za-z0-9_.-]/g, "-");
  }

  private async spawnAgentProcessViaTmux(session: AgentSession): Promise<void> {
    const tmuxSession = this.config.agentTmuxSession;
    const tmuxWindow = this.buildTmuxWindowName(session);
    const logFile = buildTmuxLogFile(projectRootDirectory, session.id);
    const launch = await startTmuxProcess({
      sessionName: tmuxSession,
      windowName: tmuxWindow,
      workingDirectory: session.workingDirectory,
      command: session.command,
      env: this.buildAgentProcessEnv(session),
      logFile,
    });
    session.tmuxSession = launch.sessionName;
    session.tmuxWindow = launch.windowName;
    session.tmuxLogFile = launch.logFile;
    this.appendLog(session, `[manager] tmux window ${launch.target} started`);

    await waitForAgentReady(
      normaliseHostForUrl(pickAgentHost(parseAllowedHosts(this.config.allowedHosts))),
      session.port,
      session.agent,
      {
        timeoutMs: TMUX_AGENT_START_TIMEOUT_MS,
        pollIntervalMs: 250,
      },
    );
    this.appendLog(session, `[manager] tmux agent ready on port ${session.port}`);
  }

  private async spawnAgentProcessViaPM2(session: AgentSession): Promise<void> {
    const sessionConfig: SessionConfig = {
      sessionId: session.id,
      sessionName: session.name,
      agent: session.agent,
      port: session.port,
      workingDirectory: session.workingDirectory,
      userAlias: session.userAlias ?? "anonymous",
      isAdmin: session.isAdmin ?? false,
      config: this.config,
      billingMode: session.metadata.billingMode,
      commandOverride: session.command,
      envOverride: session.definition.env ?? {},
    };

    const startOptions = createAgentPm2StartOptions(sessionConfig);
    const processName = startOptions.name;
    const logsDir = getLogsDirectory(session.workingDirectory, session.isAdmin ?? false);
    let proc = null;
    session.pm2Name = processName;

    try {
      this.appendLog(session, `[manager] starting via PM2 as ${processName}`);

      await startProcess(startOptions);
      proc = await waitForStatus(processName, "online", resolvePm2AgentStartTimeoutMs());

      const pm2Status = proc?.pm2_env?.status;
      if (!proc || pm2Status !== "online") {
        const startupDetail = await this.readPm2StartupFailure(logsDir, processName);
        if (pm2Status && pm2Status !== "online") {
          throw new Error(
            startupDetail
              ? `PM2 process ${processName} failed during startup (${pm2Status}): ${startupDetail}`
              : `PM2 process ${processName} failed during startup (${pm2Status})`,
          );
        }
        throw new Error(
          startupDetail
            ? `PM2 process ${processName} failed to start within timeout: ${startupDetail}`
            : `PM2 process ${processName} failed to start within timeout`,
        );
      }
    } catch (error) {
      try {
        await deleteProcess(processName);
      } catch {
        // best-effort cleanup
      }
      try {
        await removeAppFromEcosystem(
          session.workingDirectory,
          session.isAdmin ?? false,
          processName,
        );
      } catch {
        // best-effort cleanup for legacy ecosystem-backed sessions
      }
      session.pm2Name = undefined;
      throw error;
    }

    // Store the PID for rehydration
    if (typeof proc.pid === "number" && proc.pid > 0) {
      session.detachedPid = proc.pid;
    }

    this.appendLog(session, `[manager] PM2 process ${processName} online (pid: ${proc.pid})`);
  }

  private async readPm2StartupFailure(logsDir: string, processName: string): Promise<string | null> {
    const errorLogPath = resolve(join(logsDir, `${processName}-error.log`));
    try {
      const content = await readFile(errorLogPath, "utf8");
      const lastMeaningfulLine = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1);
      return lastMeaningfulLine ?? null;
    } catch {
      return null;
    }
  }

  private async monitorSession(session: AgentSession): Promise<void> {
    // Bun.spawn returns PID synchronously — no polling needed.
    if (session.process && typeof session.process.pid === "number" && session.process.pid > 0) {
      session.detachedPid = session.process.pid;
    }
  }

  private captureStream(stream: ReadableStream<any>, session: AgentSession, label: "stdout" | "stderr") {
    const decoder = new TextDecoder();
    (async () => {
      const reader = stream.getReader();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = this.flushBuffer(buffer, session, label);
      }
      if (buffer.length > 0) {
        this.appendLog(session, `[${label}] ${buffer.trimEnd()}`);
      }
    })().catch((error) => {
      this.appendLog(session, `[manager] failed to read ${label}: ${(error as Error).message}`);
    });
  }

  private flushBuffer(buffer: string, session: AgentSession, label: string): string {
    const lines = buffer.split(/\r?\n/);
    if (lines.length === 1) {
      return buffer;
    }

    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i]?.trimEnd();
      if (line) {
        this.appendLog(session, `[${label}] ${line}`);
      }
    }

    return lines[lines.length - 1] ?? "";
  }

  private appendLog(session: AgentSession, entry: string) {
    const cleanedEntry = sanitizeLogEntry(entry);
    if (!cleanedEntry) {
      return;
    }
    session.logs.push(cleanedEntry);
    if (session.logs.length > MAX_LOG_LINES) {
      session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
    }
    this.emitSessionUpdatedDebounced(session);
  }

  /** Debounce session-updated emissions from rapid log appends (200ms) */
  private emitSessionUpdatedDebounced(session: AgentSession) {
    const existing = this.logUpdateDebounce.get(session.id);
    if (existing) clearTimeout(existing);
    this.logUpdateDebounce.set(session.id, setTimeout(() => {
      this.logUpdateDebounce.delete(session.id);
      this.emit({ type: "session-updated", session: this.toSnapshot(session) });
    }, 200));
  }

  private async resolveDefaultWorkingDirectory(npubHint?: string): Promise<string> {
    const npub = normaliseNpub(npubHint ?? getAuthenticatedNpub());
    if (!npub) {
      return this.config.defaultWorkingDirectory;
    }
    if (this.isAdminUser(npub)) {
      return this.config.defaultWorkingDirectory;
    }
    const alias = generateIdentityAlias(npub);
    const aliasDirectory = normalize(join(this.config.defaultWorkingDirectory, alias));
    try {
      await mkdir(aliasDirectory, { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[manager] failed to ensure alias directory ${aliasDirectory}: ${message}`);
    }
    return aliasDirectory;
  }

  /**
   * Build a recordUsage callback bound to a session's identity, for native SDK adapters.
   */
  private buildRecordUsageCallback(
    session: AgentSession,
  ): AdapterSessionContext['recordUsage'] {
    if (!this.recordAdapterUsage) return undefined;
    const recordFn = this.recordAdapterUsage;
    return async (data) => {
      await recordFn({
        ...data,
        npub: session.npub ?? null,
        agent: session.agent,
      });
    };
  }

  private isAdminUser(npub: string | undefined): boolean {
    return isNpubInList(npub, this.adminNpubs);
  }

  private resolveUserAlias(npub: string | undefined): string {
    if (!npub) {
      return "anonymous";
    }
    if (this.isAdminUser(npub)) {
      return "admin";
    }
    return generateIdentityAlias(npub);
  }

  private allocatePort(): number {
    const { agentPortStart, agentPortMax } = this.config;
    for (let offset = 0; offset < agentPortMax; offset += 1) {
      const candidate = agentPortStart + offset;
      if (this.allocatedPorts.has(candidate)) {
        continue;
      }
      if (!isPortAvailable(candidate)) {
        console.warn(`[manager] skipping port ${candidate} because it is already in use`);
        continue;
      }
      this.allocatedPorts.add(candidate);
      return candidate;
    }
    throw new Error("No available agent ports. Increase AGENT_MAX or free sessions.");
  }

  private releasePort(port: number) {
    this.allocatedPorts.delete(port);
  }

  private toSnapshot(session: AgentSession): SessionSnapshot {
    this.syncNativeAgentSessionMetadata(session);
    return {
      id: session.id,
      agent: session.agent,
      port: session.port,
      name: session.name,
      status: session.status,
      agentRuntimeStatus: session.agentRuntimeStatus,
      startedAt: session.startedAt.toISOString(),
      npub: session.npub,
      pid: session.process?.pid ?? session.detachedPid,
      command: session.command,
      workingDirectory: session.workingDirectory,
      exitCode: session.exitCode,
      logs: session.logs.slice(-50),
      origin: session.origin,
      userAlias: session.userAlias,
      isAdmin: session.isAdmin,
      pm2Name: session.pm2Name,
      tmuxSession: session.tmuxSession,
      tmuxWindow: session.tmuxWindow,
      targetFile: session.targetFile,
      model: session.model,
      pinnedFile: session.pinnedFile,
      tabOrder: session.tabOrder ?? null,
      metadata: session.metadata,
    };
  }

  private syncNativeAgentSessionMetadata(session: AgentSession): void {
    const nativeSessionId = getAdapterNativeSessionId(session.agent, session.adapter);
    if (!nativeSessionId) return;
    this.setNativeAgentSessionMetadata(session, nativeSessionId, { emit: false });
  }

  private setNativeAgentSessionMetadata(
    session: AgentSession,
    nativeSessionId: string,
    options: { emit: boolean; source?: "preallocated" | "adapter" | "agentapi" | "manual" },
  ): void {
    const existing = session.metadata.nativeAgentSession;
    if (
      existing?.agent === session.agent &&
      existing.sessionId === nativeSessionId &&
      existing.workingDirectory === session.workingDirectory &&
      existing.source === (options.source ?? "adapter")
    ) {
      return;
    }
    session.metadata = normaliseSessionMetadata({
      ...session.metadata,
      nativeAgentSession: createNativeAgentSessionMetadata(
        session.agent,
        nativeSessionId,
        session.workingDirectory,
        options.source ?? "adapter",
      ),
    });
    if (options.emit) {
      this.emit({ type: "session-updated", session: this.toSnapshot(session) });
    }
  }

  private resolveCodexHome(session: AgentSession): string {
    const rawHome =
      typeof session.definition.env?.CODEX_HOME === "string" && session.definition.env.CODEX_HOME.trim()
        ? session.definition.env.CODEX_HOME.trim()
        : typeof Bun.env.CODEX_HOME === "string" && Bun.env.CODEX_HOME.trim()
          ? Bun.env.CODEX_HOME.trim()
          : join(homedir(), ".codex");
    if (rawHome === "~") {
      return homedir();
    }
    if (rawHome.startsWith("~/")) {
      return resolve(homedir(), rawHome.slice(2));
    }
    return resolve(rawHome);
  }

  private normaliseSessionName(name: string | undefined, agent: AgentType, port: number): string {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (trimmed.length > 0) {
      return trimmed;
    }
    return `${agent} :${port}`;
  }

  private emit(event: SessionEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function resolvePm2AgentStartTimeoutMs(): number {
  const configured = Math.floor(Number(process.env.WINGMEN_PM2_AGENT_START_TIMEOUT_MS ?? DEFAULT_PM2_AGENT_START_TIMEOUT_MS));
  if (!Number.isFinite(configured) || configured < 1_000) {
    return DEFAULT_PM2_AGENT_START_TIMEOUT_MS;
  }
  return Math.min(configured, 5 * 60 * 1000);
}
