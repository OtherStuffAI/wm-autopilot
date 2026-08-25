/**
 * Ecosystem config file generator for PM2.
 * Each user gets their own ecosystem.config.cjs in their root folder.
 * Admin uses ./data/admin/ecosystem.config.cjs
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentType, WingmanConfig } from "../config";
import type { AppRecord } from "../apps/app-registry";
import {
  createAppRuntimeEnvelope,
  removeAppRuntimeEnvelope,
  type AppRuntimeEnvelopeReference,
} from "../apps/app-runtime-envelope";
import { wappStore, type WappStore } from "../wapps/wapp-store";
import { getWappRuntimeEnvForWapp } from "../wapps/runtime-env";
import { sanitizeInjectedAgentEnvironment } from "./agent-environment";

export interface EcosystemApp {
  name: string;
  namespace?: string;
  script: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  filter_env?: string[];
  out_file: string;
  error_file: string;
  log_date_format: string;
  merge_logs: boolean;
  autorestart: boolean;
  max_restarts: number;
  min_uptime: string;
}

/** PM2 namespace for agent sessions */
export const PM2_NAMESPACE_AGENTS = "wingman-agents";

/** PM2 namespace for user apps */
export const PM2_NAMESPACE_APPS = "wingman-apps";

export interface EcosystemConfig {
  apps: EcosystemApp[];
}

export interface AgentPm2StartOptions {
  name: string;
  namespace?: string;
  script: string;
  interpreter?: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  filterEnv?: string[];
  output: string;
  error: string;
  logDateFormat: string;
  mergeLogs: boolean;
  autorestart: boolean;
  maxRestarts: number;
  minUptime: string;
}

export interface SessionConfig {
  sessionId: string;
  sessionName: string;
  agent: AgentType;
  port: number;
  workingDirectory: string;
  userAlias: string;
  isAdmin: boolean;
  config: WingmanConfig;
  billingMode?: "credits" | "subscription";
  /** Fully-resolved command (including MCP-injected args) when available. */
  commandOverride?: string[];
  /** Extra env vars (including MCP-injected env) to pass to agentapi process. */
  envOverride?: Record<string, string>;
}

const ECOSYSTEM_FILENAME = "ecosystem.config.cjs";
const AUTOPILOT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ADMIN_DATA_DIR = join(AUTOPILOT_ROOT, "data", "admin");
const USER_APP_RUNNER_PATH = new URL("../apps/app-runner.ts", import.meta.url).pathname;
const BILLING_COMPATIBLE_AGENTS = new Set<AgentType>(["codex", "claude", "goose"]);
const PROVIDER_AUTH_ENV_KEYS = [
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_HOST",
  "OPENROUTER_API_KEY",
  "GOOSE_PROVIDER",
] as const;
type ProviderAuthEnvKey = (typeof PROVIDER_AUTH_ENV_KEYS)[number];
const ecosystemConfigLocks = new Map<string, Promise<void>>();
export const PM2_FILTERED_PARENT_ENV_PREFIXES = [
  // A PM2-managed Autopilot process inherits PM2's own identity fields. PM2 7
  // treats an inherited `pm_id` as an update to the current process, so an
  // agent launch can otherwise overwrite/stop the core `wm-ap` entry instead
  // of creating a new namespaced process.
  "pm_",
  "PM2_",
  // Lowercase PM2 runtime metadata is injected into a PM2-managed parent as
  // environment variables. PM2 merges these back over explicit child start
  // options unless filtered, which can restore Bun as the interpreter and
  // re-enable autorestart for an AgentAPI shell process.
  "exec_",
  "node_",
  "instance",
  "autorestart",
  "prev_restart_delay",
  "restart_",
  "unstable_restart",
  "NODE_APP_INSTANCE",
  "name",
  "namespace",
  "AGENT_NSEC",
  "ANTHROPIC_API_KEY",
  "BROKER_MASTER_KEY",
  "GITEA_API_TOKEN",
  "KEYTELEPORT_PRIVKEY",
  "NOSTR_SECRET_KEY",
  "NWC_",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "S3_SECRET_KEY",
  "WAPP_NSEC",
  "WINGMAN_BROKER_MASTER_KEY",
  "WINGMAN_NSEC",
  "WINGMAN_PRIV",
  "WINGMAN_SIGNING_",
] as const;

