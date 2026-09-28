import { CaproverClient, type CaproverTargetClient } from "./caprover-client";

type CaproverEnv = Record<string, string | undefined>;

const DEFAULT_CAPROVER_TARGET_NAME = "primary";
const SECONDARY_CAPROVER_TARGET_NAME = "secondary";

function normaliseTargetName(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function targetEnvPrefix(targetName: string): string {
  return targetName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function readEnvString(env: CaproverEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function readTargetServerUrl(env: CaproverEnv, targetName: string): string | null {
  if (targetName === DEFAULT_CAPROVER_TARGET_NAME) {
    return readEnvString(env, "CAPROVER_URL") ?? readEnvString(env, "CAPROVER_PRIMARY_URL");
  }

  const prefix = targetEnvPrefix(targetName);
  return readEnvString(env, `CAPROVER_${prefix}_URL`);
}

function readTargetPassword(env: CaproverEnv, targetName: string): string | null {
  if (targetName === DEFAULT_CAPROVER_TARGET_NAME) {
    return (
      readEnvString(env, "LOGIN_CODE") ??
      readEnvString(env, "CAPROVER_LOGIN_CODE") ??
      readEnvString(env, "CAPROVER_PASSWORD") ??
      readEnvString(env, "CAPROVER_PRIMARY_LOGIN_CODE") ??
      readEnvString(env, "CAPROVER_PRIMARY_PASSWORD")
    );
  }

  const prefix = targetEnvPrefix(targetName);
  return (
    readEnvString(env, `CAPROVER_${prefix}_LOGIN_CODE`) ??
    readEnvString(env, `CAPROVER_${prefix}_PASSWORD`)
  );
}

function readConfiguredTargetNames(env: CaproverEnv): string[] {
  const configuredNames = readEnvString(env, "CAPROVER_TARGETS")
    ?.split(",")
    .map((name) => normaliseTargetName(name))
    .filter((name): name is string => Boolean(name)) ?? [];

  const names = configuredNames.length > 0 ? configuredNames : [DEFAULT_CAPROVER_TARGET_NAME];
  if (
    configuredNames.length === 0 &&
    readTargetServerUrl(env, SECONDARY_CAPROVER_TARGET_NAME) &&
    readTargetPassword(env, SECONDARY_CAPROVER_TARGET_NAME)
  ) {
    names.push(SECONDARY_CAPROVER_TARGET_NAME);
  }

  return [...new Set(names)];
}

/**
 * Create a CapRover client from environment variables.
 * Requires CAPROVER_URL and LOGIN_CODE to be set.
 */
export function createCaproverClientFromEnv(): CaproverClient | null {
  const target = createCaproverTargetClientsFromEnv()[0];
  return target?.client ?? null;
}

export function createCaproverTargetClientsFromEnv(
  env: CaproverEnv = process.env,
  policy: { timeoutMs?: number; rejectRedirects?: boolean } = {},
): CaproverTargetClient[] {
  const targets: CaproverTargetClient[] = [];

  for (const name of readConfiguredTargetNames(env)) {
    const serverUrl = readTargetServerUrl(env, name);
    const password = readTargetPassword(env, name);
    if (!serverUrl || !password) {
      continue;
    }

    targets.push({
      name,
      serverUrl,
      client: new CaproverClient({ serverUrl, password }, policy),
    });
  }

  return targets;
}
