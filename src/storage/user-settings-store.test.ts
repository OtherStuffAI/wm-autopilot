if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
}

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { UserSettingsStore } from "./user-settings-store";

const makeTempDb = () => join(tmpdir(), `user-settings-store-${randomUUID()}.sqlite`);

describe("UserSettingsStore", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTempDb();
  });

  afterEach(() => {
    rmSync(dbPath, { force: true });
  });

  test("encrypts sensitive settings at rest and decrypts on read", () => {
    const store = new UserSettingsStore(dbPath);

    store.set("npub1user", "github_api_key", "ghp_super_secret");
    store.set("npub1user", "github_username", "example-user");

    expect(store.get("npub1user", "github_api_key")).toBe("ghp_super_secret");
    expect(store.get("npub1user", "github_username")).toBe("example-user");

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .query<{ key: string; value: string }, [string]>("SELECT key, value FROM user_settings WHERE npub = ?1")
      .all("npub1user");
    db.close();

    const tokenRow = rows.find((row) => row.key === "github_api_key");
    const usernameRow = rows.find((row) => row.key === "github_username");

    expect(tokenRow?.value.startsWith("enc::")).toBe(true);
    expect(tokenRow?.value).not.toContain("ghp_super_secret");
    expect(usernameRow?.value).toBe("example-user");
  });

  test("migrates legacy plaintext sensitive settings on read", () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_settings (
        npub TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (npub, key)
      );
    `);
    db.query(
      "INSERT INTO user_settings (npub, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)",
    ).run("npub1user", "gitea_api_token", "legacy-token", new Date().toISOString());
    db.close();

    const store = new UserSettingsStore(dbPath);

    expect(store.get("npub1user", "gitea_api_token")).toBe("legacy-token");

    const verifyDb = new Database(dbPath, { readonly: true });
    const row = verifyDb
      .query<{ value: string }, [string, string]>("SELECT value FROM user_settings WHERE npub = ?1 AND key = ?2")
      .get("npub1user", "gitea_api_token");
    verifyDb.close();

    expect(row?.value.startsWith("enc::")).toBe(true);
    expect(row?.value).not.toContain("legacy-token");
  });

  test("migrateSensitiveValues encrypts legacy sensitive rows eagerly", () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_settings (
        npub TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (npub, key)
      );
    `);
    db.query(
      "INSERT INTO user_settings (npub, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)",
    ).run("npub1user", "github_api_key", "legacy-github-token", new Date().toISOString());
    db.close();

    const store = new UserSettingsStore(dbPath);
    expect(store.migrateSensitiveValues()).toBe(1);
    expect(store.get("npub1user", "github_api_key")).toBe("legacy-github-token");

    const verifyDb = new Database(dbPath, { readonly: true });
    const row = verifyDb
      .query<{ value: string }, [string, string]>("SELECT value FROM user_settings WHERE npub = ?1 AND key = ?2")
      .get("npub1user", "github_api_key");
    verifyDb.close();

    expect(row?.value.startsWith("enc::")).toBe(true);
  });
});
