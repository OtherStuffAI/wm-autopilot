import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "bun:test";

import { IdentityUserStore } from "./identity-user-store";

const EXAMPLE_OPERATOR_NPUB = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqshp52w2";
const EXAMPLE_AGENT_NPUB = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpscums9v";

function withStore(fn: (store: IdentityUserStore, dbPath: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "identity-user-store-"));
  const dbPath = join(dir, "identity-users.db");
  try {
    const store = new IdentityUserStore(dbPath);
    fn(store, dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedLegacyUser(dbPath: string, npub: string, ports: number[], createdAt: string) {
  const db = new Database(dbPath);
  db.run(
    `INSERT INTO identity_users (
       normalized_npub,
       npub,
       alias,
       roles,
       created_at,
       updated_at,
       ports,
       balance
     ) VALUES (?1, ?1, ?1, '[]', ?2, ?2, ?3, 0)`,
    [npub, createdAt, JSON.stringify(ports)],
  );
  db.close();
}

describe("IdentityUserStore app ports", () => {
  test("stores a Nostr profile name separately from the generated alias", () => {
    withStore((store) => {
      const user = store.touch(EXAMPLE_OPERATOR_NPUB, { alias: "sample-operator" });
      const updated = store.setProfileName(EXAMPLE_OPERATOR_NPUB, "Example Operator");

      expect(user.alias).toBe("sample-operator");
      expect(updated.alias).toBe("sample-operator");
      expect(updated.profileName).toBe("Example Operator");
    });
  });

  test("assigns 1000 default app ports to a new user", () => {
    withStore((store) => {
      const user = store.touch(EXAMPLE_OPERATOR_NPUB);

      expect(user.ports).toHaveLength(1000);
      expect(user.ports[0]).toBe(41000);
      expect(user.ports.at(-1)).toBe(41999);
    });
  });

  test("tops up legacy users to 1000 ports without moving existing ports", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-user-store-legacy-"));
    const dbPath = join(dir, "identity-users.db");
    try {
      new IdentityUserStore(dbPath);
      seedLegacyUser(dbPath, EXAMPLE_OPERATOR_NPUB, [41000, 41001, 41002], "2026-01-01T00:00:00.000Z");
      seedLegacyUser(dbPath, EXAMPLE_AGENT_NPUB, [41003, 41004], "2026-01-02T00:00:00.000Z");

      const migrated = new IdentityUserStore(dbPath);
      const users = migrated.listUsers();
      const exampleUser = users.find((user) => user.normalizedNpub === EXAMPLE_OPERATOR_NPUB);
      const exampleAgent = users.find((user) => user.normalizedNpub === EXAMPLE_AGENT_NPUB);

      expect(exampleUser?.ports).toHaveLength(1000);
      expect(exampleAgent?.ports).toHaveLength(1000);
      expect(exampleUser?.ports.slice(0, 3)).toEqual([41000, 41001, 41002]);
      expect(exampleAgent?.ports.slice(0, 2)).toEqual([41003, 41004]);

      const exampleUserPorts = new Set(exampleUser?.ports ?? []);
      const overlap = (exampleAgent?.ports ?? []).filter((port) => exampleUserPorts.has(port));
      expect(overlap).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
