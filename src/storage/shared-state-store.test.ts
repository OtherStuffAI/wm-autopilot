if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
}

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { SharedStateStore, normalizeSharedStateKey } from "./shared-state-store";

const makeTempDb = () => join(tmpdir(), `shared-state-store-${randomUUID()}.sqlite`);

describe("SharedStateStore", () => {
  let dbPath: string;
  let store: SharedStateStore;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new SharedStateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dbPath, { force: true });
  });

  test("encrypts shared state at rest and decrypts on read", () => {
    store.set("wingman_priv", "nsec1secret");

    expect(store.get("wingman_priv")).toBe("nsec1secret");

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .query<{ value: string }, [string]>("SELECT value FROM shared_state WHERE key = ?1")
      .get("wingman_priv");
    db.close();

    expect(row?.value.startsWith("enc::")).toBe(true);
    expect(row?.value).not.toContain("nsec1secret");
  });

  test("normalizes keys before storing", () => {
    store.set(" Wingman Priv ", "nsec1secret");

    expect(store.get("wingman_priv")).toBe("nsec1secret");
    expect(normalizeSharedStateKey(" Wingman Priv ")).toBe("wingman_priv");
  });
});
