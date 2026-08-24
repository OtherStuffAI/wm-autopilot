// Must be set BEFORE any imports that trigger getSessionSecretBytes()
process.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";

import { describe, test, expect } from "bun:test";

import { handleBillingApi, type BillingApiContext } from "./billing-routes";
import type { RequestAuthContext } from "../auth/request-context";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

const makeAuthContext = (): RequestAuthContext => ({
  npub: "npub1testuser",
  sessionId: "admin-session",
} as any);

const makeConfigSummary = () => ({
  config: {
    teamUuid: "00000000-0000-0000-0000-000000000001",
    externalTeamId: null,
    useCredits: false,
    baseAllocationUsdCents: 5000,
    perMemberUsdCents: 1000,
    markupBps: 2100,
    updatedAt: new Date().toISOString(),
  },
  summary: {
    memberCount: 0,
    budgetUsdCents: 5000,
    budgetUsd: 50,
    baseAllocationUsdCents: 5000,
    perMemberUsdCents: 1000,
    markupBps: 2100,
    markupPercent: 21,
  },
  hasProviderKey: false,
  providerKeyHash: null,
  providerKeyUpdatedAt: null,
  creditsSupportedAgents: ["codex", "claude", "goose"],
  hasManagementKeyConfigured: false,
});

const makeCtx = (overrides?: Partial<BillingApiContext>): BillingApiContext => ({
  billingService: {
    syncTeamMembers: () => 0,
    getTeamConfigWithSummary: () => makeConfigSummary(),
    updateTeamConfig: () => makeConfigSummary(),
    setUseCredits: async () => makeConfigSummary(),
    ensureProviderKeyForCredits: async () => {},
    isCreditsEnabled: () => false,
    getRecentUsage: (limit: number) => [],
  } as any,
  ensureApiAccess: async () => null, // allow access
  AccessActions: { SystemManage: "SystemManage" as any },
  ...overrides,
});

const makeRequest = (
  path: string,
  method: HttpMethod = "GET",
  body?: unknown,
) => {
  const url = new URL(`http://localhost:3600${path}`);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return { request: new Request(url.toString(), init), url };
};

describe("handleBillingApi", () => {
  // ── routing ────────────────────────────────────────────────

  test("returns null for non-billing paths", async () => {
    const ctx = makeCtx();
    const { request, url } = makeRequest("/api/sessions", "GET");
    const result = await handleBillingApi(request, url, "GET", makeAuthContext(), ctx);
    expect(result).toBeNull();
  });

  test("returns access denied when ensureApiAccess returns a response", async () => {
    const ctx = makeCtx({
      ensureApiAccess: async () => Response.json({ error: "forbidden" }, { status: 403 }),
    });
    const { request, url } = makeRequest("/api/billing/team", "GET");
    const result = await handleBillingApi(request, url, "GET", makeAuthContext(), ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  // ── GET /api/billing/team ──────────────────────────────────

  test("GET /api/billing/team returns config with summary", async () => {
    const ctx = makeCtx();
    const { request, url } = makeRequest("/api/billing/team", "GET");
    const result = await handleBillingApi(request, url, "GET", makeAuthContext(), ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    const body = await result!.json();
    expect(body.config).toBeDefined();
    expect(body.summary).toBeDefined();
    expect(body.config.baseAllocationUsdCents).toBe(5000);
  });

  // ── PATCH /api/billing/team ────────────────────────────────

  test("PATCH /api/billing/team with valid JSON updates config", async () => {
    let updatedPatch: any = null;
    const ctx = makeCtx({
      billingService: {
        ...makeCtx().billingService,
        updateTeamConfig: (patch: any) => {
          updatedPatch = patch;
          return makeConfigSummary();
        },
        getTeamConfigWithSummary: () => makeConfigSummary(),
      } as any,
    });
    const { request, url } = makeRequest("/api/billing/team", "PATCH", {
      baseAllocationUsdCents: 10_000,
    });
    const result = await handleBillingApi(request, url, "PATCH", makeAuthContext(), ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    expect(updatedPatch).not.toBeNull();
    expect(updatedPatch.baseAllocationUsdCents).toBe(10_000);
  });

  test("PATCH /api/billing/team with invalid JSON returns 400", async () => {
    const ctx = makeCtx();
    const url = new URL("http://localhost:3600/api/billing/team");
    const request = new Request(url.toString(), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not valid json{{{",
    });
    const result = await handleBillingApi(request, url, "PATCH", makeAuthContext(), ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(400);
  });

  test("PATCH /api/billing/team with useCredits: true triggers setUseCredits", async () => {
    let useCreditsWasCalled = false;
    const ctx = makeCtx({
      billingService: {
        ...makeCtx().billingService,
        updateTeamConfig: () => makeConfigSummary(),
        setUseCredits: async (enabled: boolean) => {
          useCreditsWasCalled = true;
          expect(enabled).toBe(true);
          return makeConfigSummary();
        },
        getTeamConfigWithSummary: () => makeConfigSummary(),
      } as any,
    });
    const { request, url } = makeRequest("/api/billing/team", "PATCH", {
      useCredits: true,
    });
    await handleBillingApi(request, url, "PATCH", makeAuthContext(), ctx);
    expect(useCreditsWasCalled).toBe(true);
  });

  // ── GET /api/billing/usage ─────────────────────────────────

  test("GET /api/billing/usage returns recent usage with count", async () => {
    const ctx = makeCtx({
      billingService: {
        ...makeCtx().billingService,
        getRecentUsage: () => [
          { id: "u1", endpoint: "/test", method: "POST", upstreamCostUsd: 0.05, wingmanCostUsd: 0.0605 },
        ],
      } as any,
    });
    const { request, url } = makeRequest("/api/billing/usage", "GET");
    const result = await handleBillingApi(request, url, "GET", makeAuthContext(), ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    const body = await result!.json();
    expect(body.usage).toHaveLength(1);
    expect(body.count).toBe(1);
  });

  test("GET /api/billing/usage respects limit param", async () => {
    let receivedLimit = 0;
    const ctx = makeCtx({
      billingService: {
        ...makeCtx().billingService,
        getRecentUsage: (limit: number) => {
          receivedLimit = limit;
          return [];
        },
      } as any,
    });
    const { request, url } = makeRequest("/api/billing/usage?limit=25", "GET");
    await handleBillingApi(request, url, "GET", makeAuthContext(), ctx);
    expect(receivedLimit).toBe(25);
  });

  // ── expected failures ──────────────────────────────────────

  test.skip("EXPECTED FAIL: UI renders error when team has no credits remaining", () => {
    // This test documents expected behavior that needs UI implementation
  });

  test.skip("EXPECTED FAIL: Out of credits scenario (needs budget tracking integration)", () => {
    // Requires budget tracking to compare usage against budget
  });
});
