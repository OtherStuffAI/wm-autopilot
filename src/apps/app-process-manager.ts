import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../config";
import { appRegistry } from "./app-registry";
import type { AppLifecycleAction, AppRecord, AppRegistry } from "./app-registry";
import type { AppCommand } from "./app-command";
import { buildManagedAppSpawnPlan } from "./app-runtime-env";
import { removeAppRuntimeEnvelope } from "./app-runtime-envelope";
import { summarizeAppStartupLogs } from "./app-startup-diagnostics";
import { AppActionError, AppActionInProgressError, AppScriptMissingError } from "./app-process-errors";
import { clearAppLogFiles } from "./app-log-files";
import { generateIdentityAlias } from "../identity/identity-alias";
import { getConfiguredAdminNpubs, isNpubInList, normaliseNpub, normaliseNpubList } from "../identity/npub-utils";
import {
  addUserAppToEcosystem,
  generateAppProcessName,
  getEcosystemPath,
  getLogsDirectory,
  removeAppFromEcosystem,
} from "../agents/ecosystem-generator";
import {
  deleteProcess,
  getProcessByName,
  getProcessRuntimeInfo,
  startProcessFromConfig,
  stopProcess,
} from "../agents/pm2-wrapper";
import { readCombinedLogs, readLogTail } from "../agents/log-reader";
import { sanitizeLogEntry } from "../logging/log-sanitizer";
import { runtimePortRegistry } from "./runtime-port-registry";
import { waitForListeningPort, waitForTcpPort } from "../utils/port-utils";
import { wappStore, type WappStore } from "../wapps/wapp-store";
import { getWappRuntimeEnvForWapp } from "../wapps/runtime-env";
import type { RuntimeBotIdentity } from "../agent-chat/types";
import {
  HttpTowerWappRegistrar,
  registerTowerBackedWappAssignment,
  requireTowerWappRegistrationIdentity,
  type TowerWappRegistrar,
} from "../wapps/tower-registration";

export type AppRuntimeStatus =
  | "idle"
  | "running"
  | "stopping"
  | "restarting"
  | "setting-up"
  | "building"
  | "failed";

export interface AppProcessStatus {
  appId: string;
  status: AppRuntimeStatus;
  lastAction: AppLifecycleAction | null;
  lastExitCode: number | null;
  message?: string;
  updatedAt: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  running: boolean;
  inProgressAction: AppLifecycleAction | null;
  /** Port the app is running on (from PM2 runtime). */
  runtimePort?: number | null;
  /** Process ID (from PM2 runtime). */
  pid?: number | null;
  /** Memory usage in bytes (from PM2 runtime). */
  memory?: number | null;
}

interface AppRuntimeState {
  status: AppRuntimeStatus;
  lastAction: AppLifecycleAction | null;
  lastExitCode: number | null;
  message?: string;
  updatedAt: string;
  inProgress: AppLifecycleAction | null;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

export { AppActionError, AppActionInProgressError, AppScriptMissingError } from "./app-process-errors";

const ACTION_STATUS: Record<AppLifecycleAction, AppRuntimeStatus> = {
  start: "running",
  stop: "stopping",
  restart: "restarting",
  setup: "setting-up",
  build: "building",
};

function summarizeCommandOutput(output: string, fallback: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const meaningful = [...lines].reverse().find((line) =>
    !line.startsWith("$ ")
    && !/^bun v\d/i.test(line)
    && !/^error: script ".+" exited with code \d+$/i.test(line)
  );
  return meaningful ? `${fallback}: ${meaningful.slice(0, 240)}` : fallback;
}

function oneShotLogNames(app: AppRecord, action?: "setup" | "build"): string[] {
  const actions = action ? [action] : ["setup", "build"] as const;
  const prefixes = [app.id, app.pm2Name].filter((value): value is string => Boolean(value));
  return prefixes.flatMap((prefix) => actions.map((entry) => `${prefix}-${entry}.log`));
}

async function readOneShotLogs(app: AppRecord, logsDir: string, lines: number): Promise<string[]> {
  const entries: string[] = [];
  for (const logName of oneShotLogNames(app)) {
    const content = await readLogTail(join(logsDir, logName), lines);
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sanitized = sanitizeLogEntry(`[${logName}] ${trimmed}`);
      if (sanitized) entries.push(sanitized);
    }
  }
  return entries;
}

