import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import type { RequestAuthContext } from "../auth/request-context.ts";
import { AgentDefinitionStore } from "../agent-chat/agent-definition-store.ts";
import { WorkspaceSubscriptionManager } from "../agent-chat/subscription-runtime.ts";
import { BotKeyStore } from "../identity/bot-key-store.ts";
import { BrokerKeyVault } from "../signing/broker-key-vault.ts";
import { handleAgentChatApi, type AgentChatApiContext } from "./agent-chat-routes.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "export-fixture-"));
  const store = new BotKeyStore(join(root, "test.sqlite"));
  const agents = new AgentDefinitionStore(join(root, "test.sqlite"));
  const vault = new BrokerKeyVault({ dataDir: root, masterKeyPath: join(root, "master.key") });
  cleanup.push(() => { vault.destroy(); rmSync(root, { recursive: true, force: true }); });
  const secret = generateSecretKey();
  const owner = nip19.npubEncode(getPublicKey(secret));
  secret.fill(0);
  const manager = new WorkspaceSubscriptionManager({ agentStore: agents, botKeyStore: store, brokerKeyVault: vault });
  const auth: RequestAuthContext = {
    npub: owner, actorNpub: owner, signerNpub: owner, authMethod: "session",
    session: { npub: owner, nonce: "fixture", issuedAt: Date.now(), expiresAt: Date.now() + 10000 },
  };
  let reads = 0;
  const ctx: AgentChatApiContext = {
    publishAgentProfile: async () => ({ published: 1 }),
    manager, adminNpub: owner, sharedAgentDispatch: true,
    isAdminContext: a => a.npub === owner, isApprovedContext: () => true,
    keyExport: { store, vault: {
      has: r => vault.has(r),
      withKey: (r, fn) => { reads++; return vault.withKey(r, fn); },
    }, isBotNpub: n => Boolean(store.getActiveKeyForBotNpub(n) || agents.getByBotNpub(n)) },
  };
  for (const profileId of ["first", "second"]) {
    const req = new Request("http://localhost/api/agent-chat/profiles", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId, label: profileId, workingDirectory: "/tmp", harness: "codex", workspaceOwnerNpub: owner }),
    });
    const response = await handleAgentChatApi(req, new URL(req.url), "POST", auth, ctx);
    expect(response?.status).toBe(201);
  }
  const first = agents.getByAgentId("first")!;
  const second = agents.getByAgentId("second")!;
  async function call(a: RequestAuthContext = auth, body: unknown = {
    confirmation: { profileId: "second", currentNpub: second.botNpub, acknowledged: true },
  }, options: { origin?: string; method?: string; path?: string } = {}) {
    const method = options.method ?? "POST";
    const req = new Request(`http://localhost/api/agent-chat/profiles/${options.path ?? 'second/export-nsec'}`, {
      method, headers: { "content-type": "application/json", origin: options.origin ?? "http://localhost" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
    return (await handleAgentChatApi(req, new URL(req.url), method as "POST", a, ctx))!;
  }
  return { store, agents, vault, auth, ctx, first, second, call, reads: () => reads };
}

function assertNoStore(response: Response) {
  expect(response.headers.get("cache-control")).toContain("no-store");
}

describe("human administrator bot key export (disposable fixtures only)", () => {
  test("exports selected current vault identity without changing keys or ordinary metadata", async () => {
    const f = await fixture();
    const before = JSON.stringify(f.store.listActiveKeys());
    const response = await f.call();
    expect(response.status).toBe(200);
    assertNoStore(response);
    const result = await response.json();
    const decoded = nip19.decode(result.nsec);
    expect(decoded.type === "nsec").toBe(true);
    if (decoded.type !== "nsec") throw new Error("Expected fixture key");
    const matches = nip19.npubEncode(getPublicKey(decoded.data)) === f.second.botNpub;
    decoded.data.fill(0);
    expect(matches).toBe(true);
    expect(result.profileId).toBe("second");
    expect(result.botNpub === f.first.botNpub).toBe(false);
    expect(JSON.stringify(f.store.listActiveKeys()) === before).toBe(true);
    const req = new Request("http://localhost/api/agent-chat/agents");
    const metadata = await handleAgentChatApi(req, new URL(req.url), "GET", f.auth, f.ctx);
    const json = await metadata!.json();
    expect(json.permissions.canExportNsec).toBe(true);
    expect(JSON.stringify(json).includes(result.nsec)).toBe(false);
    expect(JSON.stringify(json)).not.toMatch(/nsec1|encryptedEscrow|encryptedToUser|privateKey/);
    result.nsec = null;
  });

  test("rejects anonymous, approved non-admin, bot, NIP98, broker and delegated callers before vault reads", async () => {
    const f = await fixture();
    const cases: RequestAuthContext[] = [
      { npub: null, session: null },
      { ...f.auth, npub: f.first.botNpub, actorNpub: f.first.botNpub, signerNpub: f.first.botNpub, session: { ...f.auth.session!, npub: f.first.botNpub } },
      { ...f.auth, npub: f.second.botNpub, session: null, authMethod: "nip98", delegatedByBot: true },
      { ...f.auth, session: null, authMethod: "nip98" },
      { ...f.auth, capabilitySessionId: "fixture-session" },
      { ...f.auth, delegatedByBot: true },
      { ...f.auth, delegatedOwnerNpub: f.auth.npub },
      { ...f.auth, actorNpub: f.first.botNpub },
      { ...f.auth, error: "invalid auth" },
    ];
    for (const auth of cases) {
      const response = await f.call(auth);
      expect([401, 403]).toContain(response.status);
      assertNoStore(response);
    }
    f.ctx.isAdminContext = () => true;
    const botAuth = { ...f.auth, npub: f.first.botNpub, actorNpub: f.first.botNpub, signerNpub: f.first.botNpub, session: { ...f.auth.session!, npub: f.first.botNpub } };
    expect((await f.call(botAuth)).status).toBe(403);
    f.ctx.isAdminContext = () => false;
    expect((await f.call()).status).toBe(403);
    f.ctx.isAdminContext = undefined;
    expect((await f.call()).status).toBe(403);
    expect(f.reads()).toBe(0);
  });

  test("rejects absent, mismatched, stale confirmation, cross-origin and GET without key access", async () => {
    const f = await fixture();
    for (const body of [null, {}, { confirmation: { profileId: "second", currentNpub: f.second.botNpub } },
      { confirmation: { profileId: "first", currentNpub: f.second.botNpub, acknowledged: true } },
      { confirmation: { profileId: "second", currentNpub: f.first.botNpub, acknowledged: true } }]) {
      const response = await f.call(f.auth, body);
      expect([400, 409]).toContain(response.status);
      assertNoStore(response);
    }
    expect((await f.call(f.auth, undefined, { origin: "https://other.example" })).status).toBe(403);
    expect((await f.call(f.auth, undefined, { method: "GET" })).status).toBe(405);
    expect((await f.call(f.auth, { confirmation: { profileId: "missing", currentNpub: f.second.botNpub, acknowledged: true } }, { path: "missing/export-nsec" })).status).toBe(404);
    expect(f.reads()).toBe(0);
  });

  test("ordinary metadata exposes no export permission for approved non-admins or bots", async () => {
    const f = await fixture();
    const req = new Request("http://localhost/api/agent-chat/agents");
    for (const auth of [
      { ...f.auth, capabilitySessionId: "broker-fixture" },
      { ...f.auth, session: null, authMethod: "nip98" as const },
    ]) {
      const response = await handleAgentChatApi(req, new URL(req.url), "GET", auth, f.ctx);
      expect((await response!.json()).permissions.canExportNsec).toBe(false);
    }
    f.ctx.isAdminContext = () => false;
    const response = await handleAgentChatApi(req, new URL(req.url), "GET", f.auth, f.ctx);
    const metadata = await response!.json();
    expect(metadata.permissions.canManage).toBe(true);
    expect(metadata.permissions.canExportNsec).toBe(false);
  });

  test("rejects an identity rebound during vault access", async () => {
    const f = await fixture();
    const originalGet = f.ctx.manager.getAgentForManager.bind(f.ctx.manager);
    f.ctx.keyExport!.vault = { has: () => true, withKey: (record, operation) => f.vault.withKey(record, secret => {
      f.ctx.manager.getAgentForManager = () => null;
      return operation(secret);
    }) };
    expect((await f.call()).status).toBe(409);
    f.ctx.manager.getAgentForManager = originalGet;
  });

  test("fails honestly for missing/external custody and sanitizes vault failures", async () => {
    const f = await fixture();
    const record = f.store.getActiveKeyForBotNpub(f.second.botNpub)!;
    await f.vault.remove(record);
    const response = await f.call();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("external or unprovisioned");
    expect(f.reads()).toBe(0);
    f.ctx.keyExport!.vault = { has: () => true, withKey: async () => { throw new Error("sensitive fixture error"); } };
    const failed = await f.call();
    expect(failed.status).toBe(409);
    expect((await failed.text()).includes("sensitive fixture error")).toBe(false);
  });
});
