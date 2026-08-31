import { decryptSettingValue, encryptSettingValue, isEncryptedSettingValue } from "../storage/setting-value-crypto";

export type AppEnvironmentVariables = Record<string, string>;

export interface RedactedAppEnvEntry {
  key: string;
  hasValue: boolean;
}

export interface AppEnvEntryInput {
  key?: unknown;
  value?: unknown;
  retain?: unknown;
}

const APP_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_APP_ENV_KEYS = new Set([
  "APP_ID",
  "APP_LABEL",
  "PORT",
  "USER_ALIAS",
  "WINGMAN_PROCESS_KIND",
]);

/** Raw signing credentials are never app configuration.  They belong to the
 * local signing broker and must not be hydrated from, or serialized into, the
 * registry. */
export const FORBIDDEN_APP_SIGNING_ENV_KEYS = new Set([
  "AGENT_NSEC",
  "WAPP_TOWER_DB_CAPABILITY",
  "WAPP_NSEC",
  "WINGMAN_NSEC",
  "WINGMAN_PRIV",
  "NOSTR_SECRET_KEY",
  "BUNKER_URI",
  "NOSTR_CONNECT_URI",
]);

export function removeForbiddenAppSigningEnv(input: unknown): {
  env: AppEnvironmentVariables;
  removedKeys: string[];
} {
  const env = normaliseAppEnvRecord(input);
  const removedKeys: string[] = [];
  for (const key of Object.keys(env)) {
    if (!FORBIDDEN_APP_SIGNING_ENV_KEYS.has(key.toUpperCase())) continue;
    delete env[key];
    removedKeys.push(key);
  }
  return { env: sortAppEnv(env), removedKeys: removedKeys.sort() };
}

export function normaliseAppEnvKey(input: unknown): string {
  if (typeof input !== "string") {
    throw new Error("Environment variable keys must be strings");
  }
  const key = input.trim();
  if (!APP_ENV_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid environment variable key: ${key || "(blank)"}`);
  }
  if (RESERVED_APP_ENV_KEYS.has(key)) {
    throw new Error(`Environment variable key is managed by Wingman: ${key}`);
  }
  return key;
}

export function normaliseAppEnvRecord(input: unknown): AppEnvironmentVariables {
  if (input === undefined || input === null) {
    return {};
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("App environment variables must be an object");
  }
  const env: AppEnvironmentVariables = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = normaliseAppEnvKey(rawKey);
    if (rawValue === null || rawValue === undefined) continue;
    env[key] = typeof rawValue === "string" ? rawValue : String(rawValue);
  }
  return sortAppEnv(env);
}

export function parseAppEnvInput(
  input: unknown,
  existingEnv: AppEnvironmentVariables = {},
): AppEnvironmentVariables | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input === null) {
    return {};
  }
  if (!Array.isArray(input)) {
    return normaliseAppEnvRecord(input);
  }

  const env: AppEnvironmentVariables = {};
  const seenKeys = new Set<string>();
  for (const entry of input) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("App environment entries must be objects");
    }
    const record = entry as AppEnvEntryInput;
    const key = normaliseAppEnvKey(record.key);
    if (seenKeys.has(key)) {
      throw new Error(`Duplicate environment variable key: ${key}`);
    }
    seenKeys.add(key);

    if (record.retain === true) {
      if (!(key in existingEnv)) {
        throw new Error(`Cannot retain missing environment variable: ${key}`);
      }
      env[key] = existingEnv[key]!;
      continue;
    }

    if (record.value === undefined || record.value === null) {
      env[key] = "";
      continue;
    }
    env[key] = typeof record.value === "string" ? record.value : String(record.value);
  }
  return sortAppEnv(env);
}

export function hydrateAppEnv(input: unknown): AppEnvironmentVariables {
  const env = removeForbiddenAppSigningEnv(input).env;
  const hydrated: AppEnvironmentVariables = {};
  for (const [key, value] of Object.entries(env)) {
    hydrated[key] = isEncryptedSettingValue(value) ? decryptSettingValue(value) : value;
  }
  return sortAppEnv(hydrated);
}

export function serialiseAppEnvForStorage(env: AppEnvironmentVariables | undefined): AppEnvironmentVariables | undefined {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) {
    return undefined;
  }
  const stored: AppEnvironmentVariables = {};
  for (const [key, value] of entries) {
    if (FORBIDDEN_APP_SIGNING_ENV_KEYS.has(key.toUpperCase())) continue;
    stored[normaliseAppEnvKey(key)] = isEncryptedSettingValue(value) ? value : encryptSettingValue(value);
  }
  return sortAppEnv(stored);
}

export function redactAppEnv(env: AppEnvironmentVariables | undefined): RedactedAppEnvEntry[] {
  return Object.keys(env ?? {})
    .sort((left, right) => left.localeCompare(right))
    .map((key) => ({ key, hasValue: true }));
}

function sortAppEnv(env: AppEnvironmentVariables): AppEnvironmentVariables {
  const sorted: AppEnvironmentVariables = {};
  for (const key of Object.keys(env).sort((left, right) => left.localeCompare(right))) {
    sorted[key] = env[key]!;
  }
  return sorted;
}