export class AppProcessManager {
  private readonly registry: AppRegistry;
  private readonly states = new Map<string, AppRuntimeState>();
  private readonly config = loadConfig();
  private readonly adminNpubs: string[];
  private readonly wappStore: WappStore;
  private towerRegistrationIdentity: RuntimeBotIdentity | null;
  private towerWappRegistrar: TowerWappRegistrar;
  private readonly spawn: typeof Bun.spawn;

  constructor(
    registry: AppRegistry = appRegistry,
    adminNpubs?: string | string[] | null,
    store: WappStore = wappStore,
    towerRegistrationIdentity: RuntimeBotIdentity | null = null,
    towerWappRegistrar: TowerWappRegistrar = new HttpTowerWappRegistrar(),
    spawn: typeof Bun.spawn = Bun.spawn,
  ) {
    this.registry = registry;
    this.adminNpubs = adminNpubs === undefined ? getConfiguredAdminNpubs() : normaliseNpubList(adminNpubs);
    this.wappStore = store;
    this.towerRegistrationIdentity = towerRegistrationIdentity;
    this.towerWappRegistrar = towerWappRegistrar;
    this.spawn = spawn;
  }

  configureTowerRegistration(input: {
    identity: RuntimeBotIdentity | null;
    registrar?: TowerWappRegistrar;
  }): void {
    this.towerRegistrationIdentity = input.identity;
    if (input.registrar) {
      this.towerWappRegistrar = input.registrar;
    }
  }

  async getStatus(appId: string): Promise<AppProcessStatus> {
    const app = await this.registry.getApp(appId);
    if (!app) {
      throw new Error(`Unknown app: ${appId}`);
    }
    const state = await this.resolveState(app);
    return this.toStatus(app, state);
  }

  async start(appId: string): Promise<AppProcessStatus> {
    return this.runAction(appId, "start", async (app) => {
      this.requireScript(app, "start");
      await this.ensureTowerWappRegistered(app);
      const processName = await this.startManagedAppProcess(app);

      return {
        finalStatus: "running" as AppRuntimeStatus,
        exitCode: 0,
        message: `Started via PM2 as ${processName}`,
      };
    });
  }

