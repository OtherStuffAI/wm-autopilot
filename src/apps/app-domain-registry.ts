import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const registryFilePath = new URL("../../data/app-domains.json", import.meta.url).pathname;

export type AppDomainStatus = "pending_dns" | "active" | "disabled" | "error";

export interface AppDomainRecord {
  hostname: string;
  appId: string;
  status: AppDomainStatus;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  error: string | null;
}

interface AppDomainRegistryState {
  domains: AppDomainRecord[];
}

export interface RegisterAppDomainInput {
  hostname: string;
  appId: string;
  status?: AppDomainStatus;
  error?: string | null;
}

export interface UpdateAppDomainInput {
  status?: AppDomainStatus;
  error?: string | null;
  verified?: boolean;
}

export class AppDomainConflictError extends Error {
  readonly hostname: string;
  readonly existingAppId: string;

  constructor(hostname: string, existingAppId: string) {
    super(`Domain ${hostname} is already registered to app ${existingAppId}`);
    this.name = "AppDomainConflictError";
    this.hostname = hostname;
    this.existingAppId = existingAppId;
  }
}

export function normalizeAppHostname(input: string | null | undefined): string | null {
  if (typeof input !== "string") {
    return null;
  }

  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
  const withoutPath = withoutProtocol.split("/")[0] ?? "";
  const withoutPort = withoutPath.startsWith("[")
    ? withoutPath
    : withoutPath.split(":")[0] ?? "";
  const hostname = withoutPort.replace(/\.$/, "");

  if (!isValidAppHostname(hostname)) {
    return null;
  }

  return hostname;
}

export function isValidAppHostname(hostname: string): boolean {
  if (hostname.length < 1 || hostname.length > 253) {
    return false;
  }
  if (hostname.includes("*") || hostname.includes("_") || hostname.includes("..")) {
    return false;
  }
  if (hostname === "localhost" || /^[0-9.]+$/.test(hostname)) {
    return false;
  }

  const labels = hostname.split(".");
  if (labels.length < 2) {
    return false;
  }

  return labels.every((label) => {
    if (label.length < 1 || label.length > 63) {
      return false;
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return false;
    }
    return /^[a-z0-9-]+$/.test(label);
  });
}

export class AppDomainRegistry {
  private readonly filePath: string;
  private loaded = false;
  private byHostname = new Map<string, AppDomainRecord>();
  private byAppId = new Map<string, Map<string, AppDomainRecord>>();
  private writeLock: Promise<void> = Promise.resolve();

  constructor(filePath: string = registryFilePath) {
    this.filePath = filePath;
  }

  async getByHostname(hostname: string): Promise<AppDomainRecord | undefined> {
    await this.ensureLoaded();
    const normalized = normalizeAppHostname(hostname);
    return normalized ? this.byHostname.get(normalized) : undefined;
  }

  async listDomains(): Promise<AppDomainRecord[]> {
    await this.ensureLoaded();
    return Array.from(this.byHostname.values()).sort((a, b) => a.hostname.localeCompare(b.hostname));
  }

  async listByAppId(appId: string): Promise<AppDomainRecord[]> {
    await this.ensureLoaded();
    return Array.from(this.byAppId.get(appId)?.values() ?? []).sort((a, b) => a.hostname.localeCompare(b.hostname));
  }

  async registerDomain(input: RegisterAppDomainInput): Promise<AppDomainRecord> {
    await this.ensureLoaded();
    const hostname = normalizeAppHostname(input.hostname);
    if (!hostname) {
      throw new Error("A valid hostname is required");
    }
    const appId = input.appId.trim();
    if (!appId) {
      throw new Error("App id is required");
    }

    const existing = this.byHostname.get(hostname);
    if (existing && existing.appId !== appId) {
      throw new AppDomainConflictError(hostname, existing.appId);
    }

    const now = new Date().toISOString();
    const record: AppDomainRecord = {
      hostname,
      appId,
      status: input.status ?? existing?.status ?? "pending_dns",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastVerifiedAt: existing?.lastVerifiedAt ?? null,
      error: input.error === undefined ? existing?.error ?? null : input.error,
    };

    this.setRecord(record);
    await this.persist();
    return record;
  }

