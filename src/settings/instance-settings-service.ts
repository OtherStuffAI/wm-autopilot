import { createHash } from "node:crypto";

import {
  INSTANCE_SETTING_DEFINITIONS,
  type InstanceSettingDefinition,
  validateInstanceSettingValue,
} from "./instance-settings-registry";
import {
  type EnvFileSnapshot,
  backupEnvFile,
  cleanupEnvFile,
  inspectEnvFile,
  resolveEnvFilePath,
} from "./env-file";
import {
  type InstanceSettingRecord,
  type InstanceSettingSource,
  type InstanceSettingsStore,
  instanceSettingsStore,
} from "../storage/instance-settings-store";

export interface MaskedInstanceSetting {
  key: string;
  label: string;
  description: string;
  category: string;
  type: string;
  secret: boolean;
  bootstrapOnly: boolean;
  autoImport: boolean;
  requiresRestart: boolean;
  cleanupAllowed: boolean;
  envAliases: string[];
  compatibilityEnvName: string | null;
  configured: boolean;
  source: InstanceSettingSource | null;
  sourceDetail: string | null;
  updatedAt: string | null;
  value: string | null;
  maskedValue: string | null;
  fingerprint: string | null;
  defaultValue: string | null;
  options: string[];
}

export interface EnvImportCandidate {
  key: string;
  label: string;
  category: string;
  secret: boolean;
  bootstrapOnly: boolean;
  autoImport: boolean;
  cleanupAllowed: boolean;
  requiresRestart: boolean;
  envAliases: string[];
  envKeys: string[];
  source: "process" | "file" | "process+file";
  configured: boolean;
  imported: boolean;
  appFingerprint: string | null;
  envFingerprint: string | null;
  maskedEnvValue: string | null;
  conflict: boolean;
  canAutoImport: boolean;
  blockedReason: string | null;
  validationError: string | null;
}

export interface EnvImportPreview {
  settings: MaskedInstanceSetting[];
  candidates: EnvImportCandidate[];
  envFile: EnvFileSnapshot | null;
  cleanupStatus: "cleanupUnavailable" | "cleanupReadOnly" | "cleanupSupported";
}

export interface AutoImportResult {
  imported: Array<{ key: string; envKey: string }>;
  skipped: Array<{ key: string; reason: string }>;
}

export interface ManualImportResult {
  imported: string[];
  skipped: Array<{ key: string; reason: string }>;
}

type EnvLike = Record<string, string | undefined>;

export class InstanceSettingsService {
  constructor(private readonly store: InstanceSettingsStore = instanceSettingsStore) {}

  get(key: string, env: EnvLike = process.env): string | null {
    const definition = INSTANCE_SETTING_DEFINITIONS.find((item) => item.key === key);
    if (!definition) return null;
    if (definition.bootstrapOnly) {
      return readEnvValueForDefinition(definition, env)?.value ?? null;
    }
    const record = this.store.getRecord(key);
    if (record) return record.value;
    return readEnvValueForDefinition(definition, env)?.value ?? null;
  }

  getAppValue(key: string): string | null {
    return this.store.get(key);
  }

  listMaskedSettings(env: EnvLike = process.env): MaskedInstanceSetting[] {
    const records = new Map(this.store.getAllRecords().map((record) => [record.key, record]));
    return INSTANCE_SETTING_DEFINITIONS.map((definition) => {
      const record = definition.bootstrapOnly ? null : records.get(definition.key) ?? null;
      const envValue = readEnvValueForDefinition(definition, env)?.value ?? null;
      const value = record?.value ?? null;
      const displayValue = value ?? (record ? "" : envValue);
      return maskDefinition(definition, record, displayValue);
    });
  }

  async previewEnvImport(env: EnvLike = process.env): Promise<EnvImportPreview> {
    const envFile = await inspectEnvFile(resolveEnvFilePath(env));
    const candidates = this.buildCandidates(env, envFile);
    return {
      settings: this.listMaskedSettings(env),
      candidates,
      envFile,
      cleanupStatus: resolveCleanupStatus(envFile),
    };
  }

  autoImportMissing(env: EnvLike = process.env): AutoImportResult {
    const imported: Array<{ key: string; envKey: string }> = [];
    const skipped: Array<{ key: string; reason: string }> = [];
    for (const definition of INSTANCE_SETTING_DEFINITIONS) {
      const candidate = this.buildCandidate(definition, env, null);
      if (!candidate) continue;
      if (!candidate.canAutoImport) {
        skipped.push({ key: definition.key, reason: candidate.blockedReason ?? "not eligible" });
        continue;
      }
      const envValue = readEnvValueForDefinition(definition, env);
      if (!envValue) continue;
      this.store.set({
        key: definition.key,
        value: envValue.value,
        valueKind: definition.type,
        source: "env_auto_import",
        sourceDetail: envValue.key,
      });
      imported.push({ key: definition.key, envKey: envValue.key });
    }
    return { imported, skipped };
  }

