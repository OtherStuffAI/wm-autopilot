// Must be set BEFORE any imports that trigger getSessionSecretBytes()
process.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";

import { describe, test, expect } from "bun:test";

import { handleProviderProxyApi, type ProviderProxyApiContext } from "./provider-proxy-routes";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

const VALID_TOKEN = "wmpt1.validpayload.validsig";

const makeSession = (overrides?: Record<string, unknown>) => ({
  id: "session-1",
  agent: "codex",
  status: "running",
  npub: null as string | null,
  metadata: { billingMode: "credits" },
  port: 3700,
  name: "session-1",
  startedAt: new Date().toISOString(),
  command: [],
  workingDirectory: "/tmp",
  logs: [],
  ...overrides,
});

const makeCtx = (overrides?: Partial<ProviderProxyApiContext>): ProviderProxyApiContext => ({
  billingService: {
    isCreditsEnabled: () => true,
    verifySessionProxyToken: (token: string) =>
      token === VALID_TOKEN ? { sid: "session-1", n: "nonce", npub: null } : null,
    parseProxyCost: () => 0,
    recordProxyUsage: async () => ({
      id: "usage-1",
      sessionId: "session-1",
      npub: null,
      agent: "codex",
      endpoint: "/v1/chat/completions",
      method: "POST",
      statusCode: 200,
      provider: "openrouter",
      providerRequestId: null,
      upstreamCostMicrosUsd: 0,
      wingmanCostMicrosUsd: 0,
      createdAt: new Date().toISOString(),
    }),
  } as any,
  getSession: (id: string) => (id === "session-1" ? makeSession() : null) as any,
  ensureProviderApiKey: async () => "sk-test-key",
  ...overrides,
});

const makeRequest = (
  path: string,
  method: HttpMethod = "POST",
  headers?: Record<string, string>,
  body?: string,
) => {
  const url = new URL(`http://localhost:3600${path}`);
  const init: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  };
  if (body && !["GET", "HEAD"].includes(method)) {
    init.body = body;
  }
  return { request: new Request(url.toString(), init), url };
};

