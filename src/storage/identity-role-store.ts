import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { normaliseNpub } from "../identity/npub-utils";

export interface IdentityRoleRecord {
  npub: string;
  normalizedNpub: string;
  roles: string[];
  onboardedAt: string | null;
  updatedAt: string;
}

type IdentityRoleFile = {
  records: IdentityRoleRecord[];
};

const DEFAULT_FILE_PATH = new URL("../../data/identity-roles.json", import.meta.url).pathname;

const cloneRecord = (record: IdentityRoleRecord): IdentityRoleRecord => ({
  npub: record.npub,
  normalizedNpub: record.normalizedNpub,
  roles: [...record.roles],
  onboardedAt: record.onboardedAt,
  updatedAt: record.updatedAt,
});

class IdentityRoleStore {
  private readonly filePath: string;
  private readonly records = new Map<string, IdentityRoleRecord>();

  constructor(filePath: string = DEFAULT_FILE_PATH) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.load();
  }

  private load() {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as IdentityRoleFile | IdentityRoleRecord[];
      const records = Array.isArray(parsed) ? parsed : parsed.records ?? [];
      this.records.clear();
      for (const entry of records) {
        if (!entry || typeof entry !== "object") continue;
        if (!entry.normalizedNpub || typeof entry.normalizedNpub !== "string") continue;
        const normalized = entry.normalizedNpub;
        const npub = typeof entry.npub === "string" && entry.npub.trim().length > 0 ? entry.npub : normalized;
        const roles = Array.isArray(entry.roles) ? entry.roles.filter((role): role is string => typeof role === "string") : [];
        const record: IdentityRoleRecord = {
          npub,
          normalizedNpub: normalized,
          roles: Array.from(new Set(roles)).sort(),
          onboardedAt: typeof entry.onboardedAt === "string" && entry.onboardedAt.length > 0 ? entry.onboardedAt : null,
          updatedAt: typeof entry.updatedAt === "string" && entry.updatedAt.length > 0 ? entry.updatedAt : new Date().toISOString(),
        };
        this.records.set(normalized, record);
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        this.persist();
        return;
      }
      throw error;
    }
  }

  private persist() {
    const payload: IdentityRoleFile = {
      records: this.listRecords(),
    };
    writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf8");
  }

  listRecords(): IdentityRoleRecord[] {
    return Array.from(this.records.values())
      .map(cloneRecord)
      .sort((a, b) => a.normalizedNpub.localeCompare(b.normalizedNpub));
  }

  getRecord(normalizedNpub: string): IdentityRoleRecord | null {
    const record = this.records.get(normalizedNpub);
    return record ? cloneRecord(record) : null;
  }

  setRole(npubValue: string, role: string, enabled: boolean): IdentityRoleRecord {
    if (typeof npubValue !== "string" || npubValue.trim().length === 0) {
      throw new Error("A valid npub is required");
    }
    const normalized = normaliseNpub(npubValue);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }
    const now = new Date().toISOString();
    const existing = this.records.get(normalized);
    const roles = new Set(existing?.roles ?? []);
    if (enabled) {
      roles.add(role);
    } else {
      roles.delete(role);
    }
    const record: IdentityRoleRecord = {
      npub: npubValue,
      normalizedNpub: normalized,
      roles: Array.from(roles).sort(),
      onboardedAt: existing?.onboardedAt ?? null,
      updatedAt: now,
    };

    if (role === "onboard") {
      record.onboardedAt = enabled ? now : null;
    } else if (!record.roles.includes("onboard")) {
      record.onboardedAt = null;
    }

    this.records.set(normalized, record);
    this.persist();
    return cloneRecord(record);
  }
}

export const identityRoleStore = new IdentityRoleStore();