  importFromEnvironment(keys: string[], env: EnvLike = process.env): ManualImportResult {
    const requested = new Set(keys);
    const imported: string[] = [];
    const skipped: Array<{ key: string; reason: string }> = [];
    for (const definition of INSTANCE_SETTING_DEFINITIONS) {
      if (!requested.has(definition.key)) continue;
      if (definition.bootstrapOnly) {
        skipped.push({ key: definition.key, reason: "bootstrap-only setting cannot be imported" });
        continue;
      }
      const envValue = readEnvValueForDefinition(definition, env);
      if (!envValue) {
        skipped.push({ key: definition.key, reason: "env value is missing" });
        continue;
      }
      const validationError = validateInstanceSettingValue(definition, envValue.value);
      if (validationError) {
        skipped.push({ key: definition.key, reason: validationError });
        continue;
      }
      this.store.set({
        key: definition.key,
        value: envValue.value,
        valueKind: definition.type,
        source: "env_manual_import",
        sourceDetail: envValue.key,
      });
      imported.push(definition.key);
    }
    return { imported, skipped };
  }

  set(key: string, value: string): InstanceSettingRecord {
    const definition = INSTANCE_SETTING_DEFINITIONS.find((item) => item.key === key);
    if (!definition) {
      throw new Error("Unknown setting key");
    }
    if (definition.bootstrapOnly) {
      throw new Error("Bootstrap-only settings cannot be saved in app settings");
    }
    const normalizedValue = definition.normalize ? definition.normalize(value) : value;
    const validationError = validateInstanceSettingValue(definition, normalizedValue);
    if (validationError) {
      throw new Error(validationError);
    }
    return this.store.set({
      key: definition.key,
      value: normalizedValue,
      valueKind: definition.type,
      source: "app",
      sourceDetail: null,
    });
  }

  delete(key: string): boolean {
    const definition = INSTANCE_SETTING_DEFINITIONS.find((item) => item.key === key);
    if (!definition) {
      throw new Error("Unknown setting key");
    }
    if (definition.bootstrapOnly) {
      throw new Error("Bootstrap-only settings cannot be deleted from app settings");
    }
    return this.store.delete(key);
  }

  async backupEnvFile(path: string | null = resolveEnvFilePath()): Promise<{ backupPath: string }> {
    if (!path) {
      throw new Error("No env file path configured");
    }
    return { backupPath: await backupEnvFile(path) };
  }

  async cleanupEnvFile(keys: string[], env: EnvLike = process.env) {
    const path = resolveEnvFilePath(env);
    if (!path) {
      throw new Error("No env file path configured");
    }
    const removableKeys = resolveCleanupEnvKeys(keys);
    return cleanupEnvFile(path, removableKeys);
  }

  buildRuntimeEnv(env: EnvLike = process.env): Record<string, string> {
    const output: Record<string, string> = {};
    if (env.WINGMAN_DISABLE_INSTANCE_SETTINGS === "1" || Bun.env.WINGMAN_DISABLE_INSTANCE_SETTINGS === "1") {
      return output;
    }
    if (!env.IDENTITY_SESSION_SECRET?.trim() && !Bun.env.IDENTITY_SESSION_SECRET?.trim()) {
      return output;
    }
    for (const definition of INSTANCE_SETTING_DEFINITIONS) {
      if (!definition.compatibilityEnvName || definition.bootstrapOnly) continue;
      const value = this.get(definition.key, env);
      if (value !== null && value.trim().length > 0) {
        output[definition.compatibilityEnvName] = value;
      }
    }
    return output;
  }

  private buildCandidates(env: EnvLike, envFile: EnvFileSnapshot | null): EnvImportCandidate[] {
    return INSTANCE_SETTING_DEFINITIONS
      .map((definition) => this.buildCandidate(definition, env, envFile))
      .filter((candidate): candidate is EnvImportCandidate => candidate !== null);
  }

