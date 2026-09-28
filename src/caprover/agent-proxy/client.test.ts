import { afterEach, beforeEach, expect, test } from "bun:test";
import { CaproverClient } from "../caprover-client";

let previousFetch: typeof fetch;
beforeEach(() => {
  previousFetch = globalThis.fetch;
  // Other browser tests replace/delete global fetch; use Bun's native HTTP client.
  globalThis.fetch = Bun.fetch;
});
afterEach(() => { globalThis.fetch = previousFetch; });

// Local fake upstream only; verifies the wire contract without touching live apps.
test("partial config sends PATCH, preserves omitted fields and never falls back to POST", async () => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json();
    calls.push({ method: request.method, path, body });
    if (path === "/api/v2/login") return Response.json({ status: 100, data: { token: "fake-token" } });
    expect(request.headers.get("x-captain-auth")).toBe("fake-token");
    return Response.json({ status: 100, data: {} });
  } });
  try {
    const client = new CaproverClient({ serverUrl: server.url.origin, password: "fake-password" }, { rejectRedirects: true, timeoutMs: 1000 });
    await client.patchAppConfig("demo", { instanceCount: 2 });
    expect(calls).toEqual([
      { method: "POST", path: "/api/v2/login", body: { password: "fake-password" } },
      { method: "PATCH", path: "/api/v2/user/apps/appDefinitions/update", body: { appName: "demo", instanceCount: 2 } },
    ]);
  } finally { server.stop(true); }
});

test("unsupported partial-update endpoint fails without a destructive fallback", async () => {
  const methods: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/api/v2/login") return Response.json({ status: 100, data: { token: "fake-token" } });
    methods.push(request.method);
    return new Response("PATCH unsupported", { status: 405 });
  } });
  try {
    const client = new CaproverClient({ serverUrl: server.url.origin, password: "fake-password" });
    await expect(client.patchAppConfig("demo", { instanceCount: 2 })).rejects.toThrow("Invalid JSON response");
    expect(methods).toEqual(["PATCH"]);
  } finally { server.stop(true); }
});

test("proxy client rejects credential-bearing redirects", async () => {
  let redirected = false;
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { redirected = true; return Response.json({ status: 100, data: { token: "fake" } }); } });
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.redirect(destination.url); } });
  try {
    const client = new CaproverClient({ serverUrl: source.url.origin, password: "fake-password" }, { rejectRedirects: true });
    await expect(client.getAllApps()).rejects.toThrow("Network error");
    expect(redirected).toBe(false);
  } finally { source.stop(true); destination.stop(true); }
});
