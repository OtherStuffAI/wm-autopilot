/**
 * User Settings Store
 *
 * SQLite key-value store for per-user settings (e.g. API keys).
 * Keyed by npub + setting key.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "./message-store";
import { decryptSettingValue, encryptSettingValue, isEncryptedSettingValue } from "./setting-value-crypto";

// ============================================================
// Store Implementation
// ============================================================

class UserSettingsStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  get(npub: string, key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string, string]>(
        "SELECT value FROM user_settings WHERE npub = ?1 AND key = ?2",
      )
      .get(npub, key);
    if (!row) return null;
    return this.decodeValue(npub, key, row.value);
  }

  set(npub: string, key: string, value: string): void {
    const now = new Date().toISOString();
    const storedValue = this.encodeValue(key, value);
    this.db
      .query(
        `INSERT INTO user_settings (npub, key, value, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(npub, key) DO UPDATE SET value = ?3, updated_at = ?4`,
      )
      .run(npub, key, storedValue, now);
  }

  delete(npub: string, key: string): boolean {
    const result = this.db
      .query("DELETE FROM user_settings WHERE npub = ?1 AND key = ?2")
      .run(npub, key);
    return result.changes > 0;
  }

  migrateSensitiveValues(): number {
    const rows = this.db
      .query<{ npub: string; key: string; value: string }, []>(
        "SELECT npub, key, value FROM user_settings",
      )
      .all();

    let migrated = 0;
    for (const row of rows) {
      if (!isSensitiveUserSettingKey(row.key) || isEncryptedSettingValue(row.value)) {
        continue;
      }
      this.writeMigratedValue(row.npub, row.key, encryptSettingValue(row.value));
      migrated += 1;
    }

    return migrated;
  }

  getAll(npub: string): Record<string, string> {
    const rows = this.db
      .query<{ key: string; value: string }, [string]>(
        "SELECT key, value FROM user_settings WHERE npub = ?1",
      )
      .all(npub);
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = this.decodeValue(npub, row.key, row.value);
    }
    return result;
  }

  private encodeValue(key: string, value: string): string {
    if (!isSensitiveUserSettingKey(key)) {
      return value;
    }
    if (isEncryptedSettingValue(value)) {
      return value;
    }
    return encryptSettingValue(value);
  }

  private decodeValue(npub: string, key: string, value: string): string {
    if (!isSensitiveUserSettingKey(key)) {
      return value;
    }
    if (!isEncryptedSettingValue(value)) {
      const encryptedValue = encryptSettingValue(value);
      if (encryptedValue !== value) {
        this.writeMigratedValue(npub, key, encryptedValue);
      }
      return value;
    }
    return decryptSettingValue(value);
  }

  private writeMigratedValue(npub: string, key: string, value: string): void {
    const now = new Date().toISOString();
    this.db
      .query("UPDATE user_settings SET value = ?3, updated_at = ?4 WHERE npub = ?1 AND key = ?2")
      .run(npub, key, value, now);
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_settings (
        npub TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (npub, key)
      );
    `);
  }
}

export const isSensitiveUserSettingKey = (key: string): boolean => {
  const normalizedKey = key.trim().toLowerCase();
  return (
    normalizedKey.includes("key") ||
    normalizedKey.includes("secret") ||
    normalizedKey.includes("token") ||
    normalizedKey.includes("password")
  );
};

export const userSettingsStore = new UserSettingsStore();
export { UserSettingsStore };
