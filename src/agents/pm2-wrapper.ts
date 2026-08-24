/**
 * Promise-based wrappers for PM2's callback API.
 * Provides a clean async/await interface for process management.
 */

import pm2 from "pm2";
import type { ProcessDescription, StartOptions } from "pm2";

export type PM2ProcessDescription = ProcessDescription;

export interface PM2StartOptions {
  name: string;
  namespace?: string;
  script: string;
  interpreter?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  filterEnv?: string[];
  output?: string;
  error?: string;
  logDateFormat?: string;
  mergeLogs?: boolean;
  autorestart?: boolean;
  maxRestarts?: number;
  minUptime?: string;
}

let connected = false;

/**
 * Parse min_uptime string to milliseconds.
 * Supports formats like "5s", "1000" (ms), or "1m".
 */
function parseMinUptime(value: string): number {
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)(s|ms|m)?$/);
  if (!match) {
    return 5000; // default 5 seconds
  }
  const num = parseInt(match[1]!, 10);
  const unit = match[2] || "ms";
  switch (unit) {
    case "s":
      return num * 1000;
    case "m":
      return num * 60 * 1000;
    default:
      return num;
  }
}

/**
 * Connect to the PM2 daemon. Call once at server startup.
 */
export function connectPM2(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (connected) {
      resolve();
      return;
    }
    pm2.connect((err) => {
      if (err) {
        reject(err);
      } else {
        connected = true;
        resolve();
      }
    });
  });
}

/**
 * Disconnect from the PM2 daemon. Call on graceful shutdown.
 */
export function disconnectPM2(): Promise<void> {
  return new Promise((resolve) => {
    if (!connected) {
      resolve();
      return;
    }
    pm2.disconnect();
    connected = false;
    resolve();
  });
}

/**
 * Check if we're connected to PM2.
 */
export function isConnected(): boolean {
  return connected;
}

/**
 * List all PM2 managed processes.
 */
export function listProcesses(): Promise<PM2ProcessDescription[]> {
  return new Promise((resolve, reject) => {
    pm2.list((err, list) => {
      if (err) {
        reject(err);
      } else {
        resolve(list);
      }
    });
  });
}

/**
 * Get a specific process by name.
 */
export async function getProcessByName(name: string): Promise<PM2ProcessDescription | null> {
  const processes = await listProcesses();
  return processes.find((p) => p.name === name) ?? null;
}

/**
 * Start a process from an ecosystem config file.
 * @param configPath - Path to the ecosystem.config.cjs file
 * @param appName - Name of the app to start (must match name in config)
 */
export function startProcessFromConfig(configPath: string, appName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // PM2's type definitions don't include 'only' but it's a valid runtime option
    const options = { only: appName } as Record<string, string>;
    pm2.start(configPath, options as unknown as StartOptions, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Start a process with inline options (no config file).
 */
export function startProcess(options: PM2StartOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const pm2Options: StartOptions = {
      name: options.name,
      namespace: options.namespace,
      script: options.script,
      interpreter: options.interpreter,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      filter_env: options.filterEnv,
      output: options.output,
      error: options.error,
      log_date_format: options.logDateFormat,
      merge_logs: options.mergeLogs,
      autorestart: options.autorestart,
      max_restarts: options.maxRestarts,
      min_uptime: options.minUptime ? parseMinUptime(options.minUptime) : undefined,
    };

    pm2.start(pm2Options, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Stop a process by name. Process remains in PM2 list but is not running.
 */
export function stopProcess(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.stop(name, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Restart a process by name.
 */
export function restartProcess(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.restart(name, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Delete a process from PM2. Stops it if running and removes from PM2 list.
 */
export function deleteProcess(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.delete(name, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Flush (clear) logs for a process.
 */
export function flushProcessLogs(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.flush(name, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Send a signal to a process.
 */
export function sendSignal(signal: string | number, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.sendSignalToProcessName(signal, name, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Wait for a process to reach a specific status.
 * Polls at the specified interval until status matches or timeout is reached.
 */
export async function waitForStatus(
  name: string,
  targetStatus: "online" | "stopped" | "errored",
  timeoutMs: number = 10000,
  pollIntervalMs: number = 250,
): Promise<PM2ProcessDescription | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const proc = await getProcessByName(name);
    const status = proc?.pm2_env?.status;
    if (status === targetStatus) {
      return proc;
    }
    if (targetStatus === "online" && proc && (status === "errored" || status === "stopped")) {
      return proc;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return null;
}

/**
 * Get the PM2 home directory (where logs are stored by default).
 */
export function getPM2Home(): string {
  return process.env.PM2_HOME ?? `${process.env.HOME}/.pm2`;
}

export interface PM2RuntimeInfo {
  name: string;
  pid: number | null;
  status: string;
  port: number | null;
  uptime: number | null;
  restarts: number;
  memory: number | null;
  cpu: number | null;
}

/**
 * Extract runtime info from a PM2 process description.
 * Useful for getting the actual port an app is running on.
 */
export function extractRuntimeInfo(proc: PM2ProcessDescription): PM2RuntimeInfo {
  const pm2Env = proc.pm2_env as Record<string, unknown> | undefined;

  // Extract PORT from environment
  let port: number | null = null;
  const portValue = pm2Env?.PORT;
  if (typeof portValue === "string") {
    const parsed = parseInt(portValue, 10);
    port = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } else if (typeof portValue === "number" && Number.isFinite(portValue) && portValue > 0) {
    port = portValue;
  }

  // Calculate uptime
  const pmUptime = pm2Env?.pm_uptime;
  let uptime: number | null = null;
  if (typeof pmUptime === "number" && pmUptime > 0) {
    uptime = Date.now() - pmUptime;
  }

  return {
    name: proc.name ?? "unknown",
    pid: proc.pid ?? null,
    status: (pm2Env?.status as string) ?? "unknown",
    port,
    uptime,
    restarts: (pm2Env?.restart_time as number) ?? 0,
    memory: proc.monit?.memory ?? null,
    cpu: proc.monit?.cpu ?? null,
  };
}

/**
 * Get runtime info for a process by name.
 * Returns null if the process doesn't exist.
 */
export async function getProcessRuntimeInfo(name: string): Promise<PM2RuntimeInfo | null> {
  const proc = await getProcessByName(name);
  if (!proc) {
    return null;
  }
  return extractRuntimeInfo(proc);
}
