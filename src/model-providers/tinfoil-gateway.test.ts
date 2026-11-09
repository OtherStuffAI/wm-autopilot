import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { SecretStore } from "../secrets/secret-store";
import { deniedPolicy } from "../secrets/secret-policy";
import { TinfoilGateway } from "./tinfoil-gateway";
import { configureSessionProvider } from "./provider-session";
import { handleModelProviderRoutes } from "./provider-routes";

const fixtures: Array<() => void> = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!(); });
function setup(fetchImpl?: typeof fetch, localProfile = false) {
  const root = mkdtempSync(join(tmpdir(), "tinfoil-test-"));
  const store = new SecretStore(join(root, "secrets.sqlite"), join(root, "master.key"));
  const owner = nip19.npubEncode(getPublicKey(generateSecretKey()));
  const identity = nip19.npubEncode(getPublicKey(generateSecretKey()));
  const secret = store.create(owner, "local", { label: "Tinfoil", type: "secret", value: "test-saved-key-must-stay-in-service",
    policy: { ...deniedPolicy(), identities: [identity], agents: { enabled: true, mode: "selected", ids: [identity] } } });
  store.saveProviderConnection(owner, "local", { credentialRef: secret.id, models: ["kimi-k3-1-pro"], revision: 0, enabled: true });
  const session = { npub: owner, status: "running", model: "tinfoil/kimi-k3-1-pro", metadata: {
    modelProvider: "tinfoil", modelProviderWorkspaceId: "local", agentChatBotNpub: identity, ...(localProfile ? { agentProfileId: "profile" } : { agentChatAgentId: "profile" }) } };
  const consumer = { ownerNpub: owner, workspaceId: "local", identityNpub: identity, context: "session" as const, contextId: identity };
  const gateway = new TinfoilGateway(store, () => session, async () => "http://127.0.0.1:3301/v1", fetchImpl ?? (async () => Response.json({ choices: [] })) as typeof fetch);
  const runtime = gateway.issue("session", consumer, "kimi-k3-1-pro");
  const request = (body: any = { model: "kimi-k3-1-pro", messages: [] }, path = "/v1/chat/completions", headers = {}) => new Request(`http://localhost${path}`, {
    method: "POST", headers: { authorization: `Bearer ${runtime.token}`, ...headers }, body: JSON.stringify(body),
  });
  fixtures.push(() => { gateway.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, owner, identity, secret, session, consumer, gateway, runtime, request };
}

test("gateway sends saved key only to fixed verified proxy and preserves streamed tool deltas", async () => {
  const chunks = ['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"read","arguments":"{\\\"path\\\":"}}]}}]}\n\n', 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"file\\\"}"}}]}}]}\n\n', 'data: [DONE]\n\n'];
  let received: any;
  const fixture = setup((async (url, options) => {
    received = { url, options };
    return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }), {
      headers: { "content-type": "text/event-stream", "x-secret-debug": "must-not-forward" },
    });
  }) as typeof fetch);
  const response = await fixture.gateway.handle(fixture.request({ model: "kimi-k3-1-pro", messages: [{ role: "tool", tool_call_id: "previous", content: "ok" }], tools: [{ type: "function", function: { name: "read" } }], stream: true }, undefined, { "x-api-key": "attacker", "x-forward-to": "https://attacker.invalid" }));
  expect(await response.text()).toBe(chunks.join(""));
  expect(received.url).toBe("http://127.0.0.1:3301/v1/chat/completions");
  expect(received.options.headers.authorization).toBe("Bearer test-saved-key-must-stay-in-service");
  expect(received.options.headers["x-api-key"]).toBeUndefined();
  expect(response.headers.get("x-secret-debug")).toBeNull();
  expect(fixture.runtime.token).not.toContain("saved-key");
  expect(fixture.store.get(fixture.owner, "local", fixture.secret.id).policy.allowExport).toBe(false);
});

test("gateway rejects arbitrary endpoints, query strings, models and browser callers", async () => {
  const f = setup();
  for (const [path, body, headers, status] of [
    ["/v1/models", {}, {}, 404], ["/v1/chat/completions?url=https://evil", {}, {}, 404],
    ["/v1/chat/completions", { model: "other", messages: [] }, {}, 403],
    ["/v1/chat/completions", {}, { origin: "http://evil" }, 403],
    ["/v1/chat/completions", {}, { authorization: "Bearer wrong" }, 401],
  ] as const) expect((await f.gateway.handle(f.request(body, path, headers))).status).toBe(status);
});

for (const change of ["owner", "workspace", "identity", "profile", "stopped", "secret", "connection", "grant"] as const) {
  test(`gateway denies stale ${change} and does not forward`, async () => {
    let forwarded = false;
    const f = setup((async () => { forwarded = true; return Response.json({}); }) as typeof fetch);
    if (change === "owner") f.session.npub = "other";
    if (change === "workspace") f.session.metadata.modelProviderWorkspaceId = "other";
    if (change === "identity") f.session.metadata.agentChatBotNpub = "other";
    if (change === "profile") f.session.metadata.agentChatAgentId = "other";
    if (change === "stopped") f.session.status = "stopped";
    if (change === "secret") f.store.revoke(f.owner, "local", f.secret.id, 1);
    if (change === "connection") f.store.saveProviderConnection(f.owner, "local", { credentialRef: f.secret.id, models: ["kimi-k3-1-pro"], revision: 1, enabled: false });
    if (change === "grant") f.gateway.revoke("session");
    expect((await f.gateway.handle(f.request())).status).toBe(change === "grant" ? 401 : 403);
    expect(forwarded).toBe(false);
  });
}