  async stop(appId: string): Promise<AppProcessStatus> {
    return this.runAction(appId, "stop", async (app) => {
      // Clear runtime port first
      runtimePortRegistry.clear(app.id);

      const processName = app.pm2Name;
      if (!processName) {
        return {
          finalStatus: "idle" as AppRuntimeStatus,
          exitCode: 0,
          message: "App was not running (no PM2 process)",
        };
      }

      try {
        await stopProcess(processName);
        await deleteProcess(processName);
      } catch (error) {
        // Process might not exist, which is fine
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("not found") && !message.includes("doesn't exist")) {
          throw error;
        }
      }

      // Remove from ecosystem
      const { userRootDir, isAdmin } = this.resolveUserContext(app);
      await removeAppFromEcosystem(userRootDir, isAdmin, processName);

      return {
        finalStatus: "idle" as AppRuntimeStatus,
        exitCode: 0,
        message: "Stopped and removed from PM2",
      };
    });
  }

  async restart(appId: string): Promise<AppProcessStatus> {
    return this.runAction(appId, "restart", async (app) => {
      const startScript = app.scripts.start;
      if (!startScript) {
        throw new AppScriptMissingError(app.id, "restart");
      }
      await this.ensureTowerWappRegistered(app);

      // Clear runtime port before restart
      runtimePortRegistry.clear(app.id);

      const processName = app.pm2Name;
      if (processName) {
        const proc = await getProcessByName(processName).catch(() => null);
        if (proc) {
          await deleteProcess(processName);
          const refreshedProcessName = await this.startManagedAppProcess(app);
          return {
            finalStatus: "running" as AppRuntimeStatus,
            exitCode: 0,
            message: `Restarted PM2 process ${refreshedProcessName}`,
          };
        }
      }

      const newProcessName = await this.startManagedAppProcess(app);

      return {
        finalStatus: "running" as AppRuntimeStatus,
        exitCode: 0,
        message: `Started via PM2 as ${newProcessName}`,
      };
    });
  }

  async build(appId: string): Promise<AppProcessStatus> {
    return this.runAction(appId, "build", async (app) => {
      const script = this.requireScript(app, "build");
      const result = await this.runOneShot(app, script, "build");
      const failureMessage = `Build failed with exit code ${result.exitCode}`;
      return {
        finalStatus: result.exitCode === 0 ? ("idle" as AppRuntimeStatus) : ("failed" as AppRuntimeStatus),
        exitCode: result.exitCode,
        message: result.exitCode === 0 ? "Build completed" : summarizeCommandOutput(result.output, failureMessage),
      };
    });
  }

  async setup(appId: string): Promise<AppProcessStatus> {
    return this.runAction(appId, "setup", async (app) => {
      const script = this.requireScript(app, "setup");
      await this.ensureTowerWappRegistered(app);
      const result = await this.runOneShot(app, script, "setup");
      const failureMessage = `Setup failed with exit code ${result.exitCode}`;
      return {
        finalStatus: result.exitCode === 0 ? ("idle" as AppRuntimeStatus) : ("failed" as AppRuntimeStatus),
        exitCode: result.exitCode,
        message: result.exitCode === 0 ? "Setup completed" : summarizeCommandOutput(result.output, failureMessage),
      };
    });
  }

  async tailLogs(appId: string, lines = 100): Promise<string[]> {
    if (lines <= 0) {
      return [];
    }
    const app = await this.registry.getApp(appId);
    if (!app) {
      throw new Error(`Unknown app: ${appId}`);
    }

    const { userRootDir, isAdmin } = this.resolveUserContext(app);
    const resolvedLogsDir = app.logsDir ?? getLogsDirectory(userRootDir, isAdmin);
    const combinedLogs: string[] = [];

    const oneShotLogs = await readOneShotLogs(app, resolvedLogsDir, lines);
    combinedLogs.push(...oneShotLogs);

    if (app.pm2Name) {
      try {
        combinedLogs.push(...await readCombinedLogs(resolvedLogsDir, app.pm2Name, lines));
      } catch {
        // Fall through to one-shot logs.
      }
    }

    return combinedLogs.slice(-lines);
  }

  async clearLogs(appId: string): Promise<void> {
    const app = await this.registry.getApp(appId);
    if (!app) {
      throw new Error(`Unknown app: ${appId}`);
    }
    const { userRootDir, isAdmin } = this.resolveUserContext(app);
    const logsDir = app.logsDir ?? getLogsDirectory(userRootDir, isAdmin);

    await clearAppLogFiles({
      logsDir,
      appId: app.id,
      processName: app.pm2Name ?? null,
    });
  }

  async listStatuses(): Promise<AppProcessStatus[]> {
    const apps = await this.registry.listApps();
    const statuses = await Promise.all(
      apps.map((app) => this.resolveState(app).then((state) => this.toStatus(app, state))),
    );
    return statuses;
  }

  async kill(appId: string): Promise<void> {
    const app = await this.registry.getApp(appId);
    if (!app) {
      throw new Error(`Unknown app: ${appId}`);
    }

    if (app.pm2Name) {
      try {
        await stopProcess(app.pm2Name);
        await deleteProcess(app.pm2Name);
      } catch {
        // Ignore errors - process might not exist
      }
    }

    this.states.delete(appId);
  }

  forget(appId: string) {
    this.states.delete(appId);
  }

  private async runAction(
    appId: string,
    action: AppLifecycleAction,
    handler: (app: AppRecord) => Promise<{ finalStatus: AppRuntimeStatus; exitCode?: number | null; message?: string }>,
  ): Promise<AppProcessStatus> {
    const app = await this.registry.getApp(appId);
    if (!app) {
      throw new Error(`Unknown app: ${appId}`);
    }
    if (app.lifecycleReviewRequired && action !== "stop") {
      throw new AppActionError(
        app.id,
        action,
        `App lifecycle requires Admin review: ${(app.lifecycleReviewReasons ?? []).join(", ")}`,
      );
    }
    const state = await this.resolveState(app);
    if (state.inProgress) {
      throw new AppActionInProgressError(app.id, state.inProgress);
    }

    state.inProgress = action;
    state.status = ACTION_STATUS[action];
    state.lastAction = action;
    state.updatedAt = new Date().toISOString();
    try {
      const { finalStatus, exitCode, message } = await handler(app);
      state.status = finalStatus;
      state.lastExitCode = exitCode ?? null;
      state.message = message;
      state.updatedAt = new Date().toISOString();
      state.lastSuccessAt = state.updatedAt;
      state.inProgress = null;
      return this.toStatus(app, state);
    } catch (error) {
      state.status = "failed";
      state.lastExitCode = null;
      state.message = (error as Error).message;
      state.updatedAt = new Date().toISOString();
      state.lastFailureAt = state.updatedAt;
      throw error;
    } finally {
      if (state.inProgress === action) {
        state.inProgress = null;
      }
    }
  }

  private async resolveState(app: AppRecord): Promise<AppRuntimeState> {
    const existing = this.states.get(app.id);
    if (existing) {
      // Check if PM2 process is actually running
      if (app.pm2Name) {
        const running = await this.isPM2ProcessRunning(app.pm2Name);
        existing.status = running ? "running" : "idle";
        existing.updatedAt = new Date().toISOString();
      }
      return existing;
    }

    // Check if app is running via PM2
    const running = app.pm2Name ? await this.isPM2ProcessRunning(app.pm2Name) : false;
    const status: AppRuntimeState = {
      status: running ? "running" : "idle",
      lastAction: null,
      lastExitCode: null,
      updatedAt: new Date().toISOString(),
      inProgress: null,
    };
    this.states.set(app.id, status);
    return status;
  }

  private async toStatus(app: AppRecord, state: AppRuntimeState): Promise<AppProcessStatus> {
    const status: AppProcessStatus = {
      appId: app.id,
      status: state.status,
      lastAction: state.lastAction,
      lastExitCode: state.lastExitCode,
      message: state.message,
      updatedAt: state.updatedAt,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
      running: state.status === "running",
      inProgressAction: state.inProgress,
    };

    // Fetch PM2 runtime info if app has a PM2 process
    if (app.pm2Name && state.status === "running") {
      try {
        const runtimeInfo = await getProcessRuntimeInfo(app.pm2Name);
        if (runtimeInfo) {
          status.runtimePort =
            app.webApp && typeof app.webAppPort === "number" && app.webAppPort > 0
              ? app.webAppPort
              : runtimeInfo.port;
          status.pid = runtimeInfo.pid;
          status.memory = runtimeInfo.memory;
        }
      } catch {
        // Ignore errors fetching runtime info
      }
    }

    return status;
  }

  private requireScript(app: AppRecord, action: AppLifecycleAction): AppCommand {
    const script = app.scripts[action];
    if (!script) {
      throw new AppScriptMissingError(app.id, action);
    }
    return script;
  }

  private resolveUserContext(app: AppRecord): { userAlias: string; userRootDir: string; isAdmin: boolean } {
    const ownerNpub = normaliseNpub(app.ownerNpub);
    const isAdmin = isNpubInList(ownerNpub, this.adminNpubs);

    // Derive alias from owner or use a fallback
    const userAlias = ownerNpub
      ? generateIdentityAlias(ownerNpub)
      : "anonymous";

    // For admin, use admin data dir; for users, use their root
    const userRootDir = isAdmin
      ? this.config.defaultWorkingDirectory
      : app.root;

    return { userAlias, userRootDir, isAdmin };
  }

  private async ensureTowerWappRegistered(app: AppRecord): Promise<void> {
    const wapp = this.wappStore.getByAppId(app.id);
    if (!wapp?.towerBindingId) return;
    const authority = requireTowerWappRegistrationIdentity(this.towerRegistrationIdentity);
    await registerTowerBackedWappAssignment({
      wapp,
      appName: wapp.title || app.label || app.id,
      authority,
      registrar: this.towerWappRegistrar,
    });
  }

  private async isPM2ProcessRunning(processName: string): Promise<boolean> {
    try {
      const proc = await getProcessByName(processName);
      return proc?.pm2_env?.status === "online";
    } catch {
      return false;
    }
  }

  private async startManagedAppProcess(app: AppRecord): Promise<string> {
    const { userAlias, userRootDir, isAdmin } = this.resolveUserContext(app);
    const launch = await addUserAppToEcosystem({
      app,
      userAlias,
      userRootDir,
      isAdmin,
      wappStore: this.wappStore,
    });
    try {
      await this.registry.updateApp(app.id, { pm2Name: launch.processName, logsDir: launch.logsDir });
      await startProcessFromConfig(launch.ecosystemPath, launch.processName);
      await this.registerRuntimePort(app, launch.processName);
      return launch.processName;
    } finally {
      await removeAppRuntimeEnvelope(launch.runtimeEnvPath);
    }
  }

  /**
   * Register the runtime port for an app after start/restart.
   * Uses the known webAppPort if available, otherwise falls back to detection.
   */
  private async registerRuntimePort(app: AppRecord, processName: string): Promise<void> {
    try {
      const runtimeInfo = await getProcessRuntimeInfo(processName);
      const pid = runtimeInfo?.pid ?? 0;

      // Use known webAppPort if this is a web app with assigned port
      if (app.webApp && typeof app.webAppPort === "number" && app.webAppPort > 0) {
        const ready = await waitForTcpPort(app.webAppPort);
        if (!ready) {
          const { userRootDir, isAdmin } = this.resolveUserContext(app);
          const logs = await readCombinedLogs(getLogsDirectory(userRootDir, isAdmin), processName, 50)
            .catch(() => []);
          const detail = summarizeAppStartupLogs(logs);
          if (detail) {
            throw new Error(`App ${app.id} failed to start: ${detail}`);
          }
          throw new Error(`App ${app.id} did not listen on assigned port ${app.webAppPort} after PM2 start`);
        }
        runtimePortRegistry.set(app.id, app.webAppPort, pid);
        console.log(`[app-process-manager] Registered known port ${app.webAppPort} for ${processName}`);
        return;
      }

      // Fall back to dynamic detection for apps without known port
      if (!pid) {
        console.warn(`[app-process-manager] No PID found for ${processName}, cannot detect port`);
        return;
      }

      const port = await waitForListeningPort(pid, { maxAttempts: 5, delayMs: 500 });
      if (port !== null) {
        runtimePortRegistry.set(app.id, port, pid);
        console.log(`[app-process-manager] Detected and registered port ${port} for ${processName}`);
      } else {
        console.warn(`[app-process-manager] Could not detect listening port for ${processName} (pid ${pid})`);
      }
    } catch (error) {
      if (app.webApp && typeof app.webAppPort === "number" && app.webAppPort > 0) {
        throw error;
      }
      console.warn(`[app-process-manager] Error registering port for ${processName}:`, error);
    }
  }

  /**
   * Run a one-shot command (build/setup) via Bun.spawn.
   * Logs output to the app's log directory.
   */
  private async runOneShot(
    app: AppRecord,
    command: AppCommand,
    action: string,
  ): Promise<{ exitCode: number; output: string }> {
    const { userRootDir, isAdmin } = this.resolveUserContext(app);
    const logsDir = getLogsDirectory(userRootDir, isAdmin);
    await mkdir(logsDir, { recursive: true });
    if (app.logsDir !== logsDir) {
      await this.registry.updateApp(app.id, { logsDir });
    }

    const wapp = this.wappStore.getByAppId(app.id);
    const wappEnv = wapp ? getWappRuntimeEnvForWapp(wapp.id, app.root, this.wappStore) : {};
    const plan = buildManagedAppSpawnPlan({
      app,
      command,
      cwd: app.root,
      userAlias: this.resolveUserContext(app).userAlias,
      wappEnv,
    });
    const subprocess = this.spawn(plan.cmd, {
      cwd: plan.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: plan.env,
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);

    // Write to log file
    const logFileName = app.pm2Name ? `${app.pm2Name}-${action}.log` : `${app.id}-${action}.log`;
    const logPath = join(logsDir, logFileName);
    const timestamp = new Date().toISOString();
    const logContent = `\n=== ${action.toUpperCase()} at ${timestamp} ===\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}\n`;
    await appendFile(logPath, logContent, "utf8");

    return {
      exitCode: exitCode ?? 1,
      output: stdout + stderr,
    };
  }
}

export const appProcessManager = new AppProcessManager();
