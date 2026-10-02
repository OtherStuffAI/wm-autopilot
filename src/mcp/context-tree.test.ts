import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";
import type { SessionSnapshot } from "../agents/process-manager.ts";
import type { BotKeyRecord } from "../identity/bot-key-store.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CapabilityBroker, buildDefaultAgentCapabilityPolicy } from "../signing/capability-broker.ts";
import { createBotIdentityFromCapability, FlightDeckPgClient } from "../flightdeck-pg/client.ts";
import { contextOperations } from "../flightdeck-pg/context-operations.ts";
import { registerContextTreeTools, handleContextTree } from "./tools/context-tree.ts";
import { handleContextTreeHelper } from "./context-tree-helper.ts";
import { inheritWorkerContext } from "../session-dispatch/worker-context.ts";

const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const scope = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const root = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ref = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const token = "a".repeat(64);

test("registers all 11 context tools with required explicit routing and destructive schemas", () => {
  const registered = new Map<string, { inputSchema: Record<string, unknown>; callback: unknown }>();
  const server = { registerTool(name: string, config: { inputSchema: Record<string, unknown> }, callback: unknown) { registered.set(name, { ...config, callback }); } };
  registerContextTreeTools(server as unknown as McpServer, "http://broker.test", "worker");
  expect(registered.size).toBe(11);
  for (const [operation, spec] of Object.entries(contextOperations)) {
    expect(registered.get(`flightdeck_context_tree_${operation}`)?.inputSchema).toBe(spec.schema.shape);
    expect(spec.schema.safeParse({}).success).toBe(false);
  }
  expect(contextOperations.confirmed_delete.schema.safeParse({ workspace_id: workspace, scope_id: scope, component_id: root, input: { confirmation_token: token } }).success).toBe(false);
});
test("direct MCP invocation validates confirmation before broker transport", async () => {
  const result = await handleContextTree("confirmed_delete", { workspace_id: workspace, scope_id: scope, component_id: root, input: { confirmation_token: token } }, "http://invalid.test", "worker");
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]!.text).error).toContain("confirmed");
});
test("inherited workspace/signer context does not grant management or allow reporting overrides", () => {
  const parent = { id: "parent", npub: "npub1owner", metadata: { agentChatBotNpub: "npub1bot", flightdeckAgentNpub: "npub1bot", flightdeckWorkspaceId: workspace, flightdeckScopeId: scope, flightdeckTowerServiceNpub: "npub1tower" } } as SessionSnapshot;
  const inherited = inheritWorkerContext(parent, {}, () => true);
  expect(inherited.flightdeckWorkspaceId).toBe(workspace);
  expect(inherited).not.toHaveProperty("manage");
  expect(() => inheritWorkerContext(parent, { workspaceId: scope }, () => true)).toThrow("trusted parent context");
  expect(() => inheritWorkerContext(parent, {}, () => false)).toThrow("active owner subscription");
});

