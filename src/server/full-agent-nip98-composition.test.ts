import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";
import type { SessionSnapshot } from "../agents/process-manager";
import type { RequestAuthContext } from "../auth/request-context";
import { Nip98ReplayCache, verifyNip98Request } from "../auth/nip98-verifier";
import { BackendConnectionStore } from "../agent-chat/backend-connection-store";
import { callCapabilityBrokerResponse } from "../mcp/capability-client";
import { AgentSigningModeSettings } from "../signing/agent-signing-mode-settings";
import { CapabilityBroker } from "../signing/capability-broker";
import { createLiveAdminSigningTargets } from "../signing/configured-tower-signing-targets";
import { SessionCapabilityIssuer } from "../signing/session-capability-issuer";
import { FileSigningPolicyStore, SigningPolicyRegistry } from "../signing/signing-policy-registry";
import { InstanceSettingsStore } from "../storage/instance-settings-store";
import { handleSigningPolicyApi } from "./signing-policy-routes";

const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
let previousCapability: string | undefined;
beforeEach(() => { previousCapability = process.env.WINGMAN_CAPABILITY; });
afterEach(() => {
  servers.splice(0).forEach(server => server.stop(true));
  if (previousCapability === undefined) delete process.env.WINGMAN_CAPABILITY;
  else process.env.WINGMAN_CAPABILITY = previousCapability;
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

test("saved Full Agent mode is adopted by a running client without private connection grants", async () => {
  const root = mkdtempSync(join(tmpdir(), "full-agent-composition-"));
  roots.push(root);
  const origin = "https://autopilot.example";
  const target = "https://private-tower.example/custom/resource?exact=1";
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const botNpub = nip19.npubEncode(pubkey);
  const ownerNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
  const record = { id: "bot", userNpub: ownerNpub, botNpub, botPubkeyHex: pubkey, displayName: "Bot",
    encryptedToUser: "fixture", encryptedEscrow: "fixture", escrowUuid: "fixture", isActive: 1 as const,
    createdAt: "2026-01-01", updatedAt: "2026-01-01" };
  let session = { id: crypto.randomUUID(), npub: ownerNpub, status: "running", metadata: {} } as SessionSnapshot;
  const manager = {
    getSession: (id: string) => id === session.id ? session : undefined,
    bindSessionCapabilityIdentity: (_id: string, bot: string, profile: string) => {
      session = { ...session, metadata: { ...session.metadata, agentProfileId: profile, agentChatBotNpub: bot } };
      return session;
    },
  };
  const settingsPath = join(root, "settings.sqlite");
  const settings = new AgentSigningModeSettings(new InstanceSettingsStore(settingsPath));
  const connections = new BackendConnectionStore(join(root, "connections.sqlite"));
  connections.save(connections.createDefault({ managedByNpub: ownerNpub,
    backendBaseUrl: new URL(target).origin, serviceNpub: botNpub }));
  expect(connections.listAvailableForManagerNpub(botNpub)).toHaveLength(0);
  const broker = new CapabilityBroker({
    getSession: manager.getSession,
    botKeyStore: { getActiveKeyForUser: () => record, getActiveKeyForBotNpub: () => record },
    keyVault: { withKey: async (_record, operation) => operation(new Uint8Array(secret)) },
    liveNip98Targets: createLiveAdminSigningTargets({ autopilotUrl: origin,
      isAdminNpub: npub => npub === botNpub,
      listAvailableConnections: npub => connections.listAvailableForManagerNpub(npub) }),
  });
  const registry = new SigningPolicyRegistry(new FileSigningPolicyStore(join(root, "policies.json")), {
    forgejoCompletionUrl: "https://tower.example/api/v4/git/oidc/authorize/complete",
  });
  const profile = { agentId: "builder", botNpub, enabled: true };
  registry.create({
    id: "context-read", name: "Context read", description: "Additive profile-local context read", enabled: true,
    operations: ["nip98.sign"], eventKinds: [27235], nostrKindRules: [],
    nip98Targets: [{ origin, methods: ["GET"], exactPaths: [], pathPrefixes: ["/context"], requireBodyHash: false }],
    assignments: { profileIds: [profile.agentId], workspaceIds: [] },
  }, ownerNpub);
  const issuer = new SessionCapabilityIssuer({ broker, registry, getManager: () => manager,
    sharedAgentDispatch: false, adminNpub: null, towerUrl: "https://tower.example", autopilotUrl: origin,
    getSigningMode: () => settings.getMode(), listProfiles: () => [profile], getDefaultProfile: () => profile,
    getActiveByBotNpub: () => record, ensureProvisioned: () => {}, listTowerUrls: () => [],
  });
  const initial = issuer.issue({ sessionId: session.id, ownerNpub });
  const paths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    paths.push(url.pathname);
    if (url.pathname === "/api/admin/signing-policies/mode") {
      return (await handleSigningPolicyApi(request, url, "PUT", { npub: ownerNpub } as RequestAuthContext, {
        registry, listCapabilities: () => broker.listActiveCapabilities(), getActiveMode: () => settings.snapshot(),
        setActiveMode: (value, actor) => settings.setMode(value, actor),
        buildBaselinePolicy: () => { throw new Error("Inventory not requested"); },
        reissueSessionCapability: id => issuer.reissue(id), ensureApiAccess: async () => null,
        AccessActions: { SystemManage: "system:manage" },
      }))!;
    }
    return (await broker.handle(request, url, "POST")) ?? new Response("Not found", { status: 404 });
  } });
  servers.push(server);
  const context = { wingmanUrl: server.url.origin, sessionId: session.id, capabilityToken: initial.token };
  const sign = (url = target, method = "PATCH", bodyHash?: string) => callCapabilityBrokerResponse(
    "/api/mcp/capabilities/nip98", { url, method, bodyHash }, context);
  expect((await sign()).status).toBe(403);
  const selectMode = async (mode: string) => {
    return fetch(new URL("/api/admin/signing-policies/mode", server.url), { method: "PUT",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
  };
  const selected = await selectMode("full-agent");
  expect(selected.status).toBe(200);
  const result = await selected.json();
  expect(result.sessions[0]).toMatchObject({ status: "replacement-issued", restartRequired: false });
  expect(JSON.stringify(result)).not.toContain(initial.token);
  expect(result.sessions[0].capability.token).toBeUndefined();
  expect(new AgentSigningModeSettings(new InstanceSettingsStore(settingsPath)).getMode()).toBe("full-agent");
  const body = JSON.stringify({ exact: "body bytes" });
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const signed = await sign(target, "PATCH", bodyHash);
  expect(signed.status).toBe(200);
  expect(paths).toContain("/api/mcp/capabilities/reissue-adopt");
  expect(broker.listActiveCapabilities()[0]?.policyMode).toBe("full-agent");
  expect(broker.listActiveCapabilities()[0]?.policyRefs).toContainEqual({ id: "context-read", revision: 1 });
  const { token: authorization } = await signed.json();
  const event = JSON.parse(Buffer.from(authorization.slice(6), "base64").toString());
  expect(verifyEvent(event)).toBe(true);
  expect(event.pubkey).toBe(pubkey);
  expect(event.tags).toContainEqual(["u", target]);
  expect(event.tags).toContainEqual(["method", "PATCH"]);
  expect(event.tags).toContainEqual(["payload", bodyHash]);
  const replayCache = new Nip98ReplayCache();
  const verify = (url = target, method = "PATCH", bytes = body) => verifyNip98Request({
    request: new Request(url, { method, body: bytes, headers: { authorization } }), requestUrl: new URL(url),
    configuredBaseUrl: new URL(target).origin, replayCache,
  });
  expect(await verify(target + "0")).toBeNull();
  expect(await verify(target, "POST")).toBeNull();
  expect(await verify(target, "PATCH", body + " ")).toBeNull();
  expect((await verify())?.signerNpub).toBe(botNpub);
  expect(await verify()).toBeNull();
  expect((await sign("https://unconfigured.example/other/path", "DELETE")).status).toBe(200);
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    expect((await sign("https://unconfigured.example/other/path", method)).status).toBe(200);
  }
  expect((await callCapabilityBrokerResponse("/api/mcp/capabilities/nostr-event", {
    event: { kind: 27235, content: "", tags: [["u", target], ["method", "GET"]] },
  }, context)).status).toBe(403);
  expect((await sign(`${origin}/api/sessions/another-session/queue`, "GET")).status).toBe(403);
  expect(connections.listAvailableForManagerNpub(botNpub)).toHaveLength(0);
  expect((await selectMode("full-nostr")).status).toBe(200);
  expect((await sign()).status).toBe(403);
  expect((await selectMode("standard-agent")).status).toBe(200);
  expect((await sign()).status).toBe(403);
});