  async updateDomain(hostnameInput: string, input: UpdateAppDomainInput): Promise<AppDomainRecord> {
    await this.ensureLoaded();
    const hostname = normalizeAppHostname(hostnameInput);
    if (!hostname) {
      throw new Error("A valid hostname is required");
    }
    const existing = this.byHostname.get(hostname);
    if (!existing) {
      throw new Error(`Domain ${hostname} is not registered`);
    }

    const now = new Date().toISOString();
    const record: AppDomainRecord = {
      ...existing,
      status: input.status ?? existing.status,
      error: input.error === undefined ? existing.error : input.error,
      lastVerifiedAt: input.verified ? now : existing.lastVerifiedAt,
      updatedAt: now,
    };

    this.setRecord(record);
    await this.persist();
    return record;
  }

  async removeDomain(hostnameInput: string): Promise<boolean> {
    await this.ensureLoaded();
    const hostname = normalizeAppHostname(hostnameInput);
    if (!hostname) {
      return false;
    }
    const existing = this.byHostname.get(hostname);
    if (!existing) {
      return false;
    }

    this.byHostname.delete(hostname);
    const appDomains = this.byAppId.get(existing.appId);
    appDomains?.delete(hostname);
    if (appDomains?.size === 0) {
      this.byAppId.delete(existing.appId);
    }
    await this.persist();
    return true;
  }

  async removeByAppId(appId: string): Promise<number> {
    await this.ensureLoaded();
    const appDomains = this.byAppId.get(appId);
    if (!appDomains || appDomains.size === 0) {
      return 0;
    }
    const hostnames = Array.from(appDomains.keys());
    for (const hostname of hostnames) {
      this.byHostname.delete(hostname);
    }
    this.byAppId.delete(appId);
    await this.persist();
    return hostnames.length;
  }

  private setRecord(record: AppDomainRecord): void {
    const previous = this.byHostname.get(record.hostname);
    if (previous && previous.appId !== record.appId) {
      this.byAppId.get(previous.appId)?.delete(record.hostname);
    }

    this.byHostname.set(record.hostname, record);
    let appDomains = this.byAppId.get(record.appId);
    if (!appDomains) {
      appDomains = new Map();
      this.byAppId.set(record.appId, appDomains);
    }
    appDomains.set(record.hostname, record);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const stats = await stat(this.filePath);
      if (!stats.isFile()) {
        await this.persist();
        this.loaded = true;
        return;
      }

      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as AppDomainRegistryState;
      this.byHostname.clear();
      this.byAppId.clear();

      for (const record of parsed.domains ?? []) {
        const hostname = normalizeAppHostname(record.hostname);
        if (!hostname || !record.appId) {
          continue;
        }
        this.setRecord({
          hostname,
          appId: record.appId,
          status: record.status ?? "pending_dns",
          createdAt: record.createdAt ?? new Date().toISOString(),
          updatedAt: record.updatedAt ?? new Date().toISOString(),
          lastVerifiedAt: record.lastVerifiedAt ?? null,
          error: record.error ?? null,
        });
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        this.byHostname.clear();
        this.byAppId.clear();
        await this.persist();
      } else {
        throw error;
      }
    }

    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const payload: AppDomainRegistryState = {
      domains: Array.from(this.byHostname.values()).sort((a, b) => a.hostname.localeCompare(b.hostname)),
    };

    const writeOperation = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
      await rename(tmpPath, this.filePath);
    };

    this.writeLock = this.writeLock.then(writeOperation, writeOperation);
    await this.writeLock;
  }
}

export const appDomainRegistry = new AppDomainRegistry();