test("real broker + disposable HTTP route exercises client/registered MCP, exact auth and permission/conflict negatives", async () => {
  const secret = generateSecretKey(); const pubkey = getPublicKey(secret); const botNpub = nip19.npubEncode(pubkey);
  const owner = "npub1fixtureowner";
  const session = { id: "context-broker-worker", status: "running", npub: owner, metadata: { agentChatBotNpub: botNpub, flightdeckAgentNpub: botNpub, flightdeckWorkspaceId: workspace } } as SessionSnapshot;
  const record = { userNpub: owner, botNpub, botPubkeyHex: pubkey } as BotKeyRecord;
  let manage = true; let created = false; let version = 1; let previewToken = token;
  const methods: string[] = [];
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const event = JSON.parse(Buffer.from(request.headers.get("authorization")!.slice(6), "base64").toString());
    const body = await request.text();
    const tag = (name: string) => event.tags.find((value: string[]) => value[0] === name)?.[1];
    if (!verifyEvent(event) || event.pubkey !== pubkey || tag("u") !== request.url || tag("method") !== request.method ||
      (body && tag("payload") !== createHash("sha256").update(body).digest("hex"))) return Response.json({ error: "Exact request authorization mismatch" }, { status: 401 });
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(pubkey);
    expect(event.tags).toContainEqual(["u", request.url]);
    expect(event.tags).toContainEqual(["method", request.method]);
    if (body) expect(event.tags).toContainEqual(["payload", createHash("sha256").update(body).digest("hex")]);
    expect(request.headers.get("x-flightdeck-pg-app-npub")).toBe("npub1app");
    methods.push(request.method);
    const envelope = { identity: { workspace_id: workspace }, capabilities: { read: true, manage } };
    const url = new URL(request.url); const input = body ? JSON.parse(body) : {};
    if (url.pathname.endsWith("/references") && request.method === "GET") return Response.json({ ...envelope, references: [{ id: ref, target_type: "task", target: { record_id: root }, resolution: { status: "available", title: "Visible" } }], next_cursor: null });
    if (url.pathname.includes("/tasks/")) return Response.json({ ...envelope, task: { id: root, title: "Actual authoritative record" } });
    if (request.method === "GET" && url.pathname.endsWith("/components")) return Response.json({ ...envelope, components: created ? [{ id: root, title: "Disposable", parent_id: null, row_version: version, workspace_id: workspace, scope_id: scope }] : [], next_cursor: null });
    if (!manage) return Response.json({ ...envelope, error: "Management denied", code: "permission_denied" }, { status: 403 });
    if (url.pathname.endsWith("/delete-preview")) return Response.json({ ...envelope, preview: { component_id: root, component_count: 1, descendant_count: 0, reference_count: 1, confirmation_token: previewToken } });
    if (request.method === "PATCH" || request.method === "DELETE") {
      if (input.expected_row_version !== version) return Response.json({ ...envelope, error: "Stale row", code: "row_version_conflict" }, { status: 409 });
      version++;
    }
    if (url.pathname.endsWith("/delete")) {
      if (input.confirmation_token !== previewToken) return Response.json({ ...envelope, error: "Preview changed", code: "delete_preview_changed" }, { status: 409 });
      created = false; return Response.json({ ...envelope, deleted: { component_count: 1, reference_count: 1 } });
    }
    created = true;
    return Response.json({ ...envelope, component: { id: root, title: input.title ?? "Disposable", parent_id: null, row_version: version, workspace_id: workspace, scope_id: scope }, reference: { id: ref, row_version: version } });
  } });
  const targetUrl = `http://127.0.0.1:${target.port}`;
  const broker = new CapabilityBroker({ botKeyStore: { getActiveKeyForUser: () => record, getActiveKeyForBotNpub: () => record }, keyVault: { withKey: async (_record, operation) => operation(new Uint8Array(secret)) }, getSession: id => id === session.id ? session : null });
  const host = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/mcp/capabilities/")) return await broker.handle(request, url, request.method) ?? new Response(null, { status: 404 });
    const body = await request.clone().json() as Record<string, unknown> & { sessionId: string; action: string };
    const identityUrl = new URL(`/api/mcp/capabilities/identity?sessionId=${body.sessionId}`, url);
    const identity = await broker.handle(new Request(identityUrl.toString(), { headers: request.headers }), identityUrl, "GET");
    if (!identity?.ok) return identity!;
    return handleContextTreeHelper({ action: body.action, body, request, workspaceId: workspace, backendBaseUrl: targetUrl, appNpub: "npub1app", botIdentity: { botNpub, botPubkeyHex: pubkey, signNostrEvent: async () => { throw new Error("Not used"); }, signNip98: async () => { throw new Error("stored signer must never be used"); } }, sessionId: session.id });
  } });
  const hostUrl = `http://127.0.0.1:${host.port}`;
  const policy = buildDefaultAgentCapabilityPolicy({ towerUrl: targetUrl, autopilotUrl: hostUrl, ownerNpub: owner, workspaceId: workspace });
  const issued = broker.issueSessionCapability({ sessionId: session.id, ownerNpub: owner, botNpub, workspaceId: workspace, policy });
  const saved = { capability: Bun.env.WINGMAN_CAPABILITY, brokerUrl: Bun.env.WINGMAN_BROKER_URL };
  Bun.env.WINGMAN_CAPABILITY = issued.token; delete Bun.env.WINGMAN_BROKER_URL;
  try {
    const signer = createBotIdentityFromCapability({ wingmanUrl: hostUrl, sessionId: session.id, capabilityToken: issued.token, botNpub, botPubkeyHex: pubkey });
    const client = new FlightDeckPgClient({ towerUrl: targetUrl, wingmanUrl: hostUrl, appNpub: "npub1app", botIdentity: signer }).contextTree;
    expect((await client.create(workspace, scope, { title: "Disposable" })).component.id).toBe(root);
    expect((await client.list(workspace, scope)).components).toHaveLength(1);
    const registered = new Map<string, (params: never) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>>();
    registerContextTreeTools({ registerTool(name: string, _config: unknown, callback: never) { registered.set(name, callback); } } as unknown as McpServer, hostUrl, session.id);
    const invoke = async (operation: string, params: Record<string, unknown>) => {
      const result = await registered.get(`flightdeck_context_tree_${operation}`)!({ workspace_id: workspace, scope_id: scope, ...params } as never);
      return { ...result, payload: JSON.parse(result.content[0]!.text) };
    };
    expect((await invoke("reference", { component_id: root, reference_id: ref })).payload.source.task.title).toBe("Actual authoritative record");
    expect((await invoke("update", { component_id: root, input: { expected_row_version: 99, title: "Stale" } })).payload.code).toBe("row_version_conflict");
    expect((await invoke("unlink", { component_id: root, reference_id: ref, expected_row_version: 99 })).payload.code).toBe("row_version_conflict");
    manage = false;
    expect((await invoke("create", { input: { title: "Denied" } })).payload).toMatchObject({ code: "permission_denied", identity: { workspace_id: workspace } });
    expect((await invoke("delete_preview", { component_id: root })).isError).toBe(true);
    manage = true;
    const preview = await invoke("delete_preview", { component_id: root });
    expect(preview.payload.preview).toMatchObject({ component_count: 1, reference_count: 1 });
    previewToken = "b".repeat(64);
    expect((await invoke("confirmed_delete", { component_id: root, input: { confirmed: true, confirmation_token: token } })).payload.code).toBe("delete_preview_changed");
    expect((await invoke("confirmed_delete", { component_id: root, input: { confirmed: true, confirmation_token: previewToken } })).payload.deleted.component_count).toBe(1);
    expect((await client.list(workspace, scope)).components).toHaveLength(0);
    expect((await invoke("list", { workspace_id: scope })).payload.code).toBe("context_not_found");
    await expect(signer.signNip98!({ url: `${targetUrl}/api/v4/flightdeck-pg/workspaces/${scope}/scopes/${scope}/context/components`, method: "GET" })).rejects.toThrow();
    expect(methods).toContain("DELETE");
    const beforeRejectedTransport = methods.length;
    const unlinkUrl = `${targetUrl}/api/v4/flightdeck-pg/workspaces/${workspace}/scopes/${scope}/context/components/${root}/references/${ref}`;
    const signedBody = JSON.stringify({ expected_row_version: 1 });
    const authorization = await signer.signNip98!({ url: unlinkUrl, method: "DELETE", body: signedBody });
    const transportBody = { url: unlinkUrl, method: "DELETE", headers: [["authorization", authorization]], bodyBase64: Buffer.from(signedBody).toString("base64") };
    for (const changed of [
      { method: "PATCH" }, { url: `${unlinkUrl}?changed=true` },
      { bodyBase64: Buffer.from(JSON.stringify({ expected_row_version: 2 })).toString("base64") },
    ]) {
      const altered = { ...transportBody, ...changed };
      const rejected = await fetch(altered.url, { method: altered.method,
        headers: { authorization, "x-flightdeck-pg-app-npub": "npub1app", "content-type": "application/json" },
        body: Buffer.from(altered.bodyBase64, "base64") });
      expect(rejected.status).toBe(401);
    }
    expect(methods.length).toBe(beforeRejectedTransport);

    const none = broker.reissueSessionCapability(session.id, () => broker.issueSessionCapability({ sessionId: session.id, ownerNpub: owner, botNpub, workspaceId: workspace, policy: { ...policy, operations: ["identity.read"] } }));
    Bun.env.WINGMAN_CAPABILITY = none.token;
    const denied = await invoke("list", {});
    expect(denied.isError).toBe(true);
    expect(denied.payload.error).toContain("does not allow");
  } finally {
    if (saved.capability === undefined) delete Bun.env.WINGMAN_CAPABILITY; else Bun.env.WINGMAN_CAPABILITY = saved.capability;
    if (saved.brokerUrl === undefined) delete Bun.env.WINGMAN_BROKER_URL; else Bun.env.WINGMAN_BROKER_URL = saved.brokerUrl;
    host.stop(true); target.stop(true);
  }
}, 20000);

test("context host refuses remote bearer forwarding and schema bypass", async () => {
  const base = { action: "context_tree_list", body: { params: { workspace_id: workspace, scope_id: scope } }, workspaceId: workspace, backendBaseUrl: "https://tower.test", appNpub: "npub1app", botIdentity: { botNpub: "npub1bot", botPubkeyHex: "ab".repeat(32), signNostrEvent: async () => { throw new Error("Not used"); }, signNip98: async () => { throw new Error("Must not sign"); } }, sessionId: "worker" };
  expect((await handleContextTreeHelper({ ...base, request: new Request("https://remote.example/api/mcp/wingman/flightdeck", { headers: { authorization: "Bearer test-only" } }) })).status).toBe(403);
  expect((await handleContextTreeHelper({ ...base, request: new Request("http://localhost/api/mcp/wingman/flightdeck") })).status).toBe(403);
  expect((await handleContextTreeHelper({ ...base, body: { params: { ...base.body.params, manage: true } }, request: new Request("http://localhost/api/mcp/wingman/flightdeck") })).status).toBe(400);
});
