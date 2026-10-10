import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";
import { SecretStore } from "../secrets/secret-store";
import { HostedSiteSigner, type HostedSiteRequest } from "./hosted-site-signer";
import { handleHostedSiteManagement, handleHostedSiteRuntime } from "./hosted-site-routes";
import type { RequestAuthContext } from "../auth/request-context";

const siteKey = generateSecretKey();
const userKey = generateSecretKey();
const owner = nip19.npubEncode(getPublicKey(userKey));
const siteNpub = nip19.npubEncode(getPublicKey(siteKey));
const url = "https://hosted.example/api/v4/flightdeck-pg/hosted/workspaces";
let dir: string; let secrets: SecretStore; let signer: HostedSiteSigner;
let now: number; let appOwner: string | null; let appRoot: string;
let secretId: string; let credential: string; let grantId: string;
let appWait: Promise<void> | undefined;
function input(extraTags: string[][] = []): HostedSiteRequest {
  const payload = JSON.stringify({ workspace_name: "Synthetic signup", idempotency_key: randomUUID(), terms_version: "hosted-usd-v1" });
  const bodyHash = createHash("sha256").update(payload).digest("hex");
  const userEvent = finalizeEvent({ kind: 27235, created_at: now, content: randomUUID(), tags: [["u", url], ["method", "POST"], ["payload", bodyHash], ...extraTags] }, userKey);
  return { appId: "app-one", url, method: "POST", payload, bodyHash, userEventId: userEvent.id, userEvent };
}
beforeEach(async () => {
  now = 1791627000; appOwner = owner; appRoot = "/app/one"; appWait = undefined;
  dir = mkdtempSync(join(tmpdir(), "wm-hosted-test-"));
  secrets = new SecretStore(join(dir, "secrets.db"), join(dir, "master.key"));
  const secret = secrets.create(owner, "local", { type: "nostr", label: "Synthetic site", value: nip19.nsecEncode(siteKey) });
  secretId = secret.id;
  signer = new HostedSiteSigner(join(dir, "grants.db"), secrets, async id => { await appWait; return id === "app-one" ? { ownerNpub: appOwner, root: appRoot } : undefined; }, () => now);
  const result = await signer.register(owner, { workspaceId: "local", appId: "app-one", secretId, secretRevision: 1, siteNpub, url, expiresAt: now + 3600 });
  credential = result.credential; grantId = result.grant.id;
});
afterEach(() => { signer.close(); secrets.close(); rmSync(dir, { recursive: true, force: true }); });
describe("narrow hosted-site authority", () => {
  test("managed registration captures private capability and never returns it", async () => {
    const manageUrl = new URL("http://localhost/api/secrets/hosted-site-grants");
    const response = await handleHostedSiteManagement(new Request(manageUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "local", appId: "app-one", secretId, secretRevision: 1, siteNpub, url, expiresAt: now + 60 }) }), manageUrl, { npub: owner } as RequestAuthContext, signer);
    expect(response?.status).toBe(201);
    const result = await response!.json();
    expect(result.credential).toBeUndefined();
    expect(statSync(result.credentialFile).mode & 0o777).toBe(0o600);
    const captured = readFileSync(result.credentialFile, "utf8").trim();
    expect(captured).toMatch(/^wmhost_v1_/);
    expect(JSON.stringify(result)).not.toContain(captured);
    expect((await signer.readiness(captured, "app-one", url, siteNpub)).ready).toBe(true);
  });
  test("concurrent revoke and expiry during app lookup cannot issue a signature", async () => {
    let release!: () => void;
    appWait = new Promise<void>(resolve => { release = resolve; });
    const pending = signer.attest(credential, input());
    signer.revoke(owner, grantId); release();
    await expect(pending).rejects.toThrow("unauthorized");
    appWait = undefined;
    const next = await signer.register(owner, { workspaceId: "local", appId: "app-one", secretId, secretRevision: 1, siteNpub, url, expiresAt: now + 1 });
    appWait = new Promise<void>(resolve => { release = resolve; });
    const expiring = signer.attest(next.credential, input()); now++; release();
    await expect(expiring).rejects.toThrow("grant_expired");
  });
  test("signs exact proof without granting export and persists replay across reopen", async () => {
    const request = input();
    const event = await signer.attest(credential, request);
    expect(verifyEvent(event)).toBe(true);
    expect(nip19.npubEncode(event.pubkey)).toBe(siteNpub);
    expect(event.tags).toEqual([["u", url], ["method", "POST"], ["payload", request.bodyHash], ["user_event_id", request.userEventId]]);
    expect(secrets.get(owner, "local", secretId).policy.allowExport).toBe(false);
    signer.close();
    signer = new HostedSiteSigner(join(dir, "grants.db"), secrets, async () => ({ ownerNpub: owner, root: appRoot }), () => now);
    await expect(signer.attest(credential, request)).rejects.toThrow("signature_replayed");
    expect(signer.history(owner, grantId).map((row: any) => row.outcome)).toContain("denied");
    expect((await signer.attest(credential, input())).kind).toBe(27235);
  });
  for (const [field, value, code] of [
    ["appId", "app-two", "app_denied"], ["url", "https://evil.example/", "target_denied"],
    ["method", "GET", "method_denied"], ["bodyHash", "0".repeat(64), "payload_hash_mismatch"],
    ["userEventId", "0".repeat(64), "user_proof_invalid"], ["payload", "{}", "payload_hash_mismatch"],
  ]) test(`rejects wrong ${field}`, async () => {
    await expect(signer.attest(credential, { ...input(), [field!]: value })).rejects.toThrow(code);
  });
  test("denies delegated, expired, forged and duplicate-tag user proofs", async () => {
    for (const tags of [[["wm-session-capability", "session"]], [["delegation", "actor"]], [["method", "POST"]]]) {
      await expect(signer.attest(credential, input(tags))).rejects.toThrow("user_proof_invalid");
    }
    const stale = input(); now += 61;
    await expect(signer.attest(credential, stale)).rejects.toThrow("user_proof_invalid");
    const forged = input(); forged.userEvent.sig = "0".repeat(128);
    await expect(signer.attest(credential, forged)).rejects.toThrow("user_proof_invalid");
  });
  test("readiness checks real custody, target, app changes and expiry", async () => {
    expect((await signer.readiness(credential, "app-one", url, siteNpub)).ready).toBe(true);
    await expect(signer.readiness(credential, "app-one", url, owner)).rejects.toThrow("target_denied");
    appRoot = "/replaced";
    await expect(signer.attest(credential, input())).rejects.toThrow("app_denied");
    appRoot = "/app/one"; appOwner = null;
    await expect(signer.attest(credential, input())).rejects.toThrow("app_denied");
    appOwner = owner; now += 3600;
    await expect(signer.readiness(credential, "app-one", url, siteNpub)).rejects.toThrow("grant_expired");
  });
  test("revokes grant and independently revokes or revises underlying custody", async () => {
    signer.revoke(owner, grantId);
    await expect(signer.attest(credential, input())).rejects.toThrow("unauthorized");
    await expect(signer.readiness(credential, "app-one", url, siteNpub)).rejects.toThrow("unauthorized");
    const next = await signer.register(owner, { workspaceId: "local", appId: "app-one", secretId, secretRevision: 1, siteNpub, url, expiresAt: now + 60 });
    secrets.update(owner, "local", secretId, { revision: 1, label: "Revised" });
    await expect(signer.attest(next.credential, input())).rejects.toThrow("site_custody_denied");
    secrets.revoke(owner, "local", secretId, 2);
    await expect(signer.register(owner, { workspaceId: "local", appId: "app-one", secretId, secretRevision: 3, siteNpub, url, expiresAt: now + 60 })).rejects.toThrow("site_custody_denied");
  });
  test("enforces per-user rate across durable requests and concurrent replay", async () => {
    const same = input();
    const results = await Promise.allSettled([signer.attest(credential, same), signer.attest(credential, same)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    for (let i = 1; i < 12; i++) await signer.attest(credential, input());
    await expect(signer.attest(credential, input())).rejects.toThrow("signup_rate_limited");
  });
  test("owner-only registration, exact endpoint and expected site identity", async () => {
    const grant = { workspaceId: "local", appId: "app-one", secretId, secretRevision: 1, siteNpub, url, expiresAt: now + 60 };
    await expect(signer.register(owner, { ...grant, url: "https://hosted.example/other" })).rejects.toThrow("target_denied");
    await expect(signer.register(owner, { ...grant, siteNpub: owner })).rejects.toThrow("site_custody_denied");
    await expect(signer.register(owner, { ...grant, value: "must-not-store" } as any)).rejects.toThrow("invalid_grant");
    await expect(signer.register(siteNpub, grant)).rejects.toThrow("app_denied");
    const manageUrl = new URL("http://localhost/api/secrets/hosted-site-grants");
    const auth = { npub: owner, delegatedByBot: true } as RequestAuthContext;
    expect((await handleHostedSiteManagement(new Request(manageUrl, { method: "POST", body: JSON.stringify(grant) }), manageUrl, auth, signer))?.status).toBe(403);
  });
  test("runtime never accepts a session token or malformed/large payload", async () => {
    const runtimeUrl = new URL("http://localhost/api/internal/signing/hosted-site/attest");
    for (const token of ["session_token", "", credential]) {
      const response = await handleHostedSiteRuntime(new Request(runtimeUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: token === credential ? "x".repeat(16385) : JSON.stringify(input()) }), runtimeUrl, signer);
      expect(response.status).toBe(403);
    }
  });
});
