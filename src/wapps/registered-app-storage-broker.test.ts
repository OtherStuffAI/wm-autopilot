import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPublicKey, nip19, verifyEvent } from "nostr-tools";
import { WappStore } from "./wapp-store";
import { RegisteredAppStorageBroker } from "./registered-app-storage-broker";
import { REGISTERED_STORAGE_MAX_BYTES, REGISTERED_STORAGE_PROTOCOL, REGISTERED_STORAGE_OPERATIONS,
  parseRegisteredStorageRequest, readRegisteredStorageBytes } from "./registered-app-storage-contract";
import { handleWappRegisteredAppStorageRoute } from "../server/wapp-registered-app-storage-route";
import { issueRegisteredAppStorageRuntime } from "./registered-app-storage-runtime";
import { createRegisteredAppStorageClient } from "./registered-app-storage-client";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const npub = (n: number) => nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(n)));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "registered-storage-")); directories.push(directory);
  const store = new WappStore(join(directory, "wapps.sqlite"));
  const owner = npub(65);
  store.createTowerBinding({ id: "tower", label: "Fixture", towerUrl: "https://tower.example", workspaceOwnerNpub: owner });
  const app = store.create({ id: "install-a", appId: "app-a", title: "A", ownerNpub: owner, createdByNpub: owner,
    workspaceOwnerNpub: owner, scopeId: "scope", allowedNpubs: [owner], launchUrl: "https://app.example", towerBindingId: "tower" });
  let now = Date.now();
  let enabled = true;
  let responseOwner = owner;
  let descriptorProtocol = REGISTERED_STORAGE_PROTOCOL;
  let redirect = false;
  let extraResponse = false;
  let corruptBytes = false;
  let afterFetch: (() => void) | undefined;
  const calls: { url: string; method: string; body: any }[] = [];
  const objects = new Map<string, any>();
  const replays = new Map<string, any>();
  const data = Buffer.from("private fixture bytes");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const prepare = { idempotency_key: randomUUID(), file_name: "image.png", content_type: "image/png", size_bytes: data.length, sha256_hex: sha256 };
  const metadata = (object: any) => ({ protocol: REGISTERED_STORAGE_PROTOCOL, workspace_owner_npub: responseOwner, app_npub: app.appNpub,
    object_id: object.id, ...object.spec, is_public: false, completed_at: object.completedAt ?? null,
    ...(extraResponse ? { download_url: "https://provider.invalid/ticket", provider_secret: "never-return" } : {}) });
  const broker = new RegisteredAppStorageBroker({ store, forbiddenSigner: () => false, now: () => now,
    fetchImpl: async (url, init) => {
      const method = init.method!;
      const event = JSON.parse(Buffer.from(new Headers(init.headers).get("authorization")!.slice(6), "base64").toString());
      expect(verifyEvent(event)).toBe(true);
      expect(nip19.npubEncode(event.pubkey)).toBe(app.appNpub!);
      expect(event.tags).toContainEqual(["u", url]);
      expect(event.tags).toContainEqual(["method", method]);
      expect(init.redirect).toBe("manual");
      if (init.body) expect(event.tags).toContainEqual(["payload", createHash("sha256").update(String(init.body)).digest("hex")]);
      const prefix = `https://tower.example/api/v4/workspaces/${owner}/apps/${app.appNpub}/storage`;
      expect(url.startsWith(prefix)).toBe(true);
      const path = url.slice(prefix.length);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      afterFetch?.();
      if (redirect) return new Response(null, { status: 307, headers: { location: "https://evil.example" } });
      if (!enabled) return Response.json({ error: "app_not_registered" }, { status: 403 });
      if (path === "/descriptor") return Response.json({ protocol: descriptorProtocol, workspace_owner_npub: responseOwner,
        app_npub: app.appNpub, private_only: true, max_object_bytes: REGISTERED_STORAGE_MAX_BYTES, operations: REGISTERED_STORAGE_OPERATIONS });
      if (path === "/prepare") {
        const prior = replays.get(body.idempotency_key);
        if (prior && JSON.stringify(prior.spec) !== JSON.stringify(body)) return Response.json({ error: "storage_idempotency_conflict" }, { status: 409 });
        const object = prior ?? { id: randomUUID(), spec: body };
        objects.set(object.id, object); replays.set(body.idempotency_key, object);
        return Response.json(metadata(object));
      }
      const id = path.split("/")[2]; const object = objects.get(id!);
      if (!object) return Response.json({ error: "storage_object_not_found" }, { status: 404 });
      if (method === "PUT") object.bytes = Buffer.from(body.base64_data, "base64");
      if (path.endsWith("/complete")) {
        if (!object.bytes) return Response.json({ error: "storage_upload_incomplete" }, { status: 409 });
        object.completedAt ??= new Date(now).toISOString();
      }
      if (path.endsWith("/content")) return new Response(method === "HEAD" ? null : corruptBytes ? Buffer.from("bad") : object.bytes,
        { headers: { "Content-Type": "image/png", "Content-Length": String(data.length) } });
      return Response.json(metadata(object));
    } });
  const cap = broker.issue(app.id, app.appId);
  const request = (method: string, path: string, body?: unknown) => broker.request(cap.token, { method, path, ...(body === undefined ? {} : { body }) });
  const create = async () => (await (await request("POST", "/prepare", prepare)).json()).object_id as string;
  return { store, owner, app, broker, cap, request, create, prepare, data, calls, objects,
    disable: () => { enabled = false; }, wrongOwner: () => { responseOwner = npub(66); }, wrongProtocol: () => { descriptorProtocol = "other"; },
    redirect: () => { redirect = true; }, extraResponse: () => { extraResponse = true; }, corrupt: () => { corruptBytes = true; },
    expire: () => { now += 31 * 86400_000; }, afterFetch: (fn: () => void) => { afterFetch = fn; } };
}

