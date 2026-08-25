#!/usr/bin/env bun

import { access } from "node:fs/promises";
import { join } from "node:path";

import { buildManagedAppEnvironment } from "./app-runtime-env";
import { validateAppCommand, type AppCommand } from "./app-command";
import {
  consumeAppRuntimeEnvelope,
  type AppRuntimeEnvelopeReference,
} from "./app-runtime-envelope";

export interface UserAppRunnerInput {
  appId: string;
  appLabel: string;
  appRoot: string;
  startCommand: AppCommand;
  userAlias: string;
  port?: string;
  wappId?: string;
  runtimeEnvEnvelope?: AppRuntimeEnvelopeReference;
}

export interface UserAppRunnerDeps {
  hostEnv?: Record<string, string | undefined>;
  runtimeEnvReader?: (
    reference: AppRuntimeEnvelopeReference,
    appId: string,
  ) => Promise<Record<string, string>>;
  redshiftDetector?: (directory: string) => Promise<boolean>;
  spawn?: typeof Bun.spawn;
}

export interface UserAppSpawnPlan {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
}

interface UserAppChildProcess {
  pid: number;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals | number) => void;
}

interface UserAppSignalSource {
  on: (signal: NodeJS.Signals, listener: () => void) => unknown;
  off: (signal: NodeJS.Signals, listener: () => void) => unknown;
}

export interface UserAppSupervisorDeps {
  signalSource?: UserAppSignalSource;
  platform?: NodeJS.Platform;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals | number) => void;
  forceKillAfterMs?: number;
}

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function terminateUserAppChild(
  child: UserAppChildProcess,
  signal: NodeJS.Signals | number,
  deps: UserAppSupervisorDeps,
): void {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32" && child.pid > 0) {
    try {
      (deps.killProcessGroup ?? process.kill)(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when process-group signalling is unavailable.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child may already have exited between the signal and this call.
  }
}

export async function superviseUserAppChild(
  child: UserAppChildProcess,
  deps: UserAppSupervisorDeps = {},
): Promise<number> {
  const signalSource = deps.signalSource ?? process;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let terminating = false;
  const listeners = new Map<NodeJS.Signals, () => void>();

  for (const signal of FORWARDED_SIGNALS) {
    const listener = () => {
      if (terminating) return;
      terminating = true;
      terminateUserAppChild(child, signal, deps);
      forceKillTimer = setTimeout(() => {
        terminateUserAppChild(child, "SIGKILL", deps);
      }, deps.forceKillAfterMs ?? 1_000);
      forceKillTimer.unref?.();
    };
    listeners.set(signal, listener);
    signalSource.on(signal, listener);
  }

  try {
    return await child.exited;
  } finally {
    if (forceKillTimer) clearTimeout(forceKillTimer);
    for (const [signal, listener] of listeners) {
      signalSource.off(signal, listener);
    }
  }
}

function requireValue(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

function parseRunnerArgs(args: string[]): UserAppRunnerInput {
  const values = new Map<string, string>();
  const commandArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!flag.startsWith("--")) {
      throw new Error(`Unexpected runner argument: ${flag}`);
    }
    const key = flag.slice(2);
    const value = args[index + 1];
    if (value === undefined || (key !== "arg" && value.startsWith("--"))) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (key === "arg") commandArgs.push(value);
    else values.set(key, value);
    index += 1;
  }
  return {
    appId: requireValue(values.get("app-id"), "app-id"),
    appLabel: requireValue(values.get("app-label"), "app-label"),
    appRoot: requireValue(values.get("app-root"), "app-root"),
    startCommand: validateAppCommand({
      executable: requireValue(values.get("executable"), "executable"),
      args: commandArgs,
    }),
    userAlias: requireValue(values.get("user-alias"), "user-alias"),
    port: values.get("port"),
    wappId: values.get("wapp-id"),
    runtimeEnvEnvelope: values.has("runtime-env-path") || values.has("runtime-env-key")
      ? {
          path: requireValue(values.get("runtime-env-path"), "runtime-env-path"),
          key: requireValue(values.get("runtime-env-key"), "runtime-env-key"),
        }
      : undefined,
  };
}

async function hasRedshiftConfig(directory: string): Promise<boolean> {
  try {
    await access(join(directory, "redshift.yaml"));
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return false;
    throw error;
  }
}

export async function buildUserAppSpawnPlan(
  input: UserAppRunnerInput,
  deps: UserAppRunnerDeps = {},
): Promise<UserAppSpawnPlan> {
  const hostEnv = deps.hostEnv ?? process.env;
  const managedEnv = input.runtimeEnvEnvelope
    ? await (deps.runtimeEnvReader ?? consumeAppRuntimeEnvelope)(input.runtimeEnvEnvelope, input.appId)
    : {};

  const env = buildManagedAppEnvironment({
    app: {
      id: input.appId,
      label: input.appLabel,
      env: managedEnv,
      webAppPort: input.port ? Number.parseInt(input.port, 10) : null,
    },
    userAlias: input.userAlias,
    hostEnv,
  });

  const hasRedshift = await (deps.redshiftDetector ?? hasRedshiftConfig)(input.appRoot);
  return {
    cmd: hasRedshift
      ? ["redshift", "run", "--", input.startCommand.executable, ...input.startCommand.args]
      : [input.startCommand.executable, ...input.startCommand.args],
    cwd: input.appRoot,
    env,
  };
}

export async function runUserApp(input: UserAppRunnerInput, deps: UserAppRunnerDeps = {}): Promise<number> {
  const plan = await buildUserAppSpawnPlan(input, deps);
  const spawn = deps.spawn ?? Bun.spawn;
  const child = spawn(plan.cmd, {
    cwd: plan.cwd,
    env: plan.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    detached: process.platform !== "win32",
  });
  return await superviseUserAppChild(child);
}

async function main(): Promise<void> {
  const input = parseRunnerArgs(Bun.argv.slice(2));
  const exitCode = await runUserApp(input);
  process.exit(exitCode);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
