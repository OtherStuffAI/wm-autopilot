import type { AppRecord } from "./app-registry";
import type { AppCommand } from "./app-command";

const RUNTIME_HOST_KEYS = ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "TMP", "TEMP"] as const;
const FORBIDDEN_RAW_CAPABILITY_KEYS = new Set([
  "AGENT_NSEC",
  "WINGMAN_NSEC",
  "WINGMAN_PRIV",
  "NOSTR_SECRET_KEY",
  "WAPP_NSEC",
  "NWC",
  "NWC_URI",
  "NOSTR_WALLET_CONNECT",
  "BUNKER_URI",
  "NOSTR_CONNECT_URI",
]);

function assignSafeAppEnvironment(target: Record<string, string>, source: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (!FORBIDDEN_RAW_CAPABILITY_KEYS.has(key.toUpperCase())) target[key] = value;
  }
}

export interface ManagedAppEnvironmentInput {
  app: Pick<AppRecord, "id" | "label" | "env" | "webAppPort">;
  userAlias: string;
  hostEnv?: Record<string, string | undefined>;
  wappEnv?: Record<string, string>;
}

export function buildManagedAppEnvironment(input: ManagedAppEnvironmentInput): Record<string, string> {
  const hostEnv = input.hostEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const key of RUNTIME_HOST_KEYS) {
    const value = hostEnv[key];
    if (value) env[key] = value;
  }
  assignSafeAppEnvironment(env, input.app.env);
  assignSafeAppEnvironment(env, input.wappEnv);
  env.WINGMAN_PROCESS_KIND = "user-app";
  env.APP_ID = input.app.id;
  env.APP_LABEL = input.app.label;
  env.USER_ALIAS = input.userAlias;
  if (input.app.webAppPort) env.PORT = String(input.app.webAppPort);
  return env;
}

export function buildManagedAppSpawnPlan(input: ManagedAppEnvironmentInput & {
  command: AppCommand;
  cwd: string;
}): { cmd: string[]; cwd: string; env: Record<string, string> } {
  return {
    cmd: [input.command.executable, ...input.command.args],
    cwd: input.cwd,
    env: buildManagedAppEnvironment(input),
  };
}