export async function withEcosystemConfigLock<T>(
  ecosystemPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = ecosystemConfigLocks.get(ecosystemPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const queued = previous.then(() => current, () => current);
  ecosystemConfigLocks.set(ecosystemPath, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (ecosystemConfigLocks.get(ecosystemPath) === queued) {
      ecosystemConfigLocks.delete(ecosystemPath);
    }
  }
}

/**
 * Get the ecosystem config file path for a user.
 * Admin: ./data/admin/ecosystem.config.cjs
 * Regular users: ~/code/<alias>/ecosystem.config.cjs
 */
export function getEcosystemPath(userRootDir: string, isAdmin: boolean): string {
  if (isAdmin) {
    return join(ADMIN_DATA_DIR, ECOSYSTEM_FILENAME);
  }
  return join(userRootDir, ECOSYSTEM_FILENAME);
}

/**
 * Get the logs directory for a user.
 * Admin: ./data/admin/apps/logs/
 * Regular users: ~/code/<alias>/apps/logs/
 */
export function getLogsDirectory(userRootDir: string, isAdmin: boolean): string {
  if (isAdmin) {
    return join(ADMIN_DATA_DIR, "apps", "logs");
  }
  return join(userRootDir, "apps", "logs");
}

/**
 * Generate a PM2 process name from user alias and session name.
 * Format: {alias}-{sanitized-session-name}-{session-id-prefix}
 * This keeps names human-readable while guaranteeing uniqueness per session.
 */
export function generateProcessName(userAlias: string, sessionName: string, sessionId: string): string {
  const sanitizedAlias = userAlias.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const sanitizedName = sessionName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const truncatedName = sanitizedName.slice(0, 32) || "session";
  const sessionSuffix = sessionId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "session";
  return `${sanitizedAlias}-${truncatedName}-${sessionSuffix}`;
}

/**
 * Read an existing ecosystem config file.
 * Returns empty config if file doesn't exist.
 */
export async function readEcosystemConfig(ecosystemPath: string): Promise<EcosystemConfig> {
  try {
    const content = await readFile(ecosystemPath, "utf-8");
    // Generated ecosystem files are deliberately JSON-shaped CommonJS. Never
    // execute a project-controlled config while detecting or managing apps.
    const match = content.match(/^\s*(?:\/\/[^\n]*\n\s*)*module\.exports\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (!match) {
      throw new Error(`Refusing executable or malformed PM2 ecosystem config: ${ecosystemPath}`);
    }
    const config = JSON.parse(match[1]!) as EcosystemConfig;
    if (!config || !Array.isArray(config.apps)) {
      throw new Error(`PM2 ecosystem config must contain an apps array: ${ecosystemPath}`);
    }
    return config;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return { apps: [] };
    }
    throw error;
  }
}

/**
 * Write an ecosystem config file.
 * Creates parent directories if they don't exist.
 */
export async function writeEcosystemConfig(
  ecosystemPath: string,
  config: EcosystemConfig,
): Promise<void> {
  const ecosystemDir = dirname(ecosystemPath);
  await mkdir(ecosystemDir, { recursive: true });

  const content = `// PM2 Ecosystem Configuration
// Auto-generated by Wingman - do not edit manually
module.exports = ${JSON.stringify(config, null, 2)};
`;

  const tmpPath = join(ecosystemDir, `.${ECOSYSTEM_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, ecosystemPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Build the agentapi command for a session.
 */
function buildAgentCommand(sessionConfig: SessionConfig): { script: string; args: string[] } {
  if (Array.isArray(sessionConfig.commandOverride) && sessionConfig.commandOverride.length > 0) {
    const [script, ...args] = sessionConfig.commandOverride;
    if (!script) {
      throw new Error("Session command override is empty");
    }
    return { script, args };
  }

  const { agent, port, config } = sessionConfig;
  const definition = config.agents[agent];
  const commandParts = definition.command({ port, agent, config });

  if (commandParts.length === 0) {
    throw new Error(`Agent ${agent} command returned empty array`);
  }

  // First element is the script (agentapi binary), rest are args
  const [script, ...args] = commandParts;
  return { script: script!, args };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function shellExport(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
}

function toLockedProviderEnvVarName(key: ProviderAuthEnvKey): string {
  return `WINGMAN_LOCKED_${key}`;
}

function buildProviderEnvBootstrap(
  sessionConfig: SessionConfig,
  runtimeEnv: Record<string, string>,
): string {
  // Always strip server-only secrets from agent subprocesses.
  const snippets: string[] = [
    "unset KEYTELEPORT_PRIVKEY WINGMAN_PRIV WINGMAN_SIGNING_SECRET WINGMAN_SIGNING_TOKEN",
  ];
  const billingMode = sessionConfig.billingMode ?? "subscription";
  const shouldSanitizeProviderEnv = BILLING_COMPATIBLE_AGENTS.has(sessionConfig.agent);

  if (shouldSanitizeProviderEnv && billingMode === "subscription") {
    snippets.push(`unset ${PROVIDER_AUTH_ENV_KEYS.join(" ")}`);
  }

  for (const envKey of PROVIDER_AUTH_ENV_KEYS) {
    const value = runtimeEnv[envKey];
    if (!value) continue;
    const lockedVarName = toLockedProviderEnvVarName(envKey);
    runtimeEnv[lockedVarName] = value;
    snippets.push(`if [ -n "\${${lockedVarName}:-}" ]; then export ${envKey}="$${lockedVarName}"; fi`);
  }

  if (snippets.length === 0) {
    return "";
  }
  return `${snippets.join("; ")}; `;
}

/**
 * Create an ecosystem app entry for a session.
 */
export function createAppConfig(sessionConfig: SessionConfig): EcosystemApp {
  const { sessionId, sessionName, port, workingDirectory, userAlias, isAdmin } = sessionConfig;
  const processName = generateProcessName(userAlias, sessionName, sessionId);
  const logsDir = getLogsDirectory(workingDirectory, isAdmin);
  const { script, args } = buildAgentCommand(sessionConfig);

  const command = [script, ...args].map(shellQuote).join(" ");
  // Build runtime env from session + injected vars. Strip server-only secrets
  // if they leaked through envOverride.
  const cleanEnvOverride = sanitizeInjectedAgentEnvironment(sessionConfig.envOverride ?? {});
  const runtimeEnv: Record<string, string> = {
    WINGMAN_PROCESS_KIND: "agent-session",
    SESSION_ID: sessionId,
    SESSION_NAME: sessionName,
    SESSION_PORT: String(port),
    SESSION_DIRECTORY: workingDirectory,
    SESSION_AGENT: sessionConfig.agent,
    USER_ALIAS: userAlias,
    ...cleanEnvOverride,
  };
  const providerEnvBootstrap = buildProviderEnvBootstrap(sessionConfig, runtimeEnv);

  return {
    name: processName,
    namespace: PM2_NAMESPACE_AGENTS,
    // AgentAPI blocks on stdin in PM2 unless stdin is closed.
    // Run via bash and redirect stdin from /dev/null so the server can start.
    script: "bash",
    args: ["-lc", `${providerEnvBootstrap}exec ${command} < /dev/null`],
    cwd: workingDirectory,
    env: runtimeEnv,
    filter_env: [...PM2_FILTERED_PARENT_ENV_PREFIXES],
    out_file: join(logsDir, `${processName}-out.log`),
    error_file: join(logsDir, `${processName}-error.log`),
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    merge_logs: true,
    autorestart: false,
    max_restarts: 0,
    min_uptime: "5s",
  };
}

export function createAgentPm2StartOptions(sessionConfig: SessionConfig): AgentPm2StartOptions {
  const appConfig = createAppConfig(sessionConfig);
  return {
    name: appConfig.name,
    namespace: appConfig.namespace,
    script: appConfig.script,
    // The Autopilot parent itself runs under Bun. Without an explicit
    // interpreter PM2 can inherit Bun and try to parse /bin/bash as JS.
    interpreter: "none",
    args: appConfig.args,
    cwd: appConfig.cwd,
    env: appConfig.env,
    filterEnv: appConfig.filter_env,
    output: appConfig.out_file,
    error: appConfig.error_file,
    logDateFormat: appConfig.log_date_format,
    mergeLogs: appConfig.merge_logs,
    autorestart: appConfig.autorestart,
    maxRestarts: appConfig.max_restarts,
    minUptime: appConfig.min_uptime,
  };
}

/**
 * Add an app to a user's ecosystem config.
 * Creates the file if it doesn't exist.
 */
export async function addAppToEcosystem(
  sessionConfig: SessionConfig,
  options: { lock?: boolean } = {},
): Promise<{ ecosystemPath: string; processName: string; logsDir: string }> {
  const ecosystemPath = getEcosystemPath(sessionConfig.workingDirectory, sessionConfig.isAdmin);
  if (options.lock === false) {
    return addAppToEcosystemUnlocked(sessionConfig, ecosystemPath);
  }
  return withEcosystemConfigLock(ecosystemPath, () => addAppToEcosystemUnlocked(sessionConfig, ecosystemPath));
}

async function addAppToEcosystemUnlocked(
  sessionConfig: SessionConfig,
  ecosystemPath: string,
): Promise<{ ecosystemPath: string; processName: string; logsDir: string }> {
  const logsDir = getLogsDirectory(sessionConfig.workingDirectory, sessionConfig.isAdmin);

  // Ensure logs directory exists
  await mkdir(logsDir, { recursive: true });

  // Read existing config
  const config = await readEcosystemConfig(ecosystemPath);

  // Create app config
  const appConfig = createAppConfig(sessionConfig);

  // Check if app with same name already exists
  const existingIndex = config.apps.findIndex((app) => app.name === appConfig.name);
  if (existingIndex >= 0) {
    // Update existing entry
    config.apps[existingIndex] = appConfig;
  } else {
    // Add new entry
    config.apps.push(appConfig);
  }

  // Write updated config
  await writeEcosystemConfig(ecosystemPath, config);

  return {
    ecosystemPath,
    processName: appConfig.name,
    logsDir,
  };
}

/**
 * Remove an app from a user's ecosystem config by process name.
 */
export async function removeAppFromEcosystem(
  userRootDir: string,
  isAdmin: boolean,
  processName: string,
): Promise<boolean> {
  const ecosystemPath = getEcosystemPath(userRootDir, isAdmin);
  return withEcosystemConfigLock(ecosystemPath, () => removeAppFromEcosystemUnlocked(ecosystemPath, processName));
}

async function removeAppFromEcosystemUnlocked(
  ecosystemPath: string,
  processName: string,
): Promise<boolean> {
  try {
    const config = await readEcosystemConfig(ecosystemPath);
    const initialLength = config.apps.length;
    config.apps = config.apps.filter((app) => app.name !== processName);

    if (config.apps.length === initialLength) {
      // App wasn't in config
      return false;
    }

    await writeEcosystemConfig(ecosystemPath, config);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Find an app in the ecosystem config by session ID.
 * Searches through env vars since SESSION_ID is stored there.
 */
export async function findAppBySessionId(
  userRootDir: string,
  isAdmin: boolean,
  sessionId: string,
): Promise<EcosystemApp | null> {
  const ecosystemPath = getEcosystemPath(userRootDir, isAdmin);

  try {
    const config = await readEcosystemConfig(ecosystemPath);
    return config.apps.find((app) => app.env?.SESSION_ID === sessionId) ?? null;
  } catch {
    return null;
  }
}

/**
 * List all apps in a user's ecosystem config.
 */
export async function listAppsInEcosystem(
  userRootDir: string,
  isAdmin: boolean,
): Promise<EcosystemApp[]> {
  const ecosystemPath = getEcosystemPath(userRootDir, isAdmin);

  try {
    const config = await readEcosystemConfig(ecosystemPath);
    return config.apps;
  } catch {
    return [];
  }
}

// =============================================================================
// User App (non-agent) PM2 Configuration
// =============================================================================

export interface UserAppConfig {
  app: AppRecord;
  userAlias: string;
  userRootDir: string;
  isAdmin: boolean;
  wappStore?: WappStore;
}

/**
 * Generate a PM2 process name for a user app.
 * Format: {alias}-app-{sanitized-label}
 * The "-app-" infix distinguishes apps from agent sessions.
 */
export function generateAppProcessName(userAlias: string, appLabel: string): string {
  const sanitizedAlias = userAlias.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const sanitizedLabel = appLabel
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const truncatedLabel = sanitizedLabel.slice(0, 32) || "app";
  return `${sanitizedAlias}-app-${truncatedLabel}`.slice(0, 48);
}

/**
 * Create an ecosystem app entry for a user app.
 * Runs the reviewed lifecycle argv through the dedicated app runner.
 */
export async function createUserAppEcosystemConfig(
  config: UserAppConfig,
  runtimeEnvEnvelope?: AppRuntimeEnvelopeReference,
): Promise<EcosystemApp> {
  const { app, userAlias, userRootDir, isAdmin } = config;
  const processName = generateAppProcessName(userAlias, app.label);
  const logsDir = getLogsDirectory(userRootDir, isAdmin);

  // Get the start script
  const startCommand = app.scripts.start;
  if (!startCommand) {
    throw new Error(`App ${app.id} has no start script defined`);
  }

  const store = config.wappStore ?? wappStore;
  const wapp = store.getByAppId(app.id);
  const args = [
    USER_APP_RUNNER_PATH,
    "--app-id",
    app.id,
    "--app-label",
    app.label,
    "--app-root",
    app.root,
    "--executable",
    startCommand.executable,
    "--user-alias",
    userAlias,
  ];
  for (const arg of startCommand.args) args.push("--arg", arg);
  if (app.webApp && app.webAppPort) {
    args.push("--port", String(app.webAppPort));
  }
  if (wapp) {
    args.push("--wapp-id", wapp.id);
  }
  if (runtimeEnvEnvelope) {
    args.push("--runtime-env-path", runtimeEnvEnvelope.path);
    args.push("--runtime-env-key", runtimeEnvEnvelope.key);
  }

  return {
    name: processName,
    namespace: PM2_NAMESPACE_APPS,
    script: "bun",
    args,
    cwd: app.root,
    env: {
      WINGMAN_PROCESS_KIND: "user-app",
      APP_ID: app.id,
      USER_ALIAS: userAlias,
      ...(wapp ? { WAPP_ID: wapp.id } : {}),
    },
    filter_env: [...PM2_FILTERED_PARENT_ENV_PREFIXES],
    out_file: join(logsDir, `${processName}-out.log`),
    error_file: join(logsDir, `${processName}-error.log`),
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    merge_logs: true,
    autorestart: false,
    max_restarts: 0,
    min_uptime: "5s",
  };
}

/**
 * Add a user app to the ecosystem config.
 */
export async function addUserAppToEcosystem(
  config: UserAppConfig,
): Promise<{ ecosystemPath: string; processName: string; logsDir: string; runtimeEnvPath: string }> {
  const ecosystemPath = getEcosystemPath(config.userRootDir, config.isAdmin);
  return withEcosystemConfigLock(ecosystemPath, () => addUserAppToEcosystemUnlocked(config, ecosystemPath));
}

async function addUserAppToEcosystemUnlocked(
  config: UserAppConfig,
  ecosystemPath: string,
): Promise<{ ecosystemPath: string; processName: string; logsDir: string; runtimeEnvPath: string }> {
  const logsDir = getLogsDirectory(config.userRootDir, config.isAdmin);

  // Ensure logs directory exists
  await mkdir(logsDir, { recursive: true });

  const store = config.wappStore ?? wappStore;
  const wapp = store.getByAppId(config.app.id);
  const runtimeEnv = {
    ...(config.app.env ?? {}),
    ...(wapp ? getWappRuntimeEnvForWapp(wapp.id, config.app.root, store) : {}),
  };
  const runtimeEnvEnvelope = await createAppRuntimeEnvelope(
    join(logsDir, ".runtime-env"),
    config.app.id,
    runtimeEnv,
  );

  try {
    // Read existing config
    const ecosystemConfig = await readEcosystemConfig(ecosystemPath);

    const appConfig = await createUserAppEcosystemConfig(config, runtimeEnvEnvelope);

    // Check if app with same name already exists
    const existingIndex = ecosystemConfig.apps.findIndex((a) => a.name === appConfig.name);
    if (existingIndex >= 0) {
      // Update existing entry
      ecosystemConfig.apps[existingIndex] = appConfig;
    } else {
      // Add new entry
      ecosystemConfig.apps.push(appConfig);
    }

    // Write updated config
    await writeEcosystemConfig(ecosystemPath, ecosystemConfig);

    return {
      ecosystemPath,
      processName: appConfig.name,
      logsDir,
      runtimeEnvPath: runtimeEnvEnvelope.path,
    };
  } catch (error) {
    await removeAppRuntimeEnvelope(runtimeEnvEnvelope.path);
    throw error;
  }
}
