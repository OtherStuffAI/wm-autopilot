import { describe, expect, test } from "bun:test";

import { callCapabilityBroker, capabilityClientContextFromEnv, CapabilityRateLimitError } from "./capability-client";

describe("capability client expiry recovery", () => {
  test("uses the host-local broker URL instead of the public API target", () => {
    expect(capabilityClientContextFromEnv({
      WINGMAN_URL: "https://agent.example.invalid",
      WINGMAN_BROKER_URL: "http://127.0.0.1:3600",
      SESSION_ID: "session-a",
      WINGMAN_CAPABILITY: "opaque-capability",
    })).toMatchObject({
      wingmanUrl: "http://127.0.0.1:3600",
      sessionId: "session-a",
      capabilityToken: "opaque-capability",
    });
  });

  test("refreshes an expired session capability and retries the original operation once", async () => {
    const paths: string[] = [];
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname;
      paths.push(path);
      if (paths.length === 1) return Response.json({ error: "Capability has expired" }, { status: 403 });
      if (path === "/api/mcp/capabilities/refresh") return Response.json({ token: "renewed-capability" });
      return Response.json({ signed: true });
    };

    const result = await callCapabilityBroker<{ signed: boolean }>(
      "/api/mcp/capabilities/nip98",
      { url: "http://localhost:3600/api/scheduler/jobs", method: "GET" },
      {
        wingmanUrl: "http://localhost:3600",
        sessionId: "long-running-manager",
        capabilityToken: "expired-capability",
        fetch: fetch as unknown as typeof globalThis.fetch,
      },
    );

    expect(result).toEqual({ signed: true });
    expect(paths).toEqual([
      "/api/mcp/capabilities/nip98",
      "/api/mcp/capabilities/refresh",
      "/api/mcp/capabilities/nip98",
    ]);
  });

  test("surfaces non-secret retry timing without automatically replaying a rate-limited request", async () => {
    let calls = 0;
    const fetch = async (): Promise<Response> => {
      calls += 1;
      return Response.json({
        error: "Capability rate limit exceeded",
        code: "capability_rate_limited",
        capabilityId: "cap-1",
        sessionId: "session-1",
        operation: "nip98.sign",
        rateLimit: { retryAfterMs: 12_500 },
      }, { status: 429, headers: { "retry-after": "13" } });
    };
    let caught: unknown;
    try {
      await callCapabilityBroker("/api/mcp/capabilities/nip98", {}, {
        wingmanUrl: "http://localhost:3600",
        sessionId: "session-1",
        capabilityToken: "opaque-token",
        fetch: fetch as unknown as typeof globalThis.fetch,
      });
    } catch (error) { caught = error; }
    expect(calls).toBe(1);
    expect(caught).toBeInstanceOf(CapabilityRateLimitError);
    expect(caught).toMatchObject({ retryAfterMs: 12_500, metadata: { capabilityId: "cap-1", operation: "nip98.sign" } });
    expect(JSON.stringify(caught)).not.toContain("opaque-token");
  });

  test("does not reuse a cached capability across sessions", async () => {
    const authorizations: string[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ signed: true });
    };
    await callCapabilityBroker("/api/mcp/capabilities/nip98", {}, {
      wingmanUrl: "http://localhost:3600",
      sessionId: "session-a",
      capabilityToken: "capability-a",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await callCapabilityBroker("/api/mcp/capabilities/nip98", {}, {
      wingmanUrl: "http://localhost:3600",
      sessionId: "session-b",
      capabilityToken: "capability-b",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    expect(authorizations).toEqual(["Bearer capability-a", "Bearer capability-b"]);
  });

  test("explicitly adopts an administrator-issued replacement and retries once", async () => {
    const calls: Array<{ path: string; authorization: string }> = [];
    const previous = process.env.WINGMAN_CAPABILITY;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname;
      calls.push({ path, authorization: new Headers(init?.headers).get("authorization") ?? "" });
      if (calls.length === 1) return Response.json({ error: "Capability was reissued", code: "capability_reissued" }, { status: 409 });
      if (path.endsWith("reissue-adopt")) return Response.json({ token: "replacement-capability" });
      return Response.json({ signed: true });
    };
    try {
      const result = await callCapabilityBroker<{ signed: boolean }>("/api/mcp/capabilities/nip98", {}, {
        wingmanUrl: "http://localhost:3600",
        sessionId: "reissued-session",
        capabilityToken: "revoked-capability",
        fetch: fetch as unknown as typeof globalThis.fetch,
      });
      expect(result).toEqual({ signed: true });
      expect(calls).toEqual([
        { path: "/api/mcp/capabilities/nip98", authorization: "Bearer revoked-capability" },
        { path: "/api/mcp/capabilities/reissue-adopt", authorization: "Bearer revoked-capability" },
        { path: "/api/mcp/capabilities/nip98", authorization: "Bearer replacement-capability" },
      ]);
    } finally {
      if (previous === undefined) delete process.env.WINGMAN_CAPABILITY;
      else process.env.WINGMAN_CAPABILITY = previous;
    }
  });
});