test("revoking an active grant aborts a pending upstream read", async () => {
  let aborted = false;
  const f = setup((async (_url, options) => {
    const signal = options!.signal!;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener("abort", () => { aborted = true; controller.error(new Error("upstream abort")); });
    } }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch);
  const response = await f.gateway.handle(f.request({ model: "kimi-k3-1-pro", messages: [], stream: true }));
  const pending = response.text();
  f.gateway.revoke("session");
  await expect(pending).rejects.toThrow();
  expect(aborted).toBe(true);
});

test("client cancellation aborts upstream; untrusted errors and redirects never escape", async () => {
  let aborted = false;
  const f = setup((async (_url, options) => {
    options!.signal!.addEventListener("abort", () => { aborted = true; });
    return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch);
  const response = await f.gateway.handle(f.request({ model: "kimi-k3-1-pro", messages: [], stream: true }));
  await response.body!.cancel(); expect(aborted).toBe(true);
  const bad = setup((async () => new Response("test-saved-key-must-stay-in-service", { status: 401, headers: { location: "https://evil" } })) as typeof fetch);
  const denied = await bad.gateway.handle(bad.request());
  expect(denied.status).toBe(502); expect(await denied.text()).not.toContain("saved-key"); expect(denied.headers.get("location")).toBeNull();
});

test("provider configuration stays metadata only and requires existing policy", async () => {
  const f = setup();
  const binding = { ownerNpub: f.owner, botNpub: f.identity, sessionId: "session", workspaceId: "local" };
  expect(configureSessionProvider(f.store, binding, "local", { operation: "status" }).connection?.credentialRef).toBe(f.secret.id);
  expect(() => configureSessionProvider(f.store, binding, "other", { operation: "status" })).toThrow("stale_session_binding");
  expect(() => configureSessionProvider(f.store, binding, "local", { operation: "configure", credentialRef: f.secret.id, models: ["kimi-k3-1-pro"], revision: 1, enabled: true, workspaceId: "other" })).toThrow("asserted_binding_denied");
  expect(() => f.store.saveProviderConnection(f.owner, "local", { value: "raw-key", revision: 1 })).toThrow("invalid_provider_configuration");
  expect(() => f.store.saveProviderConnection(f.owner, "local", { credentialRef: f.secret.id, models: ["kimi-k3-1-pro"], revision: 0, enabled: true })).toThrow("stale_provider_revision");
});

test("human provider routes reject delegated management and expose only metadata", async () => {
  const f = setup(); const url = new URL("http://localhost/api/model-providers/tinfoil");
  const ctx = { store: f.store, inventory: async () => ({ workspaces: [{ id: "local", label: "Local" }], identities: [], pipelines: [] }) };
  const allowed = await handleModelProviderRoutes(new Request(url), url, { npub: f.owner, session: null }, ctx);
  expect(allowed!.status).toBe(200); expect(await allowed!.text()).not.toContain("saved-key");
  expect((await handleModelProviderRoutes(new Request(url), url, { npub: f.owner, session: null, capabilitySessionId: "session" }, ctx))!.status).toBe(403);
});

test("authenticated model discovery exposes only the granted model without credential forwarding", async () => {
  let forwarded = false;
  const f = setup((async () => { forwarded = true; return Response.json({}); }) as typeof fetch);
  const response = await f.gateway.handle(new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${f.runtime.token}` } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ object: "list", data: [{ id: "kimi-k3-1-pro", object: "model", owned_by: "tinfoil" }] });
  expect(forwarded).toBe(false);
});

test("rotating saved credentials invalidates an existing session grant", async () => {
  const f = setup();
  f.store.update(f.owner, "local", f.secret.id, { revision: 1, value: "rotated-test-service-key" });
  expect((await f.gateway.handle(f.request())).status).toBe(403);
});

for (const change of ["unchanged", "profile", "identity", "missing-profile", "missing-identity", "revoked"] as const) {
  test(`local profile gateway binding: ${change}`, async () => {
    let forwarded = false;
    const f = setup((async () => { forwarded = true; return Response.json({ choices: [] }); }) as typeof fetch, true);
    if (change === "profile") f.session.metadata.agentProfileId = "different-profile";
    if (change === "identity") f.session.metadata.agentChatBotNpub = "different-bot";
    if (change === "missing-profile") delete f.session.metadata.agentProfileId;
    if (change === "missing-identity") f.session.metadata.agentChatBotNpub = "";
    if (change === "revoked") f.gateway.revoke("session");
    const response = await f.gateway.handle(f.request());
    expect(response.status).toBe(change === "unchanged" ? 200 : change === "revoked" ? 401 : 403);
    await response.text();
    expect(forwarded).toBe(change === "unchanged");
    if (change === "missing-profile" || change === "missing-identity" || change === "identity") {
      expect(() => f.gateway.issue("session", f.consumer, "kimi-k3-1-pro")).toThrow("tinfoil_identity_binding_required");
    }
  });
}
