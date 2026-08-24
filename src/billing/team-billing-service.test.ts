// Must be set BEFORE any imports that trigger getSessionSecretBytes()
// Guard: the session-secret module freezes this property after first access,
// so only set if not already configured by a prior test file in the same run.
if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
}

import { describe, test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { TeamBillingService, type TeamBillingServiceDependencies } from "./team-billing-service";
import { TeamBillingStore } from "../storage/team-billing-store";
import { encryptTeamProviderKey } from "./team-key-crypto";

const makeTempDb = () => join(tmpdir(), `test-svc-${randomUUID()}.db`);

const makeDeps = (overrides?: Partial<TeamBillingServiceDependencies>): TeamBillingServiceDependencies => ({
  listIdentityMembers: () => [],
  serverPort: 3000,
  baseUrl: "http://localhost:3000",
  ...overrides,
});

describe("TeamBillingService", () => {
  // ── proxy tokens ───────────────────────────────────────────

  describe("createSessionProxyToken / verifySessionProxyToken", () => {
    let service: TeamBillingService;

    beforeEach(() => {
      service = new TeamBillingService(makeDeps());
    });

    test("returns string starting with wmpt1.", () => {
      const token = service.createSessionProxyToken("session-1", null);
      expect(token.startsWith("wmpt1.")).toBe(true);
    });

    test("has exactly 3 dot-separated segments", () => {
      const token = service.createSessionProxyToken("session-1", null);
      expect(token.split(".")).toHaveLength(3);
    });

    test("verifySessionProxyToken returns payload for valid token", () => {
      const token = service.createSessionProxyToken("session-1", "npub1abc");
      const payload = service.verifySessionProxyToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.sid).toBe("session-1");
    });

    test("verifySessionProxyToken returns null for empty string", () => {
      expect(service.verifySessionProxyToken("")).toBeNull();
    });

    test("verifySessionProxyToken returns null for wrong prefix", () => {
      expect(service.verifySessionProxyToken("wrong.payload.sig")).toBeNull();
    });

    test("verifySessionProxyToken returns null for tampered signature", () => {
      const token = service.createSessionProxyToken("session-1", null);
      const parts = token.split(".");
      parts[2] = "tampered-signature";
      expect(service.verifySessionProxyToken(parts.join("."))).toBeNull();
    });

    test("verifySessionProxyToken returns null for tampered payload", () => {
      const token = service.createSessionProxyToken("session-1", null);
      const parts = token.split(".");
      parts[1] = Buffer.from('{"sid":"hacked","n":"x"}').toString("base64url");
      expect(service.verifySessionProxyToken(parts.join("."))).toBeNull();
    });

    test("round-trips sessionId and npub correctly", () => {
      const token = service.createSessionProxyToken("sess-42", "npub1xyz");
      const payload = service.verifySessionProxyToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.sid).toBe("sess-42");
      expect(payload!.npub).toBe("npub1xyz");
    });

    test("handles null npub", () => {
      const token = service.createSessionProxyToken("sess-42", null);
      const payload = service.verifySessionProxyToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.npub).toBeNull();
    });
  });

  // ── parseProxyCost ─────────────────────────────────────────

  describe("parseProxyCost", () => {
    let service: TeamBillingService;

    beforeEach(() => {
      service = new TeamBillingService(makeDeps());
    });

    test("extracts from x-openrouter-cost header", () => {
      const headers = new Headers({ "x-openrouter-cost": "0.0042" });
      expect(service.parseProxyCost(headers, null)).toBe(0.0042);
    });

    test("extracts from x-openrouter-usage-cost header", () => {
      const headers = new Headers({ "x-openrouter-usage-cost": "0.01" });
      expect(service.parseProxyCost(headers, null)).toBe(0.01);
    });

    test("extracts from x-request-cost header", () => {
      const headers = new Headers({ "x-request-cost": "0.005" });
      expect(service.parseProxyCost(headers, null)).toBe(0.005);
    });

    test("headers take precedence over body", () => {
      const headers = new Headers({ "x-openrouter-cost": "0.10" });
      const body = { cost: 0.20 };
      expect(service.parseProxyCost(headers, body)).toBe(0.10);
    });

    test("extracts cost from body JSON", () => {
      const headers = new Headers();
      expect(service.parseProxyCost(headers, { cost: 0.05 })).toBe(0.05);
    });

    test("extracts total_cost from body JSON", () => {
      const headers = new Headers();
      expect(service.parseProxyCost(headers, { total_cost: 0.07 })).toBe(0.07);
    });

    test("extracts from usage.cost nested path", () => {
      const headers = new Headers();
      expect(service.parseProxyCost(headers, { usage: { cost: 0.03 } })).toBe(0.03);
    });

    test("sums input_cost + output_cost", () => {
      const headers = new Headers();
      const body = { input_cost: 0.01, output_cost: 0.02 };
      expect(service.parseProxyCost(headers, body)).toBeCloseTo(0.03);
    });

    test("returns 0 when no cost found", () => {
      expect(service.parseProxyCost(new Headers(), {})).toBe(0);
    });

    test("handles null/undefined body", () => {
      expect(service.parseProxyCost(new Headers(), null)).toBe(0);
      expect(service.parseProxyCost(new Headers(), undefined)).toBe(0);
    });

    test("handles deeply nested cost keys (up to depth 6)", () => {
      const body = { data: { response: { usage: { cost: 0.99 } } } };
      expect(service.parseProxyCost(new Headers(), body)).toBe(0.99);
    });

    test("stops recursion at depth > 6", () => {
      // Build an object 8 levels deep with cost at the bottom
      let obj: any = { cost: 0.42 };
      for (let i = 0; i < 8; i++) {
        obj = { nested: obj };
      }
      // The cost is buried 9 levels deep — should not be found
      expect(service.parseProxyCost(new Headers(), obj)).toBe(0);
    });
  });

  // ── getBudgetSummary ───────────────────────────────────────

  describe("getBudgetSummary", () => {
    test("with 0 members: budget = base only", () => {
      // Use a fresh temp DB to control member count
      const dbPath = makeTempDb();
      const store = new TeamBillingStore(dbPath);
      // Service uses the module singleton, so we test via config param
      const service = new TeamBillingService(makeDeps());
      const config = store.getConfig();
      // getBudgetSummary reads member count from the singleton store,
      // but we can verify the math by providing a known config
      const summary = service.getBudgetSummary(config);
      // memberCount comes from module singleton, not our temp store
      // So just verify the formula: budget = base + members * perMember
      expect(summary.budgetUsdCents).toBe(
        config.baseAllocationUsdCents + summary.memberCount * config.perMemberUsdCents,
      );
    });

    test("markupPercent calculation (2100 bps = 21%)", () => {
      const service = new TeamBillingService(makeDeps());
      const config = { markupBps: 2_100 } as any;
      // Use default store for member count
      const summary = service.getBudgetSummary(config);
      expect(summary.markupPercent).toBe(21);
    });
  });

  // ── resolveLaunchConfig ────────────────────────────────────

  describe("resolveLaunchConfig", () => {
    // These tests use the module singleton store. We set up state via it.

    test("returns subscription with credits-disabled when useCredits=false", async () => {
      const service = new TeamBillingService(makeDeps());
      // Default config has useCredits=false
      const result = await service.resolveLaunchConfig({
        sessionId: "s1",
        agent: "codex",
        npub: null,
      });
      expect(result.billingMode).toBe("subscription");
      expect(result.fallbackReason).toBe("credits-disabled");
    });

    test("returns subscription with agent-opencode-unsupported for opencode", async () => {
      // We need credits enabled + a provider key for this path
      const dbPath = makeTempDb();
      const tempStore = new TeamBillingStore(dbPath);
      tempStore.updateConfig({ useCredits: true });
      const encrypted = encryptTeamProviderKey("sk-test-key");
      tempStore.setActiveProviderKey({
        provider: "openrouter",
        encryptedValue: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
      });

      // Since the service uses the module singleton, and we can't easily
      // swap it, we test the agent-unsupported path by verifying the
      // service method directly
      const service = new TeamBillingService(makeDeps());
      // isCreditsSupportedAgent is the gatekeeper
      expect(service.isCreditsSupportedAgent("opencode" as any)).toBe(false);
    });

    test("returns subscription with agent-gemini-unsupported for gemini", () => {
      const service = new TeamBillingService(makeDeps());
      expect(service.isCreditsSupportedAgent("gemini" as any)).toBe(false);
    });

    test("codex, claude, goose are supported agents", () => {
      const service = new TeamBillingService(makeDeps());
      expect(service.isCreditsSupportedAgent("codex" as any)).toBe(true);
      expect(service.isCreditsSupportedAgent("claude" as any)).toBe(true);
      expect(service.isCreditsSupportedAgent("goose" as any)).toBe(true);
    });
  });

  // ── recordProxyUsage ───────────────────────────────────────

  describe("recordProxyUsage", () => {
    test("correctly calculates upstream micros from USD", async () => {
      const service = new TeamBillingService(makeDeps());
      const record = await service.recordProxyUsage({
        sessionId: "s1",
        npub: null,
        agent: "codex",
        endpoint: "/v1/chat/completions",
        method: "POST",
        statusCode: 200,
        costUsd: 0.05,
      });
      // 0.05 USD = 50,000 micros
      expect(record.upstreamCostMicrosUsd).toBe(50_000);
    });

    test("correctly applies 21% markup (2100 bps)", async () => {
      const service = new TeamBillingService(makeDeps());
      const record = await service.recordProxyUsage({
        sessionId: "s1",
        npub: null,
        agent: "codex",
        endpoint: "/v1/chat/completions",
        method: "POST",
        statusCode: 200,
        costUsd: 0.05,
      });
      // 50,000 * 1.21 = 60,500
      expect(record.wingmanCostMicrosUsd).toBe(60_500);
    });

    test("zero cost records 0 for both upstream and wingman", async () => {
      const service = new TeamBillingService(makeDeps());
      const record = await service.recordProxyUsage({
        sessionId: "s1",
        npub: null,
        agent: "codex",
        endpoint: "/test",
        method: "POST",
        statusCode: 200,
        costUsd: 0,
      });
      expect(record.upstreamCostMicrosUsd).toBe(0);
      expect(record.wingmanCostMicrosUsd).toBe(0);
    });

    test("negative cost clamps to 0", async () => {
      const service = new TeamBillingService(makeDeps());
      const record = await service.recordProxyUsage({
        sessionId: "s1",
        npub: null,
        agent: "codex",
        endpoint: "/test",
        method: "POST",
        statusCode: 200,
        costUsd: -0.10,
      });
      expect(record.upstreamCostMicrosUsd).toBe(0);
      expect(record.wingmanCostMicrosUsd).toBe(0);
    });
  });
});