describe("handleProviderProxyApi", () => {
  // ── routing ────────────────────────────────────────────────

  test("returns null for non-provider paths", async () => {
    const ctx = makeCtx();
    const { request, url } = makeRequest("/api/billing/team", "GET");
    const result = await handleProviderProxyApi(request, url, "GET", ctx);
    expect(result).toBeNull();
  });

  test("OPTIONS returns 204", async () => {
    const ctx = makeCtx();
    const { request, url } = makeRequest("/api/provider/openai/v1/chat/completions", "OPTIONS");
    const result = await handleProviderProxyApi(request, url, "OPTIONS", ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(204);
  });

  // ── auth guards ────────────────────────────────────────────

  test("returns 403 credits-disabled when credits off", async () => {
    const ctx = makeCtx({
      billingService: {
        ...makeCtx().billingService,
        isCreditsEnabled: () => false,
      } as any,
    });
    const { request, url } = makeRequest("/api/provider/openai/v1/chat/completions");
    const result = await handleProviderProxyApi(request, url, "POST", ctx);
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body.error).toBe("credits-disabled");
  });

  test("returns 401 missing-proxy-token when no auth header", async () => {
    const ctx = makeCtx();
    const { request, url } = makeRequest("/api/provider/openai/v1/chat/completions", "POST", {
      // no authorization header
    });
    const result = await handleProviderProxyApi(request, url, "POST", ctx);
    expect(result!.status).toBe(401);
    const body = await result!.json();
    expect(body.error).toBe("missing-proxy-token");
  });

  test("returns 401 invalid-proxy-token for bad token", async () => {
    const ctx = makeCtx();
    const { request, url } = makeRequest("/api/provider/openai/v1/chat/completions", "POST", {
      authorization: "Bearer bad-token",
    });
    const result = await handleProviderProxyApi(request, url, "POST", ctx);
    expect(result!.status).toBe(401);
    const body = await result!.json();
    expect(body.error).toBe("invalid-proxy-token");
  });

  test("returns 403 session-not-running for stopped session", async () => {
    const ctx = makeCtx({
      getSession: () => makeSession({ status: "stopped" }) as any,
    });
    const { request, url } = makeRequest("/api/provider/openai/v1/chat/completions", "POST", {
      authorization: `Bearer ${VALID_TOKEN}`,
    });
    const result = await handleProviderProxyApi(request, url, "POST", ctx);
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body.error).toBe("session-not-running");
  });

  test("returns 403 session-owner-mismatch when npubs differ", async () => {
    const ctx = makeCtx({
      billingService: {
        ...makeCtx().billingService,
        verifySessionProxyToken: () => ({ sid: "session-1", n: "nonce", npub: "npub1attacker" }),
      } as any,
      getSession: () => makeSession({ npub: "npub1owner" }) as any,
    });
    const { request, url } = makeRequest("/api/provider/openai/v1/chat/completions", "POST", {
      authorization: `Bearer ${VALID_TOKEN}`,
    });
    const result = await handleProviderProxyApi(request, url, "POST", ctx);
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body.error).toBe("session-owner-mismatch");
  });

  test("returns 403 session-not-credits-enabled when billing mode is subscription", async () => {
    const ctx = makeCtx({
      getSession: () => makeSession({ metadata: { billingMode: "subscription" } }) as any,
    });
    const { request, url } = makeRequest("/api/provider/openai/v1/chat/completions", "POST", {
      authorization: `Bearer ${VALID_TOKEN}`,
    });
    const result = await handleProviderProxyApi(request, url, "POST", ctx);
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body.error).toBe("session-not-credits-enabled");
  });

  test("returns 503 team-provider-key-unavailable when no team key", async () => {
    const ctx = makeCtx({
      ensureProviderApiKey: async () => null,
    });
    const { request, url } = makeRequest("/api/provider/openai/v1/chat/completions", "POST", {
      authorization: `Bearer ${VALID_TOKEN}`,
    });
    const result = await handleProviderProxyApi(request, url, "POST", ctx);
    expect(result!.status).toBe(503);
    const body = await result!.json();
    expect(body.error).toBe("team-provider-key-unavailable");
  });

  // ── token extraction ───────────────────────────────────────

  test("extracts token from Authorization header (Bearer prefix)", async () => {
    const ctx = makeCtx({
      billingService: {
        ...makeCtx().billingService,
        verifySessionProxyToken: (token: string) => {
          // Should receive the raw token without Bearer prefix
          expect(token).toBe(VALID_TOKEN);
          return { sid: "session-1", n: "nonce", npub: null };
        },
      } as any,
      // Short-circuit before actual fetch
      ensureProviderApiKey: async () => null,
    });
    const { request, url } = makeRequest("/api/provider/openai/v1/chat/completions", "POST", {
      authorization: `Bearer ${VALID_TOKEN}`,
    });
    await handleProviderProxyApi(request, url, "POST", ctx);
  });

  test("extracts token from x-api-key header", async () => {
    const ctx = makeCtx({
      billingService: {
        ...makeCtx().billingService,
        verifySessionProxyToken: (token: string) => {
          expect(token).toBe(VALID_TOKEN);
          return { sid: "session-1", n: "nonce", npub: null };
        },
      } as any,
      ensureProviderApiKey: async () => null,
    });
    const { request, url } = makeRequest("/api/provider/openai/v1/chat/completions", "POST", {
      "x-api-key": VALID_TOKEN,
    });
    await handleProviderProxyApi(request, url, "POST", ctx);
  });

  test("strips quotes from token values", async () => {
    let receivedToken = "";
    const ctx = makeCtx({
      billingService: {
        ...makeCtx().billingService,
        isCreditsEnabled: () => true,
        verifySessionProxyToken: (token: string) => {
          receivedToken = token;
          return null; // Will 401 but we just want to check extraction
        },
      } as any,
    });
    const { request, url } = makeRequest("/api/provider/openai/v1/chat/completions", "POST", {
      authorization: `Bearer "${VALID_TOKEN}"`,
    });
    await handleProviderProxyApi(request, url, "POST", ctx);
    expect(receivedToken).toBe(VALID_TOKEN);
  });

  // ── upstream URL routing ───────────────────────────────────
  // These need real fetch which we skip — document them as expected fails

  test.skip("EXPECTED FAIL: Correctly proxies to OpenRouter (needs real network or fetch mock)", () => {
    // Verifying that /api/provider/openai/* → openrouter.ai/api/v1/*
    // Would need to mock global fetch to validate the upstream URL
  });

  test.skip("EXPECTED FAIL: Records usage after successful proxy call", () => {
    // End-to-end test that requires mocking fetch for the upstream call
  });

  // ── URL routing logic (unit-level) ─────────────────────────

  test("correctly parses openai provider path", async () => {
    const ctx = makeCtx();
    const { request, url } = makeRequest("/api/provider/openai/v1/chat/completions", "OPTIONS");
    // OPTIONS bypasses auth, proving the path was recognized
    const result = await handleProviderProxyApi(request, url, "OPTIONS", ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(204);
  });

  test("correctly parses anthropic provider path", async () => {
    const ctx = makeCtx();
    const { request, url } = makeRequest("/api/provider/anthropic/v1/messages", "OPTIONS");
    const result = await handleProviderProxyApi(request, url, "OPTIONS", ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(204);
  });

  test("correctly parses openrouter provider path", async () => {
    const ctx = makeCtx();
    const { request, url } = makeRequest("/api/provider/openrouter/api/v1/chat/completions", "OPTIONS");
    const result = await handleProviderProxyApi(request, url, "OPTIONS", ctx);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(204);
  });

  test("returns null for unknown provider kind", async () => {
    const ctx = makeCtx();
    const { request, url } = makeRequest("/api/provider/google/v1/models", "OPTIONS");
    const result = await handleProviderProxyApi(request, url, "OPTIONS", ctx);
    expect(result).toBeNull();
  });
});
