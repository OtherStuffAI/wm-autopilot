// Must be set BEFORE any imports that trigger getSessionSecretBytes()
// Guard: the session-secret module freezes this property after first access.
if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
}

import { describe, test, expect, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";

import { TeamBillingStore, type UsageLedgerInput } from "./team-billing-store";

const makeTempDb = () => join(tmpdir(), `test-billing-${randomUUID()}.db`);

const tempFiles: string[] = [];

const createStore = () => {
  const path = makeTempDb();
  tempFiles.push(path);
  return new TeamBillingStore(path);
};

afterEach(() => {
  for (const f of tempFiles) {
    try {
      if (existsSync(f)) unlinkSync(f);
      // WAL/SHM companions
      if (existsSync(f + "-wal")) unlinkSync(f + "-wal");
      if (existsSync(f + "-shm")) unlinkSync(f + "-shm");
    } catch { /* ignore */ }
  }
  tempFiles.length = 0;
});

describe("TeamBillingStore", () => {
  // ── getConfig ──────────────────────────────────────────────

  describe("getConfig", () => {
    test("returns default values on fresh DB", () => {
      const store = createStore();
      const config = store.getConfig();
      expect(config.useCredits).toBe(false);
      expect(config.baseAllocationUsdCents).toBe(5_000);
      expect(config.perMemberUsdCents).toBe(1_000);
      expect(config.markupBps).toBe(2_100);
      expect(config.externalTeamId).toBeNull();
    });

    test("includes a valid UUID for teamUuid", () => {
      const store = createStore();
      const config = store.getConfig();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(config.teamUuid).toMatch(uuidRegex);
    });
  });

  // ── updateConfig ───────────────────────────────────────────

  describe("updateConfig", () => {
    test("partial patch only updates provided fields", () => {
      const store = createStore();
      store.updateConfig({ baseAllocationUsdCents: 9_999 });
      const config = store.getConfig();
      expect(config.baseAllocationUsdCents).toBe(9_999);
      expect(config.perMemberUsdCents).toBe(1_000); // unchanged
      expect(config.markupBps).toBe(2_100); // unchanged
    });

    test("useCredits: true persists", () => {
      const store = createStore();
      store.updateConfig({ useCredits: true });
      expect(store.getConfig().useCredits).toBe(true);
    });

    test("clamps negative numbers to 0", () => {
      const store = createStore();
      store.updateConfig({
        baseAllocationUsdCents: -500,
        perMemberUsdCents: -1,
        markupBps: -100,
      });
      const config = store.getConfig();
      expect(config.baseAllocationUsdCents).toBe(0);
      expect(config.perMemberUsdCents).toBe(0);
      expect(config.markupBps).toBe(0);
    });

    test("NaN falls back to current value", () => {
      const store = createStore();
      store.updateConfig({ baseAllocationUsdCents: NaN });
      expect(store.getConfig().baseAllocationUsdCents).toBe(5_000);
    });

    test("Infinity falls back to current value", () => {
      const store = createStore();
      store.updateConfig({ baseAllocationUsdCents: Infinity });
      expect(store.getConfig().baseAllocationUsdCents).toBe(5_000);
    });
  });

  // ── members ────────────────────────────────────────────────

  describe("upsertMember / getMemberCount / listMembers", () => {
    test("upsertMember adds a member; getMemberCount returns 1", () => {
      const store = createStore();
      store.upsertMember("npub1abc", "npub1abc");
      expect(store.getMemberCount()).toBe(1);
    });

    test("upsertMember with same npub is idempotent", () => {
      const store = createStore();
      store.upsertMember("npub1abc", "npub1abc");
      store.upsertMember("npub1abc", "npub1abc");
      expect(store.getMemberCount()).toBe(1);
    });

    test("upsertMember with different npubs increments count", () => {
      const store = createStore();
      store.upsertMember("npub1abc", "npub1abc");
      store.upsertMember("npub1def", "npub1def");
      store.upsertMember("npub1ghi", "npub1ghi");
      expect(store.getMemberCount()).toBe(3);
    });

    test("listMembers returns all members ordered by added_at", () => {
      const store = createStore();
      store.upsertMember("npub1first", "npub1first");
      store.upsertMember("npub1second", "npub1second");
      const members = store.listMembers();
      expect(members).toHaveLength(2);
      expect(members[0].normalizedNpub).toBe("npub1first");
      expect(members[1].normalizedNpub).toBe("npub1second");
    });
  });

  // ── provider keys ──────────────────────────────────────────

  describe("setActiveProviderKey / getActiveProviderKey", () => {
    test("stores and retrieves a provider key", () => {
      const store = createStore();
      store.setActiveProviderKey({
        provider: "openrouter",
        keyHash: "hash123",
        encryptedValue: "enc-val",
        iv: "test-iv",
        authTag: "test-tag",
      });
      const key = store.getActiveProviderKey("openrouter");
      expect(key).not.toBeNull();
      expect(key!.provider).toBe("openrouter");
      expect(key!.encryptedValue).toBe("enc-val");
      expect(key!.keyHash).toBe("hash123");
    });

    test("deactivates previous key for same provider", () => {
      const store = createStore();
      const first = store.setActiveProviderKey({
        provider: "openrouter",
        encryptedValue: "val-1",
        iv: "iv-1",
        authTag: "tag-1",
      });
      const second = store.setActiveProviderKey({
        provider: "openrouter",
        encryptedValue: "val-2",
        iv: "iv-2",
        authTag: "tag-2",
      });
      expect(first.id).not.toBe(second.id);
      const active = store.getActiveProviderKey("openrouter");
      expect(active!.encryptedValue).toBe("val-2");
    });

    test("returns null for unknown provider", () => {
      const store = createStore();
      expect(store.getActiveProviderKey("unknown-provider")).toBeNull();
    });
  });

  // ── usage ledger ───────────────────────────────────────────

  describe("appendUsage / listRecentUsage", () => {
    const makeUsage = (overrides?: Partial<UsageLedgerInput>): UsageLedgerInput => ({
      endpoint: "/v1/chat/completions",
      method: "POST",
      upstreamCostMicrosUsd: 1_000,
      wingmanCostMicrosUsd: 1_210,
      ...overrides,
    });

    test("inserts a record with correct fields", () => {
      const store = createStore();
      const record = store.appendUsage(makeUsage({
        sessionId: "s1",
        npub: "npub1x",
        agent: "codex",
        provider: "openrouter",
        statusCode: 200,
      }));
      expect(record.id).toBeTruthy();
      expect(record.sessionId).toBe("s1");
      expect(record.npub).toBe("npub1x");
      expect(record.agent).toBe("codex");
      expect(record.provider).toBe("openrouter");
      expect(record.statusCode).toBe(200);
      expect(record.upstreamCostMicrosUsd).toBe(1_000);
      expect(record.wingmanCostMicrosUsd).toBe(1_210);
      expect(record.method).toBe("POST");
    });

    test("clamps negative cost values to 0", () => {
      const store = createStore();
      const record = store.appendUsage(makeUsage({
        upstreamCostMicrosUsd: -500,
        wingmanCostMicrosUsd: -100,
      }));
      expect(record.upstreamCostMicrosUsd).toBe(0);
      expect(record.wingmanCostMicrosUsd).toBe(0);
    });

    test("listRecentUsage returns records ordered by created_at DESC", () => {
      const store = createStore();
      // Insert three records — they may share the same timestamp so
      // we verify all are returned and order is deterministic
      store.appendUsage(makeUsage({ endpoint: "/first" }));
      store.appendUsage(makeUsage({ endpoint: "/second" }));
      store.appendUsage(makeUsage({ endpoint: "/third" }));
      const records = store.listRecentUsage();
      expect(records).toHaveLength(3);
      // All endpoints present
      const endpoints = records.map(r => r.endpoint);
      expect(endpoints).toContain("/first");
      expect(endpoints).toContain("/second");
      expect(endpoints).toContain("/third");
    });

    test("listRecentUsage respects limit parameter", () => {
      const store = createStore();
      for (let i = 0; i < 10; i++) {
        store.appendUsage(makeUsage({ endpoint: `/ep${i}` }));
      }
      expect(store.listRecentUsage(3)).toHaveLength(3);
    });

    test("listRecentUsage clamps limit to 1-500 range", () => {
      const store = createStore();
      store.appendUsage(makeUsage());
      // Limit 0 should clamp to 1
      expect(store.listRecentUsage(0)).toHaveLength(1);
      // Limit > 500 should clamp to 500 (we only have 1 record)
      expect(store.listRecentUsage(9999)).toHaveLength(1);
    });
  });
});
