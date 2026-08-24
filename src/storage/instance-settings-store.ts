/**
 * Instance Settings Store
 *
 * SQLite key-value store for instance-wide runtime settings. Values are
 * encrypted at rest because this store can hold imported environment secrets.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "./message-store";
import { decryptSettingValue, encryptSettingValue } from "./setting-value-crypto";

export type InstanceSettingSource = "app" | "env_auto_import" | "env_manual_import" | "migration";

export interface InstanceSettingRecord {
  key: string;
  value: string;
  valueKind: string;
  source: InstanceSettingSource;
  sourceDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SetInstanceSettingInput {
  key: string;
  value: string;
  valueKind?: string;
  source?: InstanceSettingSource;
  sourceDetail?: string | null;
}

export class InstanceSettingsStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  has(key: string): boolean {
    const normalizedKey = normalizeInstanceSettingKey(key);
    if (!normalizedKey) return false;
    const row = this.db
      .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM instance_settings WHERE key = ?1")
      .get(normalizedKey);
    return (row?.count ?? 0) > 0;
  }

  get(key: string): string | null {
    const record = this.getRecord(key);
    return record?.value ?? null;
  }

  getRecord(key: string): InstanceSettingRecord | null {
    const normalizedKey = normalizeInstanceSettingKey(key);
    if (!normalizedKey) return null;
    const row = this.db
      .query<InstanceSettingRow, [string]>(
        `SELECT key, value, value_kind, source, source_detail, created_at, updated_at
         FROM instance_settings
         WHERE key = ?1`,
      )
      .get(normalizedKey);
    return row ? this.rowToRecord(row) : null;
  }

  getAllRecords(): InstanceSettingRecord[] {
    return this.db
      .query<InstanceSettingRow, []>(
        `SELECT key, value, value_kind, source, source_detail, created_at, updated_at
         FROM instance_settings
         ORDER BY key`,
      )
      .all()
      .map((row) => this.rowToRecord(row));
  }

  set(input: SetInstanceSettingInput): InstanceSettingRecord {
    const normalizedKey = normalizeInstanceSettingKey(input.key);
    if (!normalizedKey) {
      throw new Error("Instance setting key is required");
    }
    const now = new Date().toISOString();
    const encryptedValue = encryptSettingValue(input.value);
    const valueKind = input.valueKind ?? "string";
    const source = input.source ?? "app";
    const sourceDetail = input.sourceDetail ?? null;

    this.db
      .query(
        `INSERT INTO instance_settings (key, value, value_kind, source, source_detail, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(key) DO UPDATE SET
           value = ?2,
           value_kind = ?3,
           source = ?4,
           source_detail = ?5,
           updated_at = ?6`,
      )
      .run(normalizedKey, encryptedValue, valueKind, source, sourceDetail, now);

    const record = this.getRecord(normalizedKey);
    if (!record) {
      throw new Error("Failed to persist instance setting");
    }
    return record;
  }

  delete(key: string): boolean {
    const normalizedKey = normalizeInstanceSettingKey(key);
    if (!normalizedKey) return false;
    const result = this.db.query("DELETE FROM instance_settings WHERE key = ?1").run(normalizedKey);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }

  private rowToRecord(row: InstanceSettingRow): InstanceSettingRecord {
    return {
      key: row.key,
      value: decryptSettingValue(row.value),
      valueKind: row.value_kind,
      source: normalizeSource(row.source),
      sourceDetail: row.source_detail,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instance_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        value_kind TEXT NOT NULL DEFAULT 'string',
        source TEXT NOT NULL DEFAULT 'app',
        source_detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
}

interface InstanceSettingRow {
  key: string;
  value: string;
  value_kind: string;
  source: string;
  source_detail: string | null;
  created_at: string;
  updated_at: string;
}

export function normalizeInstanceSettingKey(key: string | null | undefined): string {
  if (typeof key !== "string") return "";
  return key.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_");
}

function normalizeSource(source: string): InstanceSettingSource {
  if (
    source === "app" ||
    source === "env_auto_import" ||
    source === "env_manual_import" ||
    source === "migration"
  ) {
    return source;
  }
  return "app";
}

export const instanceSettingsStore = new InstanceSettingsStore();
