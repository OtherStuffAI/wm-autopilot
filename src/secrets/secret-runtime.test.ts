import { secretAuthorityFromAuth } from "./secret-authority";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";
import { SecretStore } from "./secret-store";
import { configureSecretRuntime, executeSecretPipelineFunction, pipelineSecretConsumer, secretPipelineFunctions } from "./secret-runtime";
import { PipelineStore } from "../pipelines/pipeline-store";
import { runDeclarativePipeline } from "../pipelines/pipeline-runner";
import type { PipelineDefinitionRecord } from "../pipelines/pipeline-loader";
import { CapabilityBroker } from "../signing/capability-broker";
import type { SessionSnapshot } from "../agents/process-manager";
import type { BotKeyRecord } from "../identity/bot-key-store";
import { deniedPolicy } from "./secret-policy";
import { handleSecretRoutes } from "./secret-routes";

const key = generateSecretKey();
const botKey = generateSecretKey();
const owner = nip19.npubEncode(getPublicKey(key));
const bot = nip19.npubEncode(getPublicKey(botKey));
const event = { kind: 1, content: "Unattended synthetic note", tags: [] };
const policy = { ...deniedPolicy(), identities: [owner, bot],
  pipelines: { enabled: true, mode: "selected" as const, ids: ["stable-one"] },
  agents: { enabled: true, mode: "selected" as const, ids: [bot] },
  kindRules: [{ kind: 1, maxContentBytes: 128, maxTags: 0, maxTagBytes: 0, allowedTagNames: [] }] };
