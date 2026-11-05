import { WappTowerDbRequestBroker } from "./tower-db-request-broker";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";
import { WappStore } from "./wapp-store";
import { RemoteStorageBroker } from "./remote-storage-broker";
import { REMOTE_STORAGE_BROKER_PATH, REMOTE_STORAGE_PREFIX, REMOTE_STORAGE_PROTOCOL, REMOTE_STORAGE_TOKEN_HEADER, readStorageJson } from "./remote-storage-contract";
import { parseRemoteStorageGrants, storageIdentityRotationBlocked, type RemoteStorageGrant } from "./remote-storage-grants";
import { issueRemoteStorageRuntime } from "./remote-storage-runtime";
import { handleWappRemoteStorageRoute } from "../server/wapp-remote-storage-route";

async function fixture(fn: (f: {
  broker: RemoteStorageBroker; store: WappStore; grants: RemoteStorageGrant[]; grant: RemoteStorageGrant;
  calls: { url: string; init: RequestInit }[]; token: string; setReply: (value: unknown, status?: number) => void;
  setHealth: (value: unknown, status?: number) => void; setDescriptor: (value: unknown) => void;
  setForbidden: (value: boolean) => void; setTime: (value: number) => void; now: number;
}) => Promise<void>, local = false) {
  const directory = mkdtempSync(join(tmpdir(), "remote-storage-broker-"));
  const store = new WappStore(join(directory, "wapps.sqlite"));
  const owner = nip19.npubEncode(getPublicKey(generateSecretKey()));
  store.createTowerBinding({ id: "source-tower", label: "Source", towerUrl: "https://source.example", workspaceOwnerNpub: owner });
  let installation = store.create({ id: "installation-one", appId: "backup", title: "Backup", ownerNpub: owner,
    createdByNpub: owner, workspaceOwnerNpub: owner, scopeId: "scope", allowedNpubs: [owner], launchUrl: "https://backup.example",
    towerBindingId: local ? null : "source-tower", appKeyMode: local ? undefined : "generate" });
  if (local) installation = store.ensureLocalAppSigningIdentity(installation.id, owner);
  const now = Date.now(); let time = now; let forbidden = false;
  const grant: RemoteStorageGrant = { grantId: "grant-one", revision: "1", installationId: installation.id, appId: installation.appId,
    ownerNpub: owner, appNpub: installation.appNpub!, towerBindingId: installation.towerBindingId, origin: "https://destination.example",
    serviceNpub: nip19.npubEncode(getPublicKey(generateSecretKey())), workspaceId: randomUUID(), delegationId: randomUUID(),
    expiresAt: new Date(now + 3600_000).toISOString(), maxObjectBytes: 64, billing: "operator_budget" };
  const grants = [grant];
  let responseStatus = 200, reply: unknown;
  let health: unknown = { service_npub: grant.serviceNpub }, healthStatus = 200;
  let descriptor: unknown = { protocol: REMOTE_STORAGE_PROTOCOL, features: ["durable_idempotency", "quota_reservations", "private_objects", "immutable_completion", "revocable_downloads", "bounded_stream_uploads", "recovery_status", "publisher_receipts"] };
  const calls: { url: string; init: RequestInit }[] = [];
  const broker = new RemoteStorageBroker({ store, grants: () => grants, forbiddenSigner: () => forbidden, now: () => time,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/health")) return Response.json(health, { status: healthStatus });
      if (url.endsWith("/descriptor")) return Response.json(descriptor);
      return Response.json(reply ?? { protocol: REMOTE_STORAGE_PROTOCOL, service_npub: grant.serviceNpub,
        workspace_id: grant.workspaceId, delegation_id: grant.delegationId, installation_id: grant.installationId,
        remaining_bytes: 100, remaining_objects: 10, max_object_bytes: 64, list_cursor: Buffer.from(JSON.stringify({ w: grant.workspaceId, d: grant.delegationId, t: new Date(0).toISOString(), id: "00000000-0000-0000-0000-000000000000" })).toString("base64url"), billing: "operator_budget",
        budget_mode: "operator_allocated_unmetered", billing_ok: true }, { status: responseStatus, headers: { "x-secret": "never-relay" } });
    },
  });
  const token = broker.issue(grant.appId)!.token;
  try {
    await fn({ broker, store, grant, grants, calls, token, now, setTime: value => { time = value; },
      setForbidden: value => { forbidden = value; }, setReply: (value, status = 200) => { reply = value; responseStatus = status; },
      setHealth: (value, status = 200) => { health = value; healthStatus = status; }, setDescriptor: value => { descriptor = value; } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function identity(grant: RemoteStorageGrant, id: string, hash: string, size: number, state = "pending") {
  return { protocol: REMOTE_STORAGE_PROTOCOL, service_npub: grant.serviceNpub, workspace_id: grant.workspaceId,
    delegation_id: grant.delegationId, installation_id: grant.installationId, object_id: id, state, sha256_hex: hash,
    size_bytes: size, verified_at: state === "complete" ? new Date().toISOString() : null };
}
describe("installed-app remote storage broker", () => {
  test("existing local-only vault identity supports storage without a Tower appdb binding", () => fixture(async f => {
    expect(f.grant.towerBindingId).toBeNull();
    expect((await f.broker.request(f.token, { operation: "status" })).status).toBe(200);
  }, true));
  test("same-key DB capability cannot sign a managed-storage route", () => fixture(async f => {
    let calls = 0;
    const db = new WappTowerDbRequestBroker({ store: f.store, fetchImpl: async () => { calls++; return Response.json({}); } });
    const cap = db.issue({ installationId: f.grant.installationId, appId: f.grant.appId });
    await expect(db.request(cap.token, { method: "POST", path: REMOTE_STORAGE_PREFIX + "/prepare", body: {} })).rejects.toMatchObject({ code: "db_path_not_allowed" });
    expect(calls).toBe(0);
  }));
  test("uses actual per-install NIP98 with exact fixed URL, method and payload; never returns proof", () => fixture(async f => {
    const response = await f.broker.request(f.token, { operation: "status" });
    expect(response.status).toBe(200);
    expect(response.headers.has("x-secret")).toBeFalse();
    expect(f.calls).toHaveLength(3);
    const signed = f.calls[2]!;
    expect(signed.url).toBe(`${f.grant.origin}${REMOTE_STORAGE_PREFIX}/workspaces/${f.grant.workspaceId}/delegations/${f.grant.delegationId}/status`);
    expect(signed.init.redirect).toBe("manual");
    const event = JSON.parse(Buffer.from(new Headers(signed.init.headers).get("Authorization")!.slice(6), "base64").toString());
    expect(verifyEvent(event)).toBeTrue();
    expect(nip19.npubEncode(event.pubkey)).toBe(f.grant.appNpub);
    expect(event.tags).toContainEqual(["u", signed.url]);
    expect(event.tags).toContainEqual(["method", "POST"]);
    expect(event.tags).toContainEqual(["payload", createHash("sha256").update(String(signed.init.body)).digest("hex")]);
    expect(JSON.stringify(await response.json())).not.toContain("Nostr ");
  }));
  test("validates upload stream destination, exact headers and immutable prepared identity", () => fixture(async f => {
    const id = randomUUID(), hash = "a".repeat(64), key = randomUUID();
    const row = { ...identity(f.grant, id, hash, 12), upload: { url: `${f.grant.origin}${REMOTE_STORAGE_PREFIX}/workspaces/${f.grant.workspaceId}/delegations/${f.grant.delegationId}/objects/${id}/upload`,
      method: "PUT", expires_at: new Date(f.now + 30_000).toISOString(), headers: { [REMOTE_STORAGE_TOKEN_HEADER]: "x".repeat(43), "Content-Type": "application/octet-stream", "Content-Length": "12" } } };
    f.setReply(row);
    const operation = { operation: "prepare", idempotencyKey: key, sha256: hash, sizeBytes: 12 };
    expect((await f.broker.request(f.token, operation)).status).toBe(200);
    expect(f.calls.every(c => c.init.method !== "PUT")).toBeTrue();
    f.setReply({ ...row, upload: { ...row.upload, expires_at: new Date(f.now + 63_000).toISOString() } });
    expect((await f.broker.request(f.token, operation)).status).toBe(200);
    for (const bad of [
      { ...row, workspace_id: randomUUID() }, { ...row, sha256_hex: "b".repeat(64) },
      { ...row, upload: { ...row.upload, url: "https://foreign.example/upload" } },
      { ...row, upload: { ...row.upload, headers: { ...row.upload.headers, Authorization: "secret" } } },
      { ...row, upload: { ...row.upload, headers: { ...row.upload.headers, "Content-Length": "100" } } },
      { ...row, upload: { ...row.upload, expires_at: new Date(f.now + 90_000).toISOString() } },
    ]) {
      f.setReply(bad);
      await expect(f.broker.request(f.token, operation)).rejects.toMatchObject({ status: 502 });
    }
  }));
  test("historical prepare receipts and grant-scoped recovery cursors validate without current freshness", () => fixture(async f => {
    const id = randomUUID(), hash = "c".repeat(64), key = randomUUID();
    const row = { ...identity(f.grant, id, hash, 8), upload: { url: `${f.grant.origin}${REMOTE_STORAGE_PREFIX}/workspaces/${f.grant.workspaceId}/delegations/${f.grant.delegationId}/objects/${id}/upload`,
      method: "PUT", expires_at: new Date(f.now + 30_000).toISOString(), headers: { [REMOTE_STORAGE_TOKEN_HEADER]: "x".repeat(43), "Content-Type": "application/octet-stream", "Content-Length": "8" } } };
    f.setReply(row);
    await f.broker.request(f.token, { operation: "prepare", idempotencyKey: key, sha256: hash, sizeBytes: 8 });
    const prepared = f.calls.at(-1)!;
    const event = JSON.parse(Buffer.from(new Headers(prepared.init.headers).get("Authorization")!.slice(6), "base64").toString());
    const receipt = { event, body: String(prepared.init.body), accepted_at: new Date(f.now).toISOString() };
    f.setTime(f.now + 120_000);
    f.grants[0] = { ...f.grant, revision: "2" };
    const token = f.broker.issue(f.grant.appId)!.token;
    f.setReply({ ...identity(f.grant, id, hash, 8, "complete"), publisher_receipt: receipt });
    const read = await f.broker.request(token, { operation: "status", objectId: id });
    expect((await read.json() as any).publisher_receipt.event.id).toBe(event.id);
    f.setReply({ ...identity(f.grant, id, hash, 8, "complete"), publisher_receipt: { ...receipt, body: receipt.body + " " } });
    await expect(f.broker.request(token, { operation: "status", objectId: id })).rejects.toMatchObject({ code: "storage_response_invalid" });
    const cursor = Buffer.from(JSON.stringify({ w: f.grant.workspaceId, d: f.grant.delegationId, t: new Date(0).toISOString(), id })).toString("base64url");
    const compact = { object_id: id, state: "complete", size_bytes: 8, sha256_hex: hash, verified_at: new Date(f.now).toISOString() };
    f.setReply({ protocol: REMOTE_STORAGE_PROTOCOL, service_npub: f.grant.serviceNpub, workspace_id: f.grant.workspaceId,
      delegation_id: f.grant.delegationId, installation_id: f.grant.installationId, objects: [compact], next_cursor: null });
    expect((await (await f.broker.request(token, { operation: "status", cursor })).json() as any).objects).toEqual([compact]);
    await expect(f.broker.request(token, { operation: "status", cursor, objectId: id })).rejects.toBeInstanceOf(Error);
  }));
  test("only four exact operations, no body bytes, workspace, URL, headers or method injection", () => fixture(async f => {
    for (const value of [{ operation: "status", objectId: null }, { operation: "status", objectId: "" },
      { operation: "status", workspaceId: randomUUID() }, { operation: "status", url: "https://elsewhere" },
      { operation: "prepare", idempotencyKey: randomUUID(), sha256: "a".repeat(64), sizeBytes: 65 },
      { operation: "PUT", body: "blob" }, { operation: "complete", objectId: "../../storage" }]) {
      await expect(f.broker.request(f.token, value)).rejects.toBeInstanceOf(Error);
    }
    expect(f.calls).toHaveLength(0);
  }));
  test("service pin, descriptor and redirects fail before signing any control mutation", () => fixture(async f => {
    f.setHealth({ service_npub: f.grant.appNpub });
    await expect(f.broker.request(f.token, { operation: "status" })).rejects.toMatchObject({ code: "storage_service_identity_mismatch" });
    f.setHealth({ service_npub: f.grant.serviceNpub }, 302);
    await expect(f.broker.request(f.token, { operation: "status" })).rejects.toMatchObject({ code: "storage_redirect_denied" });
    f.setHealth({ service_npub: f.grant.serviceNpub }); f.setDescriptor({ protocol: "generic-storage" });
    await expect(f.broker.request(f.token, { operation: "status" })).rejects.toMatchObject({ code: "storage_delegation_unsupported" });
    expect(f.calls.every(call => !new Headers(call.init.headers).has("Authorization"))).toBeTrue();
  }));
  test("revocation, grant changes, signer reassignment and forbidden principal are checked each request", () => fixture(async f => {
    f.setForbidden(true);
    await expect(f.broker.request(f.token, { operation: "status" })).rejects.toMatchObject({ code: "storage_signer_not_isolated" });
    f.setForbidden(false);
    f.grants[0] = { ...f.grant, revision: "2" };
    await expect(f.broker.request(f.token, { operation: "status" })).rejects.toMatchObject({ code: "storage_grant_revoked" });
    f.grants[0] = f.grant;
    f.store.update(f.grant.installationId, { recordState: "archived" });
    await expect(f.broker.request(f.token, { operation: "status" })).rejects.toMatchObject({ code: "storage_installation_invalid" });
    expect(f.calls).toHaveLength(0);
  }));
  test("per-start runtime renews, stop invalidates, host restart cannot reuse token", () => fixture(async f => {
    const runtime = issueRemoteStorageRuntime(f.grant.appId, 3600, f.broker);
    expect(runtime.WAPP_REMOTE_STORAGE_CAPABILITY).not.toBe(f.token);
    await expect(f.broker.request(f.token, { operation: "status" })).rejects.toMatchObject({ code: "capability_invalid" });
    expect((await f.broker.request(runtime.WAPP_REMOTE_STORAGE_CAPABILITY!, { operation: "status" })).status).toBe(200);
    f.broker.revokeApp(f.grant.appId);
    await expect(f.broker.request(runtime.WAPP_REMOTE_STORAGE_CAPABILITY!, { operation: "status" })).rejects.toMatchObject({ code: "capability_invalid" });
    expect(issueRemoteStorageRuntime("unconfigured", 3600, f.broker)).toEqual({});
    f.setTime(f.now + 4_000_000);
    expect(() => f.broker.issue(f.grant.appId)).toThrow("storage_grant_expired");
  }));
  test("credits/conflict/denied remain typed and destination secrets never echo", () => fixture(async f => {
    for (const [status, code, expected] of [[402, "storage_credits_required", "storage_credits_required"],
      [409, "storage_budget_exhausted", "storage_budget_exhausted"], [403, "anything", "storage_delegation_denied"],
      [500, "secret signed URL", "storage_destination_rejected"]] as const) {
      f.setReply({ error: code, secret: "Nostr hidden" }, status);
      await expect(f.broker.request(f.token, { operation: "status" })).rejects.toMatchObject({ code: expected });
    }
  }));
  test("real loopback peer required, absent grant returns404, invalid token tells managed restart", () => fixture(async f => {
    const url = new URL(`http://127.0.0.1:3600${REMOTE_STORAGE_BROKER_PATH}`);
    const request = () => new Request(url, { method: "POST", headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" }, body: '{"operation":"status"}' });
    for (const peer of [null, { address: "203.0.113.1" }]) expect((await handleWappRemoteStorageRoute({ request: request(), url, peer, broker: f.broker }))!.status).toBe(403);
    expect((await handleWappRemoteStorageRoute({ request: request(), url: new URL(`https://public.example${REMOTE_STORAGE_BROKER_PATH}`), peer: { address: "127.0.0.1" }, broker: f.broker }))!.status).toBe(403);
    f.broker.revokeApp(f.grant.appId);
    const invalid = (await handleWappRemoteStorageRoute({ request: request(), url, peer: { address: "127.0.0.1" }, broker: f.broker }))!;
    expect(await invalid.json()).toMatchObject({ error: "capability_invalid", action: "managed_restart_required" });
    f.grants.length = 0;
    expect((await handleWappRemoteStorageRoute({ request: request(), url, peer: { address: "127.0.0.1" }, broker: f.broker }))!.status).toBe(404);
  }));
  test("validates configuration with explicit consent and no origin/path fallback", () => fixture(async f => {
    expect(parseRemoteStorageGrants({ version: 1, grants: [f.grant] })).toHaveLength(1);
    expect(storageIdentityRotationBlocked(f.grant.installationId, [f.grant])).toBeTrue();
    expect(storageIdentityRotationBlocked("foreign", [f.grant])).toBeFalse();
    for (const patch of [{ origin: "http://destination.example" }, { origin: "https://destination.example/extra" },
      { billing: undefined }, { appNpub: f.grant.ownerNpub }, { workspaceId: "first-workspace" }, { agentProfileId: "fallback" }]) {
      expect(() => parseRemoteStorageGrants({ version: 1, grants: [{ ...f.grant, ...patch }] })).toThrow("storage_config_invalid");
    }
  }));
  test("bounded control reader cancels oversized and stalled responses", async () => {
    await expect(readStorageJson(Response.json({ data: "x".repeat(17_000) }), AbortSignal.timeout(100))).rejects.toMatchObject({ code: "storage_control_too_large" });
    await expect(readStorageJson(new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "application/json" } }), AbortSignal.timeout(10))).rejects.toMatchObject({ code: "storage_timeout" });
  });
});
