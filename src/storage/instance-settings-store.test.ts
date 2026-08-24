if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
}

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { InstanceSettingsStore, normalizeInstanceSettingKey } from "./instance-settings-store";

const makeTempDb = () => join(tmpdir(), `instance-settings-store-${randomUUID()}.sqlite`);

describe("InstanceSettingsStore", () => {
  let dbPath: string;
  let store: InstanceSettingsStore;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new InstanceSettingsStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dbPath, { force: true });
  });

  test("encrypts all setting values at rest and decrypts on read", () => {
    store.set({
      key: "integrations.gitea_api_token",
      value: "super-secret-token",
      valueKind: "secret",
      source: "env_manual_import",
      sourceDetail: "GITEA_API_TOKEN",
    });

    expect(store.get("integrations.gitea_api_token")).toBe("super-secret-token");

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .query<{ value: string; source: string; source_detail: string | null }, [string]>(
        "SELECT value, source, source_detail FROM instance_settings WHERE key = ?1",
      )
      .get("integrations.gitea_api_token");
    db.close();

    expect(row?.value.startsWith("enc::")).toBe(true);
    expect(row?.value).not.toContain("super-secret-token");
    expect(row?.source).toBe("env_manual_import");
    expect(row?.source_detail).toBe("GITEA_API_TOKEN");
  });

  test("normalizes keys before storing", () => {
    store.set({ key: " Integrations Gitea Token ", value: "token" });

    expect(store.get("integrations_gitea_token")).toBe("token");
    expect(normalizeInstanceSettingKey(" Integrations Gitea Token ")).toBe("integrations_gitea_token");
  });
});