describe("registered-app standard storage custody", () => {
  test("signed lifecycle, exact replay/conflict, private readback and immutable completion", async () => {
    const f = fixture();
    const id = await f.create();
    expect(await f.create()).toBe(id);
    await expect(f.request("POST", "/prepare", { ...f.prepare, file_name: "changed.png" })).rejects.toMatchObject({ status: 409 });
    expect((await (await f.request("PUT", `/objects/${id}`, { base64_data: f.data.toString("base64") })).json()).completed_at).toBeNull();
    const body = { size_bytes: f.data.length, sha256_hex: f.prepare.sha256_hex };
    const complete = await (await f.request("POST", `/objects/${id}/complete`, body)).json();
    expect(complete.completed_at).toBeString();
    expect(await (await f.request("POST", `/objects/${id}/complete`, body)).json()).toEqual(complete);
    const content = await f.request("GET", `/objects/${id}/content`);
    expect(content.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from((await content.json()).bytes_base64, "base64")).toEqual(f.data);
    const head = await f.request("HEAD", `/objects/${id}/content`);
    expect(head.headers.get("content-length")).toBe("0");
    expect(head.headers.get("x-storage-size-bytes")).toBe(String(f.data.length)); expect(await head.text()).toBe("");
    await expect(f.request("PUT", `/objects/${id}`, { base64_data: f.data.toString("base64") })).rejects.toMatchObject({ code: "storage_object_immutable" });
  });

  test("runtime binding env and SDK use loopback capability without grant configuration", async () => {
    const f = fixture();
    const env = issueRegisteredAppStorageRuntime(f.app.id, f.app.appId, 3600, f.broker, [f.app.id]);
    const bindings = JSON.parse(env.WAPP_REGISTERED_APP_STORAGE_BINDINGS_JSON!);
    expect(bindings[0]).toMatchObject({ installationId: f.app.id, workspaceOwnerNpub: f.owner, appNpub: f.app.appNpub, origin: "https://tower.example" });
    const client = createRegisteredAppStorageClient(env, (async (url, init) => {
      const request = new Request(url, init);
      return (await handleWappRegisteredAppStorageRoute({ request, url: new URL(String(url)), peer: { address: "127.0.0.1" }, broker: f.broker }))!;
    }) as typeof fetch);
    expect((await (await client.request({ method: "GET", path: "/descriptor" })).json()).protocol).toBe(REGISTERED_STORAGE_PROTOCOL);
    expect(() => createRegisteredAppStorageClient({ ...env, WAPP_REGISTERED_APP_STORAGE_BROKER_URL: "https://evil.example" })).toThrow();
    await expect(f.request("GET", "/descriptor")).rejects.toMatchObject({ code: "capability_invalid" });
  });

  test("denies foreign object, registration disable at every stage, and foreign installation", async () => {
    const f = fixture(); const id = await f.create();
    await expect(f.request("GET", `/objects/${randomUUID()}`)).rejects.toMatchObject({ status: 404 });
    await expect(f.broker.request(f.cap.token, { installationId: "install-b", method: "GET", path: "/descriptor" })).rejects.toMatchObject({ status: 403 });
    f.disable();
    for (const [method, path, body] of [
      ["GET", "/descriptor"], ["POST", "/prepare", f.prepare], ["PUT", `/objects/${id}`, { base64_data: f.data.toString("base64") }],
      ["POST", `/objects/${id}/complete`, { size_bytes: f.data.length, sha256_hex: f.prepare.sha256_hex }],
      ["GET", `/objects/${id}`], ["GET", `/objects/${id}/content`], ["HEAD", `/objects/${id}/content`],
    ] as const) await expect(f.request(method, path, body)).rejects.toMatchObject({ status: 403 });
  });

  test("rejects upload size/hash mismatch, altered completion and corrupt private bytes", async () => {
    const f = fixture(); const id = await f.create();
    await expect(f.request("PUT", `/objects/${id}`, { base64_data: Buffer.from("x").toString("base64") })).rejects.toMatchObject({ code: "storage_size_mismatch" });
    await expect(f.request("PUT", `/objects/${id}`, { base64_data: Buffer.alloc(f.data.length).toString("base64") })).rejects.toMatchObject({ code: "storage_hash_mismatch" });
    await expect(f.request("POST", `/objects/${id}/complete`, { size_bytes: f.data.length, sha256_hex: "0".repeat(64) })).rejects.toMatchObject({ code: "storage_completion_mismatch" });
    await f.request("PUT", `/objects/${id}`, { base64_data: f.data.toString("base64") });
    await f.request("POST", `/objects/${id}/complete`, { size_bytes: f.data.length, sha256_hex: f.prepare.sha256_hex });
    f.corrupt(); await expect(f.request("GET", `/objects/${id}/content`)).rejects.toMatchObject({ code: "storage_content_mismatch" });
  });

  test("checks protocol, namespace and redirects; strips provider details", async () => {
    for (const change of ["wrongProtocol", "wrongOwner", "redirect"] as const) {
      const f = fixture(); f[change](); await expect(f.create()).rejects.toMatchObject({ status: 502 });
    }
    const f = fixture(); f.extraResponse(); const id = await f.create();
    const meta = await (await f.request("GET", `/objects/${id}`)).json();
    expect(meta).not.toHaveProperty("download_url"); expect(meta).not.toHaveProperty("provider_secret");
  });

  test("revokes on expiry, explicit revoke, archived installation and binding drift", async () => {
    for (const change of ["expire", "revoke", "archive", "binding"] as const) {
      const f = fixture();
      if (change === "expire") f.expire();
      if (change === "revoke") f.broker.revokeApp(f.app.appId);
      if (change === "archive") f.store.update(f.app.id, { status: "archived" });
      if (change === "binding") f.store.updateTowerBinding("tower", { towerUrl: "https://other.example" });
      await expect(f.request("GET", "/descriptor")).rejects.toBeDefined();
      expect(f.calls).toHaveLength(0);
    }
    const f = fixture(); f.afterFetch(() => f.broker.revokeApp(f.app.appId));
    await expect(f.create()).rejects.toMatchObject({ code: "capability_invalid" });
  });
});

