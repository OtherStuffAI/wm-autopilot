#!/usr/bin/env bun

import { access } from "node:fs/promises";
import { join } from "node:path";

import { appRegistry } from "./app-registry";
import { getWappRuntimeEnvForWapp } from "../wapps/runtime-env";
import { wappStore, type WappStore } from "../wapps/wapp-store";
import { buildManagedAppEnvironment } from "./app-runtime-env";
import { validateAppCommand, type AppCommand } from "./app-command";

export interface UserAppRunnerInput {
  appId: string;
  appLabel: string;
  appRoot: string;
  startCommand: AppCommand;
  userAlias: string;
  port?: string;
  wappId?: string;
}

export interface UserAppRunnerDeps {
  store?: WappStore;
  hostEnv?: Record<string, string | undefined>;
  appEnvReader?: (appId: string) => Promise<Record<string, string>>;
  redshiftDetector?: (directory: string) => Promise<boolean>;
  spawn?: typeof Bun.spawn;
}

export interface UserAppSpawnPlan {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
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

async function readManagedAppEnv(appId: string): Promise<Record<string, string>> {
  const app = await appRegistry.getApp(appId);
  if (!app) {
    throw new Error(`Unable to load managed environment for unknown app: ${appId}`);
  }
  return app.env ?? {};
}

export async function buildUserAppSpawnPlan(
  input: UserAppRunnerInput,
  deps: UserAppRunnerDeps = {},
): Promise<UserAppSpawnPlan> {
  const hostEnv = deps.hostEnv ?? process.env;
  const managedEnv = await (deps.appEnvReader ?? readManagedAppEnv)(input.appId);
  const wappEnv: Record<string, string> = {};
  if (input.wappId) {
    Object.assign(
      wappEnv,
      getWappRuntimeEnvForWapp(input.wappId, input.appRoot, deps.store ?? wappStore),
    );
  }

  const env = buildManagedAppEnvironment({
    app: {
      id: input.appId,
      label: input.appLabel,
      env: managedEnv,
      webAppPort: input.port ? Number.parseInt(input.port, 10) : null,
    },
    userAlias: input.userAlias,
    hostEnv,
    wappEnv,
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
  });
  return await child.exited;
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
