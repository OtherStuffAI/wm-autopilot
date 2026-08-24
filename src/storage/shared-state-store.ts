/**
 * Shared State Store
 *
 * SQLite key-value store for instance-wide state that is not scoped to a user.
 * Values are encrypted at rest because this store can hold runtime secrets.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "./message-store";
import { decryptSettingValue, encryptSettingValue } from "./setting-value-crypto";

export interface SharedStateRecord {
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

class SharedStateStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  get(key: string): string | null {
    const normalizedKey = normalizeSharedStateKey(key);
    if (!normalizedKey) return null;

    const row = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM shared_state WHERE key = ?1",
      )
      .get(normalizedKey);
    if (!row) return null;
    return decryptSettingValue(row.value);
  }

  set(key: string, value: string): SharedStateRecord {
    const normalizedKey = normalizeSharedStateKey(key);
    if (!normalizedKey) {
      throw new Error("Shared state key is required");
    }

    const now = new Date().toISOString();
    const encryptedValue = encryptSettingValue(value);
    this.db
      .query(
        `INSERT INTO shared_state (key, value, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?4`,
      )
      .run(normalizedKey, encryptedValue, now, now);

    const record = this.getRecord(normalizedKey);
    if (!record) {
      throw new Error("Failed to persist shared state record");
    }
    return record;
  }

  getRecord(key: string): SharedStateRecord | null {
    const normalizedKey = normalizeSharedStateKey(key);
    if (!normalizedKey) return null;

    const row = this.db
      .query<SharedStateRow, [string]>(
        `SELECT key, value, created_at, updated_at
         FROM shared_state
         WHERE key = ?1`,
      )
      .get(normalizedKey);
    return row ? rowToRecord(row) : null;
  }

  close(): void {
    this.db.close();
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shared_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
}

interface SharedStateRow {
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export const normalizeSharedStateKey = (key: string | null | undefined): string => {
  if (typeof key !== "string") return "";
  return key.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_");
};

const rowToRecord = (row: SharedStateRow): SharedStateRecord => ({
  key: row.key,
  value: row.value,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const sharedStateStore = new SharedStateStore();
export { SharedStateStore };