test("request allowlist rejects target injection, public authority and malformed bounds", () => {
  const spec = fixture().prepare;
  for (const path of ["https://evil.example", "//evil.example", "/../descriptor", "/descriptor?x=1", "/objects/%2e%2e", "/objects/a/content", "/objects/" + randomUUID() + "/publish"]) {
    expect(() => parseRegisteredStorageRequest({ method: "GET", path })).toThrow();
  }
  for (const body of [{ ...spec, is_public: true }, { ...spec, owner_npub: npub(70) }, { ...spec, size_bytes: REGISTERED_STORAGE_MAX_BYTES + 1 },
    { ...spec, sha256_hex: "bad" }, { ...spec, file_name: "../x" }]) expect(() => parseRegisteredStorageRequest({ method: "POST", path: "/prepare", body })).toThrow();
  for (const base64_data of ["", "YQ", "YR==", "Y Q==", "a".repeat(4 * Math.ceil(REGISTERED_STORAGE_MAX_BYTES / 3) + 4)]) {
    expect(() => parseRegisteredStorageRequest({ method: "PUT", path: `/objects/${randomUUID()}`, body: { base64_data } })).toThrow();
  }
});

test("loopback route fails closed for remote peer/host, missing token, query, and oversized chunked input", async () => {
  const f = fixture(); const url = new URL("http://127.0.0.1/api/internal/wapps/registered-app-storage");
  const route = (request: Request, peer = "127.0.0.1") => handleWappRegisteredAppStorageRoute({ request, url: new URL(request.url), peer: { address: peer }, broker: f.broker });
  const headers = { Authorization: `Bearer ${f.cap.token}`, "Content-Type": "application/json" };
  const body = JSON.stringify({ method: "GET", path: "/descriptor" });
  expect((await route(new Request(url, { method: "POST", headers, body }), "1.2.3.4"))!.status).toBe(403);
  expect((await route(new Request("http://evil.example" + url.pathname, { method: "POST", headers, body })))!.status).toBe(403);
  expect((await route(new Request(url, { method: "POST", body })))!.status).toBe(401);
  expect((await route(new Request(url + "?x=1", { method: "POST", headers, body })))!.status).toBe(405);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(12 * 1024 * 1024 + 1)); controller.close(); } });
  expect((await route(new Request(url, { method: "POST", headers, body: stream })))!.status).toBe(413);
});

