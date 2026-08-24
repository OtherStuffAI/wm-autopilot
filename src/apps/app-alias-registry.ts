import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { generateAppAlias, isValidAppAlias } from "./app-alias-generator";

const registryFilePath = new URL("../../data/app-aliases.json", import.meta.url).pathname;

export interface AliasRecord {
  alias: string;
  appId: string;
  ownerNpub: string;
  directoryPath: string;
  createdAt: string;
}

interface AliasRegistryState {
  aliases: AliasRecord[];
}

/**
 * Registry for app subdomain aliases.
 * Maps deterministic three-word aliases to app IDs for routing.
 */
export class AppAliasRegistry {
  private readonly filePath: string;
  private loaded = false;
  private byAlias = new Map<string, AliasRecord>();
  private byAppId = new Map<string, AliasRecord>();
  private writeLock: Promise<void> = Promise.resolve();

  constructor(filePath: string = registryFilePath) {
    this.filePath = filePath;
  }

  /**
   * Get alias record by subdomain alias.
   */
  async getByAlias(alias: string): Promise<AliasRecord | undefined> {
    await this.ensureLoaded();
    return this.byAlias.get(alias.toLowerCase());
  }

  /**
   * Get alias record by app ID.
   */
  async getByAppId(appId: string): Promise<AliasRecord | undefined> {
    await this.ensureLoaded();
    return this.byAppId.get(appId);
  }

  /**
   * Register or update an alias for an app.
   * Generates deterministic alias from npub + directory path.
   *
   * @returns The alias record, or null if inputs are invalid
   */
  async registerAlias(
    appId: string,
    ownerNpub: string,
    directoryPath: string,
  ): Promise<AliasRecord | null> {
    await this.ensureLoaded();

    const alias = generateAppAlias(ownerNpub, directoryPath);
    if (!alias) {
      return null;
    }

    // Check if this app already has an alias
    const existing = this.byAppId.get(appId);
    if (existing) {
      // If same alias, return existing
      if (existing.alias === alias) {
        return existing;
      }
      // Different alias - remove old mapping
      this.byAlias.delete(existing.alias);
    }

    // Check for alias collision (different app, same alias)
    const collision = this.byAlias.get(alias);
    if (collision && collision.appId !== appId) {
      // This shouldn't happen with deterministic generation
      // unless two different apps have same npub + path (which is blocked by AppRegistry)
      console.warn(
        `[alias-registry] Alias collision detected: "${alias}" already mapped to app ${collision.appId}`,
      );
      return null;
    }

    const record: AliasRecord = {
      alias,
      appId,
      ownerNpub,
      directoryPath,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };

    this.byAlias.set(alias, record);
    this.byAppId.set(appId, record);
    await this.persist();

    return record;
  }

  /**
   * Remove alias for an app.
   */
  async removeAlias(appId: string): Promise<boolean> {
    await this.ensureLoaded();

    const record = this.byAppId.get(appId);
    if (!record) {
      return false;
    }

    this.byAlias.delete(record.alias);
    this.byAppId.delete(appId);
    await this.persist();

    return true;
  }

  /**
   * List all registered aliases.
   */
  async listAliases(): Promise<AliasRecord[]> {
    await this.ensureLoaded();
    return Array.from(this.byAlias.values()).sort((a, b) =>
      a.alias.localeCompare(b.alias),
    );
  }

  /**
   * Check if an alias is registered.
   */
  async hasAlias(alias: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.byAlias.has(alias.toLowerCase());
  }

  /**
   * Validate alias format without checking registry.
   */
  isValidFormat(alias: string): boolean {
    return isValidAppAlias(alias);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const stats = await stat(this.filePath);
      if (!stats.isFile()) {
        this.byAlias.clear();
        this.byAppId.clear();
        await this.persist();
        this.loaded = true;
        return;
      }

      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as AliasRegistryState;
      const records = parsed.aliases ?? [];

      this.byAlias.clear();
      this.byAppId.clear();

      for (const record of records) {
        if (record.alias && record.appId) {
          this.byAlias.set(record.alias.toLowerCase(), record);
          this.byAppId.set(record.appId, record);
        }
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        this.byAlias.clear();
        this.byAppId.clear();
        await this.persist();
      } else {
        throw error;
      }
    }

    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const payload: AliasRegistryState = {
      aliases: Array.from(this.byAlias.values()),
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

export const appAliasRegistry = new AppAliasRegistry();
