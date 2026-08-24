import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "./message-store";

export const FEATURE_FLAG_STATES = ["off", "on_admin", "on"] as const;

export type FeatureFlagState = (typeof FEATURE_FLAG_STATES)[number];

export interface FeatureFlagRecord {
  key: string;
  label: string;
  description: string | null;
  state: FeatureFlagState;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface CreateFeatureFlagInput {
  key: string;
  label: string;
  description?: string | null;
  state?: FeatureFlagState;
  updatedBy?: string | null;
}

export interface UpdateFeatureFlagInput {
  label?: string;
  description?: string | null;
  state?: FeatureFlagState;
  updatedBy?: string | null;
}

const defaultDbPath = databaseFile;

export const normaliseFeatureFlagKey = (input: string | null | undefined): string => {
  if (!input || typeof input !== "string") return "";
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return "";
  const slug = trimmed.replace(/[^a-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return slug;
};

export const isFeatureFlagState = (value: unknown): value is FeatureFlagState => {
  return typeof value === "string" && FEATURE_FLAG_STATES.includes(value as FeatureFlagState);
};

export const resolveFeatureFlagEffectiveState = (
  state: FeatureFlagState,
  viewerIsAdmin: boolean,
): FeatureFlagState => {
  if (state === "on") return "on";
  if (state === "on_admin") return viewerIsAdmin ? "on" : "off";
  return "off";
};

export class FeatureFlagStore {
  private readonly db: Database;

  constructor(filePath: string = defaultDbPath) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feature_flags (
        key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      )
    `);
  }

  listFlags(): FeatureFlagRecord[] {
    const statement = this.db.prepare(
      `SELECT
         key,
         label,
         description,
         state,
         created_at as createdAt,
         updated_at as updatedAt,
         updated_by as updatedBy
       FROM feature_flags
       ORDER BY key`,
    );
    return statement.all() as FeatureFlagRecord[];
  }

  getFlag(key: string): FeatureFlagRecord | null {
    const normalizedKey = normaliseFeatureFlagKey(key);
    if (!normalizedKey) return null;
    const statement = this.db.prepare(
      `SELECT
         key,
         label,
         description,
         state,
         created_at as createdAt,
         updated_at as updatedAt,
         updated_by as updatedBy
       FROM feature_flags
       WHERE key = ?1`,
    );
    const record = statement.get(normalizedKey);
    return (record as FeatureFlagRecord | undefined) ?? null;
  }

  ensureDefaults(defaults: CreateFeatureFlagInput[]) {
    defaults.forEach((flag) => {
      const key = normaliseFeatureFlagKey(flag.key);
      if (!key) return;
      const existing = this.getFlag(key);
      if (existing) {
        return;
      }
      const state: FeatureFlagState = flag.state && isFeatureFlagState(flag.state) ? flag.state : "off";
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO feature_flags (key, label, description, state, created_at, updated_at, updated_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .run(
          key,
          flag.label?.trim() || key,
          flag.description?.trim() || null,
          state,
          now,
          now,
          flag.updatedBy ?? null,
        );
    });
  }

  ensureDefaultState(key: string, state: FeatureFlagState): FeatureFlagRecord | null {
    const normalizedKey = normaliseFeatureFlagKey(key);
    if (!normalizedKey) return null;
    const existing = this.getFlag(normalizedKey);
    if (!existing) return null;
    if (existing.updatedBy || existing.state === state) {
      return existing;
    }
    return this.updateFlag(normalizedKey, { state, updatedBy: null });
  }

  createFlag(input: CreateFeatureFlagInput): FeatureFlagRecord {
    const key = normaliseFeatureFlagKey(input.key);
    if (!key) {
      throw new Error("Feature flag key is required");
    }
    if (this.getFlag(key)) {
      throw new Error(`Feature flag "${key}" already exists`);
    }
    const label = input.label?.trim();
    if (!label) {
      throw new Error("Feature flag label is required");
    }
    const state: FeatureFlagState = input.state && isFeatureFlagState(input.state) ? input.state : "off";
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO feature_flags (key, label, description, state, created_at, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .run(
        key,
        label,
        input.description?.trim() || null,
        state,
        now,
        now,
        input.updatedBy ?? null,
      );
    const created = this.getFlag(key);
    if (!created) {
      throw new Error("Failed to create feature flag");
    }
    return created;
  }

  updateFlag(key: string, updates: UpdateFeatureFlagInput): FeatureFlagRecord {
    const normalizedKey = normaliseFeatureFlagKey(key);
    if (!normalizedKey) {
      throw new Error("Feature flag key is required");
    }
    const existing = this.getFlag(normalizedKey);
    if (!existing) {
      throw new Error(`Feature flag "${normalizedKey}" not found`);
    }

    const fields: string[] = [];
    const values: unknown[] = [];

    if (Object.prototype.hasOwnProperty.call(updates, "label")) {
      const label = updates.label?.trim();
      if (!label) {
        throw new Error("Feature flag label is required");
      }
      fields.push(`label = ?${fields.length + 1}`);
      values.push(label);
    }

    if (Object.prototype.hasOwnProperty.call(updates, "description")) {
      const description = updates.description;
      fields.push(`description = ?${fields.length + 1}`);
      values.push(description === undefined ? existing.description : description?.trim() || null);
    }

    if (Object.prototype.hasOwnProperty.call(updates, "state")) {
      const state = updates.state;
      if (!state || !isFeatureFlagState(state)) {
        throw new Error("Invalid feature flag state");
      }
      fields.push(`state = ?${fields.length + 1}`);
      values.push(state);
    }

    if (fields.length === 0) {
      return existing;
    }

    const now = new Date().toISOString();
    fields.push(`updated_at = ?${fields.length + 1}`);
    values.push(now);

    fields.push(`updated_by = ?${fields.length + 1}`);
    values.push(updates.updatedBy ?? null);

    const statement = this.db.prepare(
      `UPDATE feature_flags
       SET ${fields.join(", ")}
       WHERE key = ?${fields.length + 1}`,
    );
    (statement.run as (...bindings: unknown[]) => unknown)(...values, normalizedKey);

    const updated = this.getFlag(normalizedKey);
    if (!updated) {
      throw new Error("Failed to update feature flag");
    }
    return updated;
  }
}

export const featureFlagStore = new FeatureFlagStore();