test("bounded stream reads cancel stalled/oversized responses", async () => {
  const controller = new AbortController();
  const waiting = readRegisteredStorageBytes(new Response(new ReadableStream({})), 2, controller.signal);
  controller.abort(); await expect(waiting).rejects.toBeDefined();
  await expect(readRegisteredStorageBytes(new Response("abc"), 2, new AbortController().signal)).rejects.toMatchObject({ status: 413 });
});

test("accepts the full 8 MiB canonical upload ceiling", () => {
  const base64_data = Buffer.alloc(REGISTERED_STORAGE_MAX_BYTES, 128).toString("base64");
  expect(parseRegisteredStorageRequest({ method: "PUT", path: `/objects/${randomUUID()}`, body: { base64_data } }).method).toBe("PUT");
});

test("multiple assigned installations are snapshotted and newly added bindings are denied", async () => {
  const f = fixture();
  const second = f.store.create({ id: "install-two", appId: f.app.appId, title: "Second", ownerNpub: f.owner, createdByNpub: f.owner,
    workspaceOwnerNpub: f.owner, scopeId: "scope", allowedNpubs: [f.owner], launchUrl: "https://app.example", towerBindingId: "tower" });
  const issued = f.broker.issue(f.app.id, f.app.appId, [second.id]);
  expect(issued.bindings.map(row => row.installationId)).toEqual([f.app.id, second.id]);
  // The signature-validating fake Tower is pinned to A; selecting B reaches B's signer and is rejected by that fixture.
  // Use descriptor request A to prove adding an ungranted installation does not widen the existing snapshot.
  const third = f.store.create({ id: "install-three", appId: f.app.appId, title: "Third", ownerNpub: f.owner, createdByNpub: f.owner,
    workspaceOwnerNpub: f.owner, scopeId: "scope", allowedNpubs: [f.owner], launchUrl: "https://app.example", towerBindingId: "tower" });
  await expect(f.broker.request(issued.token, { installationId: third.id, method: "GET", path: "/descriptor" })).rejects.toMatchObject({ code: "storage_installation_denied" });
  expect((await f.broker.request(issued.token, { installationId: f.app.id, method: "GET", path: "/descriptor" })).status).toBe(200);
  f.store.update(second.id, { status: "archived" });
  await expect(f.broker.request(issued.token, { method: "GET", path: "/descriptor" })).rejects.toMatchObject({ code: "storage_installation_invalid" });
});