const definition: PipelineDefinitionRecord = { id: "stable-one", slug: "test", name: "test", scope: "user", ownerAlias: "synthetic", path: "/synthetic-test.json", spec: { name: "test", steps: [] } };
let dir: string; let secrets: SecretStore; let pipelines: PipelineStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wm-secret-runtime-")); secrets = new SecretStore(join(dir, "secrets.db"), join(dir, "master.key")); pipelines = new PipelineStore(join(dir, "pipelines.db")); configureSecretRuntime(secrets); });
afterEach(() => { secrets.close(); rmSync(dir, { recursive: true, force: true }); });
function create(exportAllowed = false, ordinary = false, workspace = "local") {
  return secrets.create(owner, workspace, { label: "synthetic", type: ordinary ? "secret" : "nostr", value: ordinary ? "synthetic-return-token" : nip19.nsecEncode(key), policy: { ...policy, allowExport: exportAllowed } });
}
function makeRun(id = "stable-one") {
  const run = pipelines.createRun({ definitionId: id, name: "synthetic", ownerNpub: owner, ownerAlias: "synthetic", scope: "user", input: {} });
  pipelines.composition.pin(run.id, { ...definition, id }, { secretAuthority: { principalNpub: owner, workspaceId: "local" } }); return run;
}
test("real declarative runner signs unattended and retains only opaque refs/signed event", async () => {
  const secret = create();
  const run = await runDeclarativePipeline({ store: pipelines, definition: { ...definition, spec: { name: "test", steps: [{ name: "sign", type: "code", function: "secrets.signNostr", assign: "$.signed", input: { value: { credentialRef: secret.id, event } }, display: { in: [{ label: "Credential", path: "$.credentialRef", format: "text" }], out: [{ label: "Signed event", path: "$.event", format: "json" }] } }] } },
    secretAuthority: { principalNpub: owner, workspaceId: "local" }, registry: secretPipelineFunctions, sessionApiContext: {} as never, input: {}, ownerNpub: owner, ownerAlias: "synthetic", callbackOrigin: "http://localhost" });
  expect(run.status).toBe("ok"); expect(verifyEvent((run.result?.signed as any).event)).toBe(true);
  const bytes = readFileSync(join(dir, "pipelines.db")).toString("utf8");
  expect(bytes).not.toContain(nip19.nsecEncode(key)); expect(bytes).not.toContain(Buffer.from(key).toString("hex"));
});
test("asserting another pipeline identity or using stale/unpinned run fails", async () => {
  const secret = create(); const run = makeRun("wrong-pipeline");
  await expect(executeSecretPipelineFunction("secrets.signNostr", { credentialRef: secret.id, event }, pipelines, run.id)).rejects.toThrow("secret_use_denied");
  const good = makeRun();
  await expect(executeSecretPipelineFunction("secrets.signNostr", { credentialRef: secret.id, event, pipelineId: "stable-one" }, pipelines, good.id)).rejects.toThrow("asserted_binding_denied");
  pipelines.completeRun(good.id, "cancelled", null);
  expect(() => pipelineSecretConsumer(pipelines, good.id)).toThrow("stale_pipeline_binding");
});
test("missing authority cannot inherit an asserted owner or workspace from inputs", () => {
  const run = pipelines.createRun({ definitionId: definition.id, name: "test", ownerNpub: owner, ownerAlias: "synthetic", scope: "user", input: { ownerNpub: owner, workspaceId: "spoof" } });
  pipelines.composition.pin(run.id, definition, {});
  expect(() => pipelineSecretConsumer(pipelines, run.id)).toThrow("pipeline_secret_authority_missing");
});
test("bot-initiated pipelines use the pinned bot principal, never owner fallback", () => {
  const run = pipelines.createRun({ definitionId: definition.id, name: "test", ownerNpub: owner, ownerAlias: "synthetic", scope: "user", input: { identityNpub: owner } });
  pipelines.composition.pin(run.id, definition, { secretAuthority: { principalNpub: bot, workspaceId: "workspace-from-server" } });
  expect(pipelineSecretConsumer(pipelines, run.id)).toEqual({ ownerNpub: owner, identityNpub: bot, workspaceId: "workspace-from-server", context: "pipeline", contextId: definition.id });
});
test("bot pipeline consumption needs an explicit bot grant even when owner is granted", async () => {
  const secret = secrets.create(owner, "local", { label: "owner grant", type: "nostr", value: nip19.nsecEncode(key), policy: { ...policy, identities: [owner] } });
  const run = pipelines.createRun({ definitionId: definition.id, name: "bot run", ownerNpub: owner, ownerAlias: "synthetic", scope: "user", input: {} });
  pipelines.composition.pin(run.id, definition, { secretAuthority: { principalNpub: bot, workspaceId: "local" } });
  await expect(executeSecretPipelineFunction("secrets.signNostr", { credentialRef: secret.id, event }, pipelines, run.id)).rejects.toThrow("secret_use_denied");
  secrets.update(owner, "local", secret.id, { revision: secret.revision, policy: { ...policy, identities: [bot] } });
  const result = await executeSecretPipelineFunction("secrets.signNostr", { credentialRef: secret.id, event }, pipelines, run.id);
  expect(verifyEvent(result.event as any)).toBe(true);
});
test("ordinary secrets go only to transient HTTP consumer, never retained echoed body/headers", async () => {
  const secret = create(true, true); const run = makeRun(); let observed = "";
  const result = await executeSecretPipelineFunction("secrets.http", { credentialRef: secret.id, url: "https://synthetic.example/consumer", body: { message: "test" } }, pipelines, run.id, secrets, (async (_url, options) => {
    observed = (options?.headers as Record<string, string>).authorization!;
    return new Response("synthetic-return-token", { status: 200, headers: { "x-echo": "synthetic-return-token" } });
  }) as typeof fetch);
  expect(observed).toBe("Bearer synthetic-return-token"); expect(result).toEqual({ delivered: true, status: 200, credentialRef: secret.id });
  expect(JSON.stringify(pipelines.evidence.sanitize({ echo: "synthetic-return-token" }).value)).not.toContain("synthetic-return-token");
  expect(readFileSync(join(dir, "pipelines.db")).toString("utf8")).not.toContain("synthetic-return-token");
});
function brokerFixture() {
  const record: BotKeyRecord = { id: "synthetic-bot", userNpub: owner, botPubkeyHex: getPublicKey(botKey), botNpub: bot, displayName: "Bot", encryptedToUser: "unused", encryptedEscrow: "unused", escrowUuid: "unused", isActive: 1, createdAt: "", updatedAt: "" };
  const live = { id: "session-one", npub: owner, status: "running", metadata: { agentChatBotNpub: bot, agentChatAgentId: "profile-one" } } as unknown as SessionSnapshot;
  const broker = new CapabilityBroker({ importedSecrets: secrets, getSession: id => id === live.id ? live : null,
    botKeyStore: { getActiveKeyForUser: () => record, getActiveKeyForBotNpub: npub => npub === bot ? record : null }, keyVault: { withKey: async (_record, operation) => operation(botKey) } });
  const issued = broker.issueSessionCapability({ sessionId: live.id, ownerNpub: owner, profileId: "profile-one", botNpub: bot, policy: { operations: ["identity.read"] } as never });
  const call = (body: Record<string, unknown>, token = issued.token) => broker.handle(new Request("http://localhost/api/mcp/capabilities/secrets", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "x-wingman-capability-nonce": crypto.randomUUID(), "content-type": "application/json" }, body: JSON.stringify({ sessionId: live.id, ...body }),
  }), new URL("http://localhost/api/mcp/capabilities/secrets"), "POST");
  return { broker, live, call };
}
test("broker enforces bound bot/session, signing-only denial and revocation", async () => {
  const secret = create(); const { call, live, broker } = brokerFixture();
  const args = { credentialRef: secret.id, operation: "sign", event };
  const response = (await call(args))!; expect(response.status).toBe(200); expect(verifyEvent((await response.json()).event)).toBe(true);
  expect((await call({ ...args, sessionId: "other-session" }))!.status).toBe(403);
  expect((await call({ ...args, agentNpub: owner }))!.status).toBe(403);
  expect((await call({ credentialRef: secret.id, operation: "return" }))!.status).toBe(403);
  live.metadata!.flightdeckWorkspaceId = "another-workspace";
  expect((await call(args))!.status).toBe(403); delete live.metadata!.flightdeckWorkspaceId;
  live.metadata!.agentChatBotNpub = owner;
  expect((await call(args))!.status).toBe(403); live.metadata!.agentChatBotNpub = bot;
  secrets.revoke(owner, "local", secret.id, 1); expect((await call(args))!.status).toBe(403);
  broker.revokeSession(live.id); expect((await call(args))!.status).toBe(403);
});
test("broker export opt-in is usable only with live authority; stopped session denied", async () => {
  const secret = create(true); const { call, live } = brokerFixture();
  expect((await (await call({ credentialRef: secret.id, operation: "return" }))!.json()).value).toBe(nip19.nsecEncode(key));
  live.status = "stopped"; expect((await call({ credentialRef: secret.id, operation: "return" }))!.status).toBe(403);
});
test("management routes use owner authority, authorized workspace and safe CRUD responses", async () => {
  const ctx = { store: secrets, inventory: async () => ({ workspaces: [{ id: "local", label: "Local" }], identities: [], pipelines: [] }) };
  const auth = { npub: owner, actorNpub: owner, session: null };
  const call = (path: string, method = "GET", body?: unknown, context = auth) => handleSecretRoutes(new Request(`http://localhost${path}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) }), new URL(`http://localhost${path}`), context, ctx);
  const response = (await call("/api/secrets", "POST", { label: "synthetic", type: "nostr", value: nip19.nsecEncode(key), policy }))!;
  expect(response.status).toBe(201); const secret = (await response.json()).secret; expect(secret.value).toBeUndefined();
  expect((await call("/api/secrets?workspace=unowned"))!.status).toBe(403);
  expect((await call(`/api/secrets/${secret.id}`, "GET", undefined, { ...auth, npub: bot, actorNpub: bot }))!.status).toBe(404);
  expect((await handleSecretRoutes(new Request("http://localhost/api/secrets"), new URL("http://localhost/api/secrets"), { ...auth, delegatedOwnerNpub: owner }, ctx))!.status).toBe(403);
  expect((await call(`/api/secrets/${secret.id}`, "PUT", { revision: 1, label: "renamed" }))!.status).toBe(200);
  expect((await call(`/api/secrets/${secret.id}`, "DELETE", { revision: 2 }))!.status).toBe(200);
  expect((await call(`/api/secrets/${secret.id}/audit`))!.headers.get("cache-control")).toBe("no-store");
});

test("authenticated delegated actor remains the principal; legacy trigger has no credential authority", () => {
  expect(secretAuthorityFromAuth({ npub: owner, actorNpub: bot, delegatedOwnerNpub: owner, session: null })).toEqual({ principalNpub: bot, workspaceId: "local" });
  expect(secretAuthorityFromAuth({ npub: null, session: null })).toBeUndefined();
  expect(secretAuthorityFromAuth({ npub: owner, delegatedByBot: true, session: null })).toBeUndefined();
});
test("server-pinned authority survives reconstruction and revoked policy remains denied", async () => {
  const record = create(); const run = makeRun();
  pipelines = new PipelineStore(join(dir, "pipelines.db"));
  expect((await executeSecretPipelineFunction("secrets.signNostr", { credentialRef: record.id, event }, pipelines, run.id)).event).toBeDefined();
  secrets.revoke(owner, "local", record.id, 1);
  await expect(executeSecretPipelineFunction("secrets.signNostr", { credentialRef: record.id, event }, pipelines, run.id)).rejects.toThrow("secret_use_denied");
});

test("all-kind imported signing works through bound pipeline and session without changing identity", async () => {
  const secret = secrets.create(owner, "local", { label: "All kinds synthetic", type: "nostr", value: nip19.nsecEncode(generateSecretKey()), policy: { ...policy, kindMode: "all" } });
  const request = { kind: 27235, content: "", tags: [["u", "https://example.test"], ["method", "POST"]] };
  const run = makeRun();
  const signed = await executeSecretPipelineFunction("secrets.signNostr", { credentialRef: secret.id, event: request }, pipelines, run.id);
  expect(verifyEvent(signed.event as never)).toBe(true);
  const { call, live, broker } = brokerFixture();
  const response = (await call({ credentialRef: secret.id, operation: "sign", event: { ...request, kind: 33358, tags: [["custom", "value"]] } }))!;
  expect(response.status).toBe(200); expect(verifyEvent((await response.json()).event)).toBe(true);
  expect(live.metadata!.agentChatBotNpub).toBe(bot);
  expect((await call({ credentialRef: secret.id, operation: "return" }))!.status).toBe(403);
  expect((await call({ credentialRef: secret.id, operation: "sign", event: request, agentNpub: owner }))!.status).toBe(403);
  broker.revokeSession(live.id);
  expect((await call({ credentialRef: secret.id, operation: "sign", event: request }))!.status).toBe(403);
  secrets.revoke(owner, "local", secret.id, secret.revision);
  await expect(executeSecretPipelineFunction("secrets.signNostr", { credentialRef: secret.id, event: request }, pipelines, run.id)).rejects.toThrow("secret_use_denied");
});
