import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { basename, join, resolve as resolvePath } from "node:path";

import { generateIdentityAlias } from "../identity/identity-alias";
import { getConfiguredAdminNpubs, isNpubInList, normaliseNpub } from "../identity/npub-utils";
import { writeServerLog } from "../logging/server-logger";
import { identityUserStore } from "../storage/identity-user-store";
import { isPortAvailable } from "../utils/port-utils";
import { appAliasRegistry } from "./app-alias-registry";
import { appDomainRegistry } from "./app-domain-registry";
import { hydrateAppEnv, removeForbiddenAppSigningEnv, type AppEnvironmentVariables } from "./app-env";
import { migrateLegacyAppCommand, validateAppCommand, type AppCommand } from "./app-command";
import { AppRegistryStore } from "./app-registry-store";

const legacyRegistryFilePath = new URL("../../data/apps.json", import.meta.url).pathname;
const registryDatabasePath = new URL("../../data/app-registry.sqlite", import.meta.url).pathname;
const registrySecretDatabasePath = new URL("../../data/app-registry-secrets.sqlite", import.meta.url).pathname;

export type AppLifecycleAction = "start" | "stop" | "restart" | "setup" | "build";

export type AppLifecycleScripts = Partial<Record<AppLifecycleAction, AppCommand>>;

export interface AppRecord {
  id: string;
  label: string;
  root: string;
  scripts: AppLifecycleScripts;
  /** @deprecated Use pm2Name instead. Kept for backward compatibility. */
  tmuxSession: string;
  /** PM2 process name for this app. */
  pm2Name?: string;
  /** Directory where PM2 logs are stored. */
  logsDir?: string;
  notes?: string;
  ownerNpub: string | null;
  autoStart?: boolean;
  env?: AppEnvironmentVariables;
  createdAt: string;
  updatedAt: string;
  webApp: boolean;
  webAppPort: number | null;
  lifecycleReviewRequired?: boolean;
  lifecycleReviewReasons?: string[];
  legacyScripts?: Partial<Record<AppLifecycleAction, string>>;
}

export interface RegisterAppInput {
  id?: string;
  label: string;
  root: string;
  scripts?: AppLifecycleScripts;
  /** @deprecated */
  tmuxSession?: string;
  pm2Name?: string;
  logsDir?: string;
  notes?: string;
  ownerNpub?: string | null;
  autoStart?: boolean;
  env?: AppEnvironmentVariables;
  webApp?: boolean;
  webAppPort?: number | null;
}

export interface UpdateAppInput {
  label?: string;
  root?: string;
  scripts?: AppLifecycleScripts;
  /** @deprecated */
  tmuxSession?: string;
  pm2Name?: string;
  logsDir?: string;
  notes?: string | null;
  ownerNpub?: string | null;
  autoStart?: boolean;
  env?: AppEnvironmentVariables;
  webApp?: boolean;
  webAppPort?: number | null;
}

export interface AppRegistryState {
  apps: AppRecord[];
}

export interface AppRegistryMigrationReport {
  migratedAppIds: string[];
  reviewRequiredAppIds: string[];
  disabledAutoStartAppIds: string[];
  removedSigningSecretAppIds: string[];
}

const ensureAbsolutePath = (input: string): string => {
  if (!input) {
    throw new Error("App root path is required");
  }
  return resolvePath(input);
};

const MAX_TMUX_NAME_LENGTH = 48;

const sanitiseWindowName = (input: string | undefined | null): string => {
  if (!input) return "";
  return input
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
};

const deriveOwnerAlias = (ownerNpub: string | null): string | null => {
  if (!ownerNpub) {
    return null;
  }
  return sanitiseWindowName(generateIdentityAlias(ownerNpub));
};