test("custody rejects forbidden principal, owner signer, duplicated signer and key rotation", async () => {
  const f = fixture();
  const forbidden = new RegisteredAppStorageBroker({ store: f.store, forbiddenSigner: () => true });
  expect(() => forbidden.issue(f.app.id, f.app.appId)).toThrow("storage_signer_not_isolated");
  expect(() => f.store.update(f.app.id, { appKeyMode: "generate" })).toThrow("replacement is not supported");
  const ownerApp = f.store.create({ id: "owner-signer", appId: "owner-app", title: "Owner", ownerNpub: f.owner, createdByNpub: f.owner,
    workspaceOwnerNpub: f.owner, scopeId: "scope", allowedNpubs: [f.owner], launchUrl: "https://app.example", towerBindingId: "tower",
    appKeyMode: "import", appNsec: nip19.nsecEncode(new Uint8Array(32).fill(65)) });
  expect(() => f.broker.issue(ownerApp.id, ownerApp.appId)).toThrow("storage_signer_not_isolated");
  const secret = nip19.nsecEncode(new Uint8Array(32).fill(74));
  const sharedApp = f.store.create({ id: "shared-signer", appId: "shared-app", title: "Shared", ownerNpub: f.owner, createdByNpub: f.owner,
    workspaceOwnerNpub: f.owner, scopeId: "scope", allowedNpubs: [f.owner], launchUrl: "https://app.example", towerBindingId: "tower",
    appKeyMode: "import", appNsec: secret });
  f.store.create({ id: "duplicate", appId: "other-app", title: "Duplicate", ownerNpub: f.owner, createdByNpub: f.owner,
    workspaceOwnerNpub: f.owner, scopeId: "scope", allowedNpubs: [f.owner], launchUrl: "https://other.example", towerBindingId: "tower",
    appKeyMode: "import", appNsec: secret });
  expect(() => f.broker.issue(sharedApp.id, sharedApp.appId)).toThrow("storage_signer_not_isolated");
});

test("real loopback HTTP SDK lifecycle and logical HEAD use valid POST framing", async () => {
  const f = fixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request, server) =>
    await handleWappRegisteredAppStorageRoute({ request, url: new URL(request.url), peer: server.requestIP(request), broker: f.broker }) ?? new Response(null, { status: 404 }) });
  try {
    const env = issueRegisteredAppStorageRuntime(f.app.id, f.app.appId, server.port!, f.broker, [f.app.id]);
    const client = createRegisteredAppStorageClient(env);
    const prepared = await (await client.request({ method: "POST", path: "/prepare", body: f.prepare })).json();
    const path = `/objects/${prepared.object_id}`;
    expect((await client.request({ method: "PUT", path, body: { base64_data: f.data.toString("base64") } })).status).toBe(200);
    expect((await client.request({ method: "POST", path: path + "/complete", body: { size_bytes: f.data.length, sha256_hex: f.prepare.sha256_hex } })).status).toBe(200);
    const content = await client.request({ method: "GET", path: path + "/content" });
    expect(Buffer.from((await content.json()).bytes_base64, "base64")).toEqual(f.data);
    const head = await client.request({ method: "HEAD", path: path + "/content" }, AbortSignal.timeout(2000));
    expect(head.headers.get("content-length")).toBe("0");
    expect(head.headers.get("x-storage-size-bytes")).toBe(String(f.data.length));
    expect(await head.text()).toBe("");
  } finally { await server.stop(true); }
});