  private buildCandidate(
    definition: InstanceSettingDefinition,
    env: EnvLike,
    envFile: EnvFileSnapshot | null,
  ): EnvImportCandidate | null {
    const envSources = collectEnvSources(definition, env, envFile);
    if (envSources.length === 0) return null;
    const uniqueValues = new Set(envSources.map((source) => source.value));
    const record = this.store.getRecord(definition.key);
    const value = envSources[0]?.value ?? "";
    const validationError = uniqueValues.size === 1 ? validateInstanceSettingValue(definition, value) : null;
    const blockedReason = resolveBlockedReason(definition, record, envSources, validationError);
    const sourceKinds = new Set(envSources.map((source) => source.source));
    const source = sourceKinds.size > 1 ? "process+file" : envSources[0]?.source ?? "process";
    const appFingerprint = record ? fingerprintValue(record.value) : null;
    const envFingerprint = uniqueValues.size === 1 ? fingerprintValue(value) : null;
    return {
      key: definition.key,
      label: definition.label,
      category: definition.category,
      secret: Boolean(definition.secret),
      bootstrapOnly: Boolean(definition.bootstrapOnly),
      autoImport: Boolean(definition.autoImport),
      cleanupAllowed: Boolean(definition.cleanupAllowed),
      requiresRestart: definition.requiresRestart !== false,
      envAliases: definition.envAliases,
      envKeys: envSources.map((item) => item.key),
      source,
      configured: Boolean(record),
      imported: record?.source === "env_auto_import" || record?.source === "env_manual_import",
      appFingerprint,
      envFingerprint,
      maskedEnvValue: uniqueValues.size === 1 ? maskValue(value, Boolean(definition.secret)) : "conflicting values",
      conflict: Boolean(record && envFingerprint && appFingerprint !== envFingerprint),
      canAutoImport: blockedReason === null,
      blockedReason,
      validationError,
    };
  }
}

export const instanceSettingsService = new InstanceSettingsService();

export function getManagedSettingValue(key: string, env: EnvLike = process.env): string | null {
  return instanceSettingsService.get(key, env);
}

function readEnvValueForDefinition(
  definition: InstanceSettingDefinition,
  env: EnvLike,
): { key: string; value: string } | null {
  for (const alias of definition.envAliases) {
    const value = env[alias]?.trim();
    if (value) {
      return { key: alias, value };
    }
  }
  return null;
}

function collectEnvSources(
  definition: InstanceSettingDefinition,
  env: EnvLike,
  envFile: EnvFileSnapshot | null,
): Array<{ key: string; value: string; source: "process" | "file" }> {
  const sources: Array<{ key: string; value: string; source: "process" | "file" }> = [];
  for (const alias of definition.envAliases) {
    const processValue = env[alias]?.trim();
    if (processValue) {
      sources.push({ key: alias, value: processValue, source: "process" });
    }
    const fileEntry = envFile?.entries.find((entry) => entry.key === alias);
    if (fileEntry && fileEntry.value.trim()) {
      sources.push({ key: alias, value: fileEntry.value.trim(), source: "file" });
    }
  }
  return sources;
}

function resolveBlockedReason(
  definition: InstanceSettingDefinition,
  record: InstanceSettingRecord | null,
  envSources: Array<{ value: string }>,
  validationError: string | null,
): string | null {
  if (!definition.autoImport) return "setting is not marked for automatic import";
  if (definition.bootstrapOnly) return "bootstrap-only setting";
  if (record) return "app-managed setting already exists";
  if (new Set(envSources.map((source) => source.value)).size > 1) return "conflicting env aliases";
  if (validationError) return validationError;
  return null;
}

function maskDefinition(
  definition: InstanceSettingDefinition,
  record: InstanceSettingRecord | null,
  fallbackValue: string | null,
): MaskedInstanceSetting {
  return {
    key: definition.key,
    label: definition.label,
    description: definition.description,
    category: definition.category,
    type: definition.type,
    secret: Boolean(definition.secret),
    bootstrapOnly: Boolean(definition.bootstrapOnly),
    autoImport: Boolean(definition.autoImport),
    requiresRestart: definition.requiresRestart !== false,
    cleanupAllowed: Boolean(definition.cleanupAllowed),
    envAliases: definition.envAliases,
    compatibilityEnvName: definition.compatibilityEnvName ?? null,
    configured: Boolean(record),
    source: record?.source ?? null,
    sourceDetail: record?.sourceDetail ?? null,
    updatedAt: record?.updatedAt ?? null,
    value: definition.secret ? null : fallbackValue,
    maskedValue: fallbackValue === null ? null : maskValue(fallbackValue, Boolean(definition.secret)),
    fingerprint: fallbackValue === null ? null : fingerprintValue(fallbackValue),
    defaultValue: definition.defaultValue ?? null,
    options: definition.options ? [...definition.options] : [],
  };
}

function maskValue(value: string, secret: boolean): string {
  if (!secret) return value;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}..${value.slice(-4)}`;
}

function fingerprintValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function resolveCleanupStatus(envFile: EnvFileSnapshot | null): EnvImportPreview["cleanupStatus"] {
  if (!envFile || envFile.error === "env file not found") return "cleanupUnavailable";
  return envFile.writable ? "cleanupSupported" : "cleanupReadOnly";
}

function resolveCleanupEnvKeys(settingKeys: string[]): string[] {
  const selected = new Set(settingKeys);
  const keys: string[] = [];
  for (const definition of INSTANCE_SETTING_DEFINITIONS) {
    if (!selected.has(definition.key)) continue;
    if (definition.bootstrapOnly || !definition.cleanupAllowed) {
      throw new Error(`${definition.key} cannot be removed from env`);
    }
    keys.push(...definition.envAliases);
  }
  return keys;
}