const normaliseWindowName = (
  value: string | undefined,
  label: string,
  root: string,
  id: string,
  ownerAlias: string | null,
): string => {
  const provided = sanitiseWindowName(value);
  if (provided) {
    return provided.slice(0, MAX_TMUX_NAME_LENGTH);
  }

  const baseLabel = sanitiseWindowName(label) || sanitiseWindowName(basename(root));
  const alias = ownerAlias ? ownerAlias.slice(0, MAX_TMUX_NAME_LENGTH) : "";
  const components = [alias, baseLabel].filter((part) => part.length > 0);
  if (components.length > 0) {
    const combined = components.join("--");
    const trimmed = sanitiseWindowName(combined).slice(0, MAX_TMUX_NAME_LENGTH);
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  const fallbackBase = `app-${id.slice(0, 8)}`;
  const fallback = alias ? `${alias}--${fallbackBase}` : fallbackBase;
  const sanitisedFallback = sanitiseWindowName(fallback).slice(0, MAX_TMUX_NAME_LENGTH);
  return sanitisedFallback.length > 0 ? sanitisedFallback : fallbackBase.slice(0, MAX_TMUX_NAME_LENGTH);
};

export class AppRegistry {
  private readonly legacyFilePath: string;
  private readonly databasePath: string;
  private readonly secretDatabasePath: string;
  private readonly beforeStoreVerification?: () => void;
  private storeInstance: AppRegistryStore | null = null;
  private loaded = false;
  private apps = new Map<string, AppRecord>();
  private writeLock: Promise<void> = Promise.resolve();
  private migrationReport: AppRegistryMigrationReport = {
    migratedAppIds: [],
    reviewRequiredAppIds: [],
    disabledAutoStartAppIds: [],
    removedSigningSecretAppIds: [],
  };

  constructor(
    legacyFilePath: string = legacyRegistryFilePath,
    databasePath: string = legacyFilePath === legacyRegistryFilePath ? registryDatabasePath : `${legacyFilePath}.sqlite`,
    secretDatabasePath: string = legacyFilePath === legacyRegistryFilePath ? registrySecretDatabasePath : `${legacyFilePath}.secrets.sqlite`,
    beforeStoreVerification?: () => void,
  ) {
    this.legacyFilePath = legacyFilePath;
    this.databasePath = databasePath;
    this.secretDatabasePath = secretDatabasePath;
    this.beforeStoreVerification = beforeStoreVerification;
  }

  private get store(): AppRegistryStore {
    this.storeInstance ??= new AppRegistryStore(this.databasePath, this.secretDatabasePath, this.beforeStoreVerification);
    return this.storeInstance;
  }

  async listApps(): Promise<AppRecord[]> {
    await this.ensureLoaded();
    return Array.from(this.apps.values()).sort((a, b) => a.label.localeCompare(b.label));
  }

  async getApp(id: string): Promise<AppRecord | undefined> {
    await this.ensureLoaded();
    return this.apps.get(id);
  }

  async getMigrationReport(): Promise<AppRegistryMigrationReport> {
    await this.ensureLoaded();
    return structuredClone(this.migrationReport);
  }

  /** Explicit operator cutover: removes the verified legacy source and arms
   * the reappearance tripwire. Runtime code never recreates this file. */
  async retireLegacyRegistry(): Promise<void> {
    await this.ensureLoaded();
    const migration = this.store.migration();
    if (!migration) throw new Error("Legacy registry has not been migrated and cannot be retired");
    if (existsSync(this.legacyFilePath)) await unlink(this.legacyFilePath);
    this.store.markLegacyRetired();
  }

  async registerApp(input: RegisterAppInput): Promise<AppRecord> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const root = ensureAbsolutePath(input.root);
    const id = input.id?.trim() || randomUUID();
    if (this.apps.has(id)) {
      throw new Error(`App with id "${id}" already exists`);
    }
    const existingWithRoot = Array.from(this.apps.values()).find((app) => app.root === root);
    if (existingWithRoot) {
      throw new Error(`An app is already registered for root "${root}"`);
    }
    const label = input.label?.trim() || basename(root);
    const ownerNpub = normaliseNpub(input.ownerNpub ?? null);
    const ownerAlias = deriveOwnerAlias(ownerNpub);
    const tmuxSession = normaliseWindowName(input.tmuxSession, label, root, id, ownerAlias);
    const scripts = this.normaliseScripts(input.scripts);
    const webAppEnabled = Boolean(input.webApp);
    const preferredPort =
      typeof input.webAppPort === "number" && Number.isFinite(input.webAppPort)
        ? Math.trunc(input.webAppPort)
        : null;
    let webAppPort: number | null = null;
    if (webAppEnabled) {
      if (!ownerNpub) {
        throw new Error("Unable to assign a web app port without a registered owner.");
      }
      webAppPort = this.assignWebAppPort(ownerNpub, id, preferredPort);
    }
    const record: AppRecord = {
      id,
      label,
      root,
      scripts,
      tmuxSession,
      pm2Name: input.pm2Name,
      logsDir: input.logsDir,
      notes: input.notes?.trim() || undefined,
      ownerNpub,
      autoStart: Boolean(input.autoStart),
      env: removeForbiddenAppSigningEnv(input.env).env,
      createdAt: now,
      updatedAt: now,
      webApp: webAppEnabled,
      webAppPort,
      lifecycleReviewRequired: !isNpubInList(ownerNpub, getConfiguredAdminNpubs()),
      lifecycleReviewReasons: isNpubInList(ownerNpub, getConfiguredAdminNpubs())
        ? []
        : ["app-owner-is-not-a-configured-admin"],
    };
    this.apps.set(record.id, record);
    await this.persist();

    // Register subdomain alias for routing
    if (ownerNpub) {
      await appAliasRegistry.registerAlias(record.id, ownerNpub, root);
    }

    return record;
  }

  async updateApp(id: string, input: UpdateAppInput): Promise<AppRecord> {
    await this.ensureLoaded();
    const existing = this.apps.get(id);
    if (!existing) {
      throw new Error(`Unknown app: ${id}`);
    }
    const nextLabel = input.label?.trim() || existing.label;
    const nextRoot = input.root ? ensureAbsolutePath(input.root) : existing.root;
    const nextScripts = input.scripts ? this.normaliseScripts(input.scripts) : existing.scripts;
    const nextNotes = input.notes === null ? undefined : input.notes?.trim() || existing.notes;
    const nextOwnerNpub =
      input.ownerNpub !== undefined ? normaliseNpub(input.ownerNpub ?? null) ?? null : existing.ownerNpub;
    const nextOwnerAlias = deriveOwnerAlias(nextOwnerNpub);
    const nextTmux = normaliseWindowName(
      input.tmuxSession ?? existing.tmuxSession,
      nextLabel,
      nextRoot,
      id,
      nextOwnerAlias,
    );
    const nextWebApp = input.webApp !== undefined ? Boolean(input.webApp) : existing.webApp;
    const requestedPort =
      typeof input.webAppPort === "number" && Number.isFinite(input.webAppPort)
        ? Math.trunc(input.webAppPort)
        : undefined;
    let nextWebAppPort: number | null = existing.webAppPort;
    if (!nextWebApp) {
      nextWebAppPort = null;
    } else {
      if (!nextOwnerNpub) {
        throw new Error("Unable to assign a web app port without a registered owner.");
      }
      const ownerChanged = nextOwnerNpub !== existing.ownerNpub;
      const webAppEnabled = !existing.webApp;
      const missingAssignedPort = typeof existing.webAppPort !== "number";
      const requestedPortChanged = requestedPort !== undefined && requestedPort !== existing.webAppPort;
      if (webAppEnabled || ownerChanged || missingAssignedPort || requestedPortChanged) {
        const preferred = requestedPort ?? existing.webAppPort ?? undefined;
        nextWebAppPort = this.assignWebAppPort(nextOwnerNpub, id, preferred);
      }
    }
    const next: AppRecord = {
      ...existing,
      label: nextLabel,
      root: nextRoot,
      scripts: nextScripts,
      tmuxSession: nextTmux,
      pm2Name: input.pm2Name !== undefined ? input.pm2Name : existing.pm2Name,
      logsDir: input.logsDir !== undefined ? input.logsDir : existing.logsDir,
      notes: nextNotes,
      ownerNpub: nextOwnerNpub,
      autoStart: input.autoStart !== undefined ? Boolean(input.autoStart) : existing.autoStart,
      env: input.env !== undefined ? removeForbiddenAppSigningEnv(input.env).env : existing.env,
      updatedAt: new Date().toISOString(),
      webApp: nextWebApp,
      webAppPort: nextWebAppPort,
      lifecycleReviewRequired: input.scripts
        ? !isNpubInList(nextOwnerNpub, getConfiguredAdminNpubs())
        : existing.lifecycleReviewRequired,
      lifecycleReviewReasons: input.scripts
        ? (isNpubInList(nextOwnerNpub, getConfiguredAdminNpubs()) ? [] : ["app-owner-is-not-a-configured-admin"])
        : existing.lifecycleReviewReasons,
      legacyScripts: input.scripts ? undefined : existing.legacyScripts,
    };
    if (next.root !== existing.root) {
      const conflict = Array.from(this.apps.values()).find((app) => app.id !== id && app.root === next.root);
      if (conflict) {
        throw new Error(`Another app is already registered for root "${next.root}"`);
      }
    }
    this.apps.set(id, next);
    await this.persist();

    // Update subdomain alias if owner or root changed
    if (next.ownerNpub) {
      await appAliasRegistry.registerAlias(id, next.ownerNpub, next.root);
    } else {
      // No owner, remove alias
      await appAliasRegistry.removeAlias(id);
    }

    return next;
  }

  async reassignAppId(currentId: string, nextId: string): Promise<AppRecord> {
    await this.ensureLoaded();
    const existing = this.apps.get(currentId);
    if (!existing) {
      throw new Error(`Unknown app: ${currentId}`);
    }
    if (currentId === nextId) {
      return existing;
    }
    if (this.apps.has(nextId)) {
      throw new Error(`App with id "${nextId}" already exists`);
    }

    const next: AppRecord = {
      ...existing,
      id: nextId,
      updatedAt: new Date().toISOString(),
    };

    this.apps.delete(currentId);
    this.apps.set(nextId, next);
    await this.persist();

    await appAliasRegistry.removeAlias(currentId);
    if (next.ownerNpub) {
      await appAliasRegistry.registerAlias(nextId, next.ownerNpub, next.root);
    }

    return next;
  }

  async removeApp(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = this.apps.delete(id);
    if (existed) {
      await this.persist();
      await appAliasRegistry.removeAlias(id);
      await appDomainRegistry.removeByAppId(id);
    }
    return existed;
  }

  /**
   * Get the subdomain alias for an app.
   */
  async getAppAlias(id: string): Promise<string | null> {
    const record = await appAliasRegistry.getByAppId(id);
    return record?.alias ?? null;
  }

  async discoverScripts(root: string): Promise<AppLifecycleScripts> {
    const absolute = ensureAbsolutePath(root);
    try {
      const packagePath = join(absolute, "package.json");
      const contents = await readFile(packagePath, "utf8");
      const parsed = JSON.parse(contents) as { scripts?: Record<string, string> };
      const scripts: AppLifecycleScripts = {};
      if (parsed.scripts) {
        const candidates: AppLifecycleAction[] = ["start", "stop", "restart", "setup", "build"];
        for (const action of candidates) {
          const command = parsed.scripts[action];
          if (typeof command === "string" && command.trim().length > 0) {
            scripts[action] = { executable: "bun", args: ["run", action] };
          }
        }
      }
      return scripts;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  private async ensureLoaded() {
    if (this.loaded) {
      return;
    }
    const migration = this.store.migration();
    if (migration?.legacyRetiredAt && existsSync(this.legacyFilePath)) {
      throw new Error(`SECURITY: retired legacy app registry reappeared at ${this.legacyFilePath}`);
    }
    if (migration) {
      this.apps = new Map(this.store.load().map((app) => [app.id, app]));
      this.loaded = true;
      return;
    }
    try {
      const stats = await stat(this.legacyFilePath);
      if (!stats.isFile()) throw new Error(`Legacy app registry is not a regular file: ${this.legacyFilePath}`);
      const raw = await readFile(this.legacyFilePath, "utf8");
      const parsed = JSON.parse(raw) as AppRegistryState | AppRecord[];
      const records: (Partial<AppRecord> & { id: string; root: string })[] = Array.isArray(parsed)
        ? parsed
        : parsed.apps ?? [];
      this.apps = new Map(records.map((record) => {
        const { app: hydrated, migrated, disabledAutoStart } = this.hydrateRecord(record);
        if (migrated) {
          this.migrationReport.migratedAppIds.push(hydrated.id);
        }
        if (hydrated.lifecycleReviewRequired) this.migrationReport.reviewRequiredAppIds.push(hydrated.id);
        if (disabledAutoStart) this.migrationReport.disabledAutoStartAppIds.push(hydrated.id);
        return [hydrated.id, hydrated] as const;
      }));
      const sourceFingerprint = createHash("sha256").update(raw).digest("hex");
      this.store.replaceAll(Array.from(this.apps.values()), { sourceFingerprint });
      const verified = this.store.load();
      if (verified.length !== this.apps.size || verified.some((record) => {
        const expected = this.apps.get(record.id);
        return !expected || expected.root !== record.root || expected.label !== record.label
          || expected.ownerNpub !== record.ownerNpub || expected.webAppPort !== record.webAppPort;
      })) {
        throw new Error("App registry migration verification failed; legacy source was not retired");
      }
      if (this.migrationReport.migratedAppIds.length > 0 || this.migrationReport.reviewRequiredAppIds.length > 0) {
        writeServerLog("WARN", "[apps-migration] lifecycle registry migration", this.migrationReport);
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        this.apps.clear();
        this.store.replaceAll([], { sourceFingerprint: "fresh-install" });
      } else {
        throw error;
      }
    }
    this.loaded = true;
  }

  private async persist() {
    const writeOperation = async () => {
      this.store.replaceAll(Array.from(this.apps.values()));
    };
    this.writeLock = this.writeLock.then(writeOperation, writeOperation);
    await this.writeLock;
  }

  private normaliseScripts(input?: AppLifecycleScripts): AppLifecycleScripts {
    if (!input) return {};
    const scripts: AppLifecycleScripts = {};
    for (const [key, value] of Object.entries(input)) {
      if (!value) continue;
      const action = key as AppLifecycleAction;
      scripts[action] = validateAppCommand(value);
    }
    return scripts;
  }

  private assignWebAppPort(ownerNpub: string, appId: string | null, preferred?: number | null): number {
    const normalizedOwner = normaliseNpub(ownerNpub ?? null);
    if (!normalizedOwner) {
      throw new Error("Web apps require an owner with a valid npub");
    }
    const ports = identityUserStore.ensurePortsFor(normalizedOwner);
    if (!ports || ports.length === 0) {
      throw new Error("No reserved ports are available for this owner.");
    }

    // Build set of ports assigned to other apps for this user
    const assignedToApps = new Set<number>();
    for (const app of this.apps.values()) {
      if (app.id === appId) continue;
      if (app.ownerNpub === normalizedOwner && app.webApp && typeof app.webAppPort === "number") {
        assignedToApps.add(app.webAppPort);
      }
    }

    // Check if a port is available (not assigned to another app AND not in use on system)
    const isAvailable = (port: number): boolean => {
      if (assignedToApps.has(port)) {
        return false;
      }
      if (!isPortAvailable(port)) {
        console.warn(`[app-registry] port ${port} is in use on system, skipping`);
        return false;
      }
      return true;
    };

    // Try preferred port first
    if (typeof preferred === "number" && Number.isFinite(preferred)) {
      const intValue = Math.trunc(preferred);
      if (ports.includes(intValue) && isAvailable(intValue)) {
        return intValue;
      }
    }

    // Find first available port from reserved range
    const available = ports.find(isAvailable);
    if (available === undefined) {
      throw new Error("All reserved ports are either assigned to other apps or in use on the system.");
    }
    return available;
  }

  private hydrateRecord(input: Partial<AppRecord> & { id: string; root: string }): {
    app: AppRecord;
    migrated: boolean;
    disabledAutoStart: boolean;
  } {
    const now = new Date().toISOString();
    const root = ensureAbsolutePath(input.root);
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? createdAt;
    const label = input.label?.trim() || basename(root);
    const ownerNpub = normaliseNpub(input.ownerNpub ?? null);
    const ownerAlias = deriveOwnerAlias(ownerNpub);
    const tmuxSession = normaliseWindowName(input.tmuxSession, label, root, input.id, ownerAlias);
    const scripts: AppLifecycleScripts = {};
    const legacyScripts: Partial<Record<AppLifecycleAction, string>> = { ...(input.legacyScripts ?? {}) };
    const reasons = new Set(input.lifecycleReviewReasons ?? []);
    let migrated = false;
    for (const [key, value] of Object.entries(input.scripts ?? {})) {
      const action = key as AppLifecycleAction;
      if (typeof value === "string") {
        migrated = true;
        const migratedCommand = migrateLegacyAppCommand(value);
        if (migratedCommand) scripts[action] = migratedCommand;
        else {
          legacyScripts[action] = value;
          reasons.add(`legacy-${action}-command-requires-admin-review`);
        }
        continue;
      }
      try {
        scripts[action] = validateAppCommand(value);
      } catch {
        reasons.add(`invalid-${action}-command-requires-admin-review`);
      }
    }
    const notes = input.notes?.trim() || undefined;
    const ownerIsAdmin = isNpubInList(ownerNpub, getConfiguredAdminNpubs());
    if (!ownerIsAdmin) reasons.add("app-owner-is-not-a-configured-admin");
    const lifecycleReviewRequired = Boolean(input.lifecycleReviewRequired) || reasons.size > 0;
    const disabledAutoStart = Boolean(input.autoStart) && lifecycleReviewRequired;
    const autoStart = disabledAutoStart ? false : Boolean(input.autoStart);
    if (disabledAutoStart) migrated = true;
    const signingEnvMigration = removeForbiddenAppSigningEnv(input.env);
    if (signingEnvMigration.removedKeys.length > 0) {
      migrated = true;
      reasons.add("raw-signing-secret-removed-use-capability-broker");
      this.migrationReport.removedSigningSecretAppIds.push(input.id);
    }
    const env = hydrateAppEnv(signingEnvMigration.env);
    const webApp = Boolean(input.webApp);
    const storedPort =
      typeof input.webAppPort === "number" && Number.isFinite(input.webAppPort)
        ? Math.trunc(input.webAppPort)
        : null;
    const webAppPort = webApp ? storedPort : null;
    return { app: {
      id: input.id,
      label,
      root,
      scripts,
      tmuxSession,
      pm2Name: input.pm2Name,
      logsDir: input.logsDir,
      notes,
      ownerNpub,
      autoStart,
      env,
      createdAt,
      updatedAt,
      webApp,
      webAppPort,
      lifecycleReviewRequired,
      lifecycleReviewReasons: Array.from(reasons).sort(),
      legacyScripts: Object.keys(legacyScripts).length > 0 ? legacyScripts : undefined,
    }, migrated, disabledAutoStart };
  }

}

export const appRegistry = new AppRegistry();
