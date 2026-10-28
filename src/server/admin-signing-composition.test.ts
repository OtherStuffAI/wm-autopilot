import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { CapabilityBroker, buildDefaultAgentCapabilityPolicy, type SessionCapabilityPolicy } from "../signing/capability-broker";
import { liveAdminSigningTargets } from "../signing/admin-signing-targets";
import { ADMIN_API_FAMILIES } from "../signing/admin-signing-policy";
import { resolveNip98AuthContext } from "../auth/nip98-auth";
import { verifyNip98Request, Nip98ReplayCache } from "../auth/nip98-verifier";
import { getRequestContext, type RequestAuthContext } from "../auth/request-context";
import { isInstanceAdmin } from "../auth/admin-authority";
import { getEffectiveOwnerNpub } from "../auth/effective-owner";
import { AccessActions } from "../auth/access-control";
import { createTrustedExecutionRule } from "../auth/trusted-execution";
import { createApiRouteHandler, type ApiRoutesContext } from "./api-routes";
import { SchedulerStore } from "../scheduler/scheduler-store";
import { createSchedulerApiHandler } from "../scheduler/scheduler-api";
import { PipelineStore } from "../pipelines/pipeline-store";
import { WappStore } from "../wapps/wapp-store";
import type { WappsApiContext } from "./wapps-api-routes";
import type { WorkspaceDelegationRecord } from "../storage/workspace-delegation-store";
import type { BotKeyRecord } from "../identity/bot-key-store";
import { nip44Encrypt } from "../nostr/nip44-crypto";
import { sessionBelongsToViewer } from "../sessions/session-ownership";
import type { SessionSnapshot } from "../agents/process-manager";

const origin = "https://autopilot.example";
const anonymous: RequestAuthContext = { npub: null, session: null };
const secret = generateSecretKey();
const pubkey = getPublicKey(secret);
const bot = nip19.npubEncode(pubkey);
const owner = nip19.npubEncode(getPublicKey(generateSecretKey()));
const foreign = nip19.npubEncode(getPublicKey(generateSecretKey()));
let root: string;
let admin = false;
let broker: CapabilityBroker;
let token: string;
let handler: ReturnType<typeof createApiRouteHandler>;
let scheduler: SchedulerStore;
let pipelines: PipelineStore;
let wapps: WappStore;
let verificationCount = 0;
let signingTime = Date.now();
let delegatedScopes: string[] = [];
let previousRoot: string | undefined;
const isAdmin = (npub: string | null | undefined) => npub === owner || (admin && npub === bot);
const session = { id: "session", npub: owner, status: "running" } as SessionSnapshot;
const record = { id: "bot", userNpub: owner, botNpub: bot, botPubkeyHex: pubkey, isActive: 1 } as BotKeyRecord;

async function brokerCall(operation: string, body: Record<string, unknown>, bearer = token): Promise<Response> {
  const url = new URL(`http://localhost/api/mcp/capabilities/${operation}`);
  return (await broker.handle(new Request(url, { method: "POST", headers: {
    authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-wingman-capability-nonce": crypto.randomUUID(),
  }, body: JSON.stringify({ sessionId: "session", ...body }) }), url, "POST"))!;
}
async function sign(path: string, method = "GET", body?: string): Promise<Response> {
  return brokerCall("nip98", { url: `${origin}${path}`, method,
    ...(body ? { bodyHash: createHash("sha256").update(body).digest("hex") } : {}) });
}
async function api(path: string, method = "GET", body?: string): Promise<Response> {
  const signed = await sign(path, method, body);
  if (signed.status !== 200) return signed;
  const { token: authorization } = await signed.json();
  const url = new URL(`${origin}${path}`);
  return handler(new Request(url, { method, headers: { authorization, "content-type": "application/json" },
    ...(body ? { body } : {}) }), url, method as "GET", anonymous);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "admin-signing-composition-"));
  previousRoot = process.env.WINGMEN_PIPELINES_ROOT;
  process.env.WINGMEN_PIPELINES_ROOT = join(root, "definitions");
  admin = false;
  verificationCount = 0;
  signingTime = Date.now();
  delegatedScopes = [];
  broker = new CapabilityBroker({
    botKeyStore: { getActiveKeyForBotNpub: () => record, getActiveKeyForUser: () => record },
    keyVault: { withKey: async (_record, fn) => fn(secret) },
    getSession: () => session,
    isAdminNpub: isAdmin,
    now: () => signingTime,
    liveNip98Targets: input => liveAdminSigningTargets({ ...input, autopilotUrl: origin, isAdminNpub: isAdmin }),
  } as ConstructorParameters<typeof CapabilityBroker>[0]);
  token = broker.issueSessionCapability({ sessionId: session.id, ownerNpub: owner,
    policy: buildDefaultAgentCapabilityPolicy({ towerUrl: "https://tower.example", autopilotUrl: origin, ownerNpub: owner }),
  }).token;
  scheduler = new SchedulerStore(join(root, "scheduler.sqlite"));
  pipelines = new PipelineStore(join(root, "pipelines.sqlite"));
  wapps = new WappStore(join(root, "wapps.sqlite"));
  const delegations = { findActiveDelegation: (target: string, subject: string, scope?: string) =>
    target === owner && subject === bot && (!scope || delegatedScopes.includes(scope)) && delegatedScopes.length
      ? { id: "scoped-grant", ownerNpub: owner, delegateNpub: bot, scopes: delegatedScopes,
        resourceFilters: null, billingMode: "delegate" } as WorkspaceDelegationRecord : null };
  const trusted = createTrustedExecutionRule({ kind: "sessions", isAdminNpub: isAdmin, isApprovedNpub: npub => npub === owner });
  const ensureApiAccess: ApiRoutesContext["ensureApiAccess"] = async (action, request, url, auth) => {
    if (!auth.npub) return Response.json({ error: "auth-required" }, { status: 401 });
    if (action === AccessActions.SessionsManage) {
      const decision = await trusted({ action, request, url, auth });
      return decision && !decision.allowed ? Response.json({ error: decision.reason }, { status: 403 }) : null;
    }
    if (action === AccessActions.SessionsRead && auth.delegateRelationshipId && auth.delegateScopes?.includes("sessions:read")) return null;
    return isInstanceAdmin(auth, isAdmin) ? null : Response.json({ error: "admin-required" }, { status: 403 });
  };
  const replayCache = new Nip98ReplayCache();
  const workspace = (auth = getRequestContext()) => ({ isAdmin: isInstanceAdmin(auth, isAdmin),
    allowedDirectories: [root], defaultDirectory: root, aliasDirectory: null, docsRoot: root, docsRootBoundary: `${root}/` });
  const schedulerApiHandler = createSchedulerApiHandler({ store: scheduler,
    engine: { executeJob: async id => ({ id, triggered: true }), scheduleJob() {}, unscheduleJob() {} } as never,
    getNpub: () => getEffectiveOwnerNpub(getRequestContext()), isAdmin: () => isInstanceAdmin(getRequestContext(), isAdmin),
    getActiveBotOwnerNpub: () => foreign,
  });
  const foreignSession = { ...session, id: "foreign-session", npub: foreign, metadata: {}, name: "Foreign" };
  const custodianSession = { ...foreignSession, npub: owner, id: "custodian-session" };
  const ctx = {
    browserLogHandler: async () => null,
    config: { baseUrl: origin }, resolveWorkspace: workspace, isAppAdminNpub: isAdmin,
    adminUsersApiContext: { adminNpub: null, bootstrapAdminNpubs: [], isAdminNpub: isAdmin,
      identityUserStore: { listUsers: () => [] }, manager: { listSessions: () => [] },
      buildIdentitySummaries: () => [], ensureApiAccess, AccessActions },
    signingPolicyRoutesContext: { getActiveMode: () => ({ mode: "standard-agent" }), listCapabilities: () => [],
      ensureApiAccess, AccessActions },
    billingApiContext: { billingService: { syncTeamMembers() {}, getTeamConfigWithSummary: () => ({ actor: getRequestContext().subjectNpub }) },
      ensureApiAccess, AccessActions },
    instanceSettingsRoutesContext: { service: { previewEnvImport: async () => ({ actor: getRequestContext().subjectNpub }) },
      ensureApiAccess, AccessActions },
    terminalRoutesContext: { pinService: { isConfigured: () => true }, sessions: { checkAvailability: async () => ({ available: true }) },
      config: { cwd: root, shell: "fixture" }, ensureApiAccess, AccessActions },
    buildFeatureFlagsContext: (viewerIsAdmin: boolean) => ({ viewerIsAdmin, ensureApiAccess, AccessActions,
      featureFlagStore: { listFlags: () => [], createFlag: (input: unknown) => input } }),
    featureFlagStore: { getFlag: () => null }, resolveFeatureFlagStateForViewer: () => ({ effectiveState: "on" }),
    ensureApiAccess, AccessActions, schedulerStore: scheduler, schedulerApiHandler,
    sessionApiContext: { isAdminNpub: isAdmin, adminNpub: owner, AccessActions, ensureApiAccess,
      workspaceDelegationStore: delegations, getViewerNormalizedNpub: getEffectiveOwnerNpub,
      sessionBelongsToViewer, serializeSession: (value: unknown) => value,
      manager: { listSessions: () => [foreignSession, custodianSession],
        getSession: (id: string) => id === custodianSession.id ? custodianSession : foreignSession },
    },
    pipelineApiContext: { store: pipelines, isAdminNpub: isAdmin, sessionApiContext: {},
      ensureApiAccess, AccessActions, defaultAgent: "codex" },
    workspaceDelegationStore: delegations,
    buildWappsContext: (auth: RequestAuthContext) => ({ isAdmin: isInstanceAdmin(auth, isAdmin),
      adminNpub: owner, viewerNpub: getEffectiveOwnerNpub(auth), actorNpub: auth.npub, wappStore: wapps,
      ensureApiAccess, AccessActions, appRegistry: { getApp: async () => undefined, listApps: async () => [] },
    }) as unknown as WappsApiContext,
    resolveNip98AuthContext: (request: Request, url: URL, auth: RequestAuthContext) => resolveNip98AuthContext(request, url, auth, {
      lookupBotOwnerNpub: () => owner,
      verifyNip98AuthHeader: async () => {
        verificationCount++;
        const result = await verifyNip98Request({ request, requestUrl: url, configuredBaseUrl: origin, replayCache, now: Math.floor(signingTime / 1000) });
        return result ? { signerNpub: result.signerNpub, capabilitySessionId: broker.verifyNip98SessionBinding(result.event) } : null;
      },
    }),
  } as unknown as ApiRoutesContext;
  handler = createApiRouteHandler(ctx);
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.WINGMEN_PIPELINES_ROOT;
  else process.env.WINGMEN_PIPELINES_ROOT = previousRoot;
  rmSync(root, { force: true, recursive: true });
});

test("existing standard capability signs every admin family as itself and loses added authority on demotion", async () => {
  expect((await sign("/api/admin/users")).status).toBe(403);
  admin = true;
  for (const family of ADMIN_API_FAMILIES) {
    const response = await sign(`/api/${family}/matrix`);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.signedBy).toBe(bot);
  }
  for (const path of ["/api/internal/signing", "/api/mcp/bot-crypto", "/not-api"]) {
    expect((await sign(path)).status).toBe(403);
  }
  expect((await brokerCall("nip98", { url: "https://unrelated.example/api/admin/users", method: "GET" })).status).toBe(403);
  expect((await brokerCall("nip98", { url: "https://tower.example/api/admin/users", method: "GET" })).status).toBe(403);
  admin = false;
  expect((await sign(`/api/owners/${foreign}/wapps`)).status).toBe(403);
});

test("broker/API composition manages cross-owner schedules, triggers, pipelines and WApps with live role checks", async () => {
  const job = scheduler.createJob({ name: "foreign", userNpub: foreign, botNpub: "historical-bot",
    wrappedKeyCiphertext: "fixture", wrappedKeyNonce: "fixture", agent: "codex", workingDirectory: root,
    initialPrompt: "fixture", triggerType: "cron", cronExpression: "* * * * *" });
  const run = pipelines.createRun({ name: "private", definitionId: "private", scope: "user", ownerNpub: foreign, input: {} });
  admin = true;
  const wapp = wapps.create({ id: "foreign-wapp", appId: "app", title: "Original", ownerNpub: foreign,
    createdByNpub: foreign, workspaceOwnerNpub: foreign, scopeId: "scope", allowedNpubs: [foreign], launchUrl: "https://wapp.example" });
  expect((await api(`/api/owners/${foreign}/wapps`)).status).toBe(200);
  expect((await api(`/api/owners/${foreign}/wapps/${wapp.id}`, "PATCH", JSON.stringify({ title: "Managed" }))).status).toBe(200);
  expect(wapps.get(wapp.id)?.ownerNpub).toBe(foreign);
  expect(wapps.get(wapp.id)?.title).toBe("Managed");
  expect((await api(`/api/owners/${foreign}/sessions/foreign-session`)).status).toBe(200);
  expect((await api("/api/sessions/foreign-session")).status).toBe(200);
  expect((await api(`/api/owners/${foreign}/scheduler/jobs`)).status).toBe(200);
  expect((await api(`/api/scheduler/jobs/${job.id}`, "PATCH", JSON.stringify({ name: "managed" }))).status).toBe(200);
  expect(scheduler.getJob(job.id)?.userNpub).toBe(foreign);
  expect(scheduler.getJob(job.id)?.botNpub).toBe("historical-bot");
  expect((await api(`/api/scheduler/jobs/${job.id}/trigger`, "POST")).status).toBe(200);
  expect((await api(`/api/scheduler/jobs/${job.id}/runs`)).status).toBe(200);
  expect((await api(`/api/pipelines/runs/${run.id}`)).status).toBe(200);
  expect((await api(`/api/owners/${foreign}/pipelines/runs/${run.id}`)).status).toBe(200);
  expect((await (await api("/api/pipelines/runs?includeDefinitionMeta=0")).json()).runs).toHaveLength(1);
  // Sign while promoted, then demote before authorization: signing is not a role snapshot.
  const signed = await sign(`/api/scheduler/jobs/${job.id}`, "DELETE");
  const authorization = (await signed.json()).token;
  admin = false;
  const url = new URL(`${origin}/api/scheduler/jobs/${job.id}`);
  expect((await handler(new Request(url, { method: "DELETE", headers: { authorization } }), url, "DELETE", anonymous)).status).toBe(403);
  expect(scheduler.getJob(job.id)).not.toBeNull();
  admin = true;
  expect((await api(`/api/scheduler/jobs/${job.id}`, "DELETE")).status).toBe(204);
});

test("real verifier accepts exact body/no-body methods, rejects tampering and replay, and verifies once per dispatch", async () => {
  admin = true;
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const body of method === "GET" || method === "HEAD" ? [undefined] : [undefined, "{}"] ) {
      const path = `/api/admin/matrix?method=${method}&body=${Boolean(body)}`;
      const signed = await sign(path, method, body);
      expect(signed.status).toBe(200);
      const authorization = (await signed.json()).token;
      const url = new URL(`${origin}${path}`);
      const req = new Request(url, { method, headers: { authorization }, ...(body ? { body } : {}) });
      const verify = (request: Request) => verifyNip98Request({ request, requestUrl: new URL(request.url),
        configuredBaseUrl: origin, replayCache: new Nip98ReplayCache() });
      expect(await verify(req)).not.toBeNull();
      expect(await verify(new Request(`${origin}${path}&tampered=1`, req))).toBeNull();
      if (body) expect(await verify(new Request(url, { method, headers: { authorization }, body: "changed" }))).toBeNull();
    }
  }
  const response = await api("/api/scheduler/jobs");
  expect(response.status).toBe(200);
  expect(verificationCount).toBe(1);
  const signed = await sign("/api/scheduler/jobs?replay=1");
  const url = new URL(`${origin}/api/scheduler/jobs?replay=1`);
  const request = new Request(url, { headers: { authorization: (await signed.json()).token } });
  expect((await handler(request, url, "GET", anonymous)).status).toBe(200);
  expect((await handler(request, url, "GET", anonymous)).status).toBe(401);
});

test("live admin crypto expansion preserves identity, reserved validators, size and narrow policies", async () => {
  const event = { kind: 31_337, content: "as myself", tags: [], pubkey: "f".repeat(64) };
  expect((await brokerCall("nostr-event", { event })).status).toBe(403);
  admin = true;
  const signed = await brokerCall("nostr-event", { event });
  expect(signed.status).toBe(200);
  expect((await signed.json()).event.pubkey).toBe(pubkey);
  for (const kind of [445, 27_235, 24_242, 33_358]) {
    expect((await brokerCall("nostr-event", { event: { ...event, kind } })).status).toBe(403);
  }
  const peerSecret = generateSecretKey();
  const peer = getPublicKey(peerSecret);
  expect((await brokerCall("nip44/encrypt", { plaintext: "hello", recipientPubkey: peer })).status).toBe(200);
  const encrypted = nip44Encrypt("reply", peerSecret, pubkey);
  const decrypted = await brokerCall("nip44/decrypt", { ciphertext: encrypted, senderPubkey: peer });
  expect(decrypted.status).toBe(200);
  expect((await decrypted.json()).plaintext).toBe("reply");
  expect((await brokerCall("blossom/authorize", { server: "https://unrelated.example", method: "upload", objectHash: "a".repeat(64), objectSize: 1 })).status).toBe(403);
  expect((await brokerCall("nostr-event", { event: { ...event, content: "a".repeat(1_048_577) } })).status).toBe(400);
  const narrow: SessionCapabilityPolicy = { operations: ["nostr.sign", "nip44.encrypt"],
    nostr: { kinds: [1], maxContentBytes: 8, maxTags: 1 }, nip44: { encryptPeers: [pubkey], decryptPeers: [pubkey] } };
  const narrowToken = broker.issueSessionCapability({ sessionId: "session", ownerNpub: owner, policy: narrow }).token;
  expect((await brokerCall("nostr-event", { event }, narrowToken)).status).toBe(403);
  expect((await brokerCall("nip44/encrypt", { plaintext: "hello", recipientPubkey: peer }, narrowToken)).status).toBe(403);
  admin = false;
  expect((await brokerCall("nostr-event", { event })).status).toBe(403);
});

test("independent identical same-second signatures work once each, while each exact token replay fails", async () => {
  admin = true;
  const path = "/api/scheduler/jobs?nonce-regression=1";
  const first = (await (await sign(path)).json()).token;
  const second = (await (await sign(path)).json()).token;
  expect(first).not.toBe(second);
  const decode = (token: string) => JSON.parse(Buffer.from(token.slice(6), "base64").toString());
  expect(decode(first).created_at).toBe(decode(second).created_at);
  for (const authorization of [first, second]) {
    const url = new URL(`${origin}${path}`);
    const request = new Request(url, { headers: { authorization } });
    expect((await handler(request, url, "GET", anonymous)).status).toBe(200);
    expect((await handler(new Request(request), url, "GET", anonymous)).status).toBe(401);
  }
});

test("custodian linkage alone grants no session access; explicit owner delegation stays scoped after demotion", async () => {
  expect((await api("/api/sessions")).status).toBe(403);
  expect((await api("/api/sessions/custodian-session")).status).toBe(403);
  expect((await api("/api/sessions/custodian-session", "PATCH", JSON.stringify({ name: "forbidden" }))).status).toBe(403);
  expect((await api(`/api/owners/${owner}/sessions/custodian-session`)).status).toBe(403);
  delegatedScopes = ["sessions:read"];
  expect((await api(`/api/owners/${owner}/sessions/custodian-session`)).status).toBe(200);
  expect((await api(`/api/owners/${owner}/sessions/custodian-session`, "PATCH", JSON.stringify({ name: "outside-scope" }))).status).toBe(403);
  delegatedScopes = [];
  admin = true;
  const signed = await sign(`/api/owners/${owner}/sessions/custodian-session`);
  admin = false;
  const url = new URL(`${origin}/api/owners/${owner}/sessions/custodian-session`);
  const request = new Request(url, { headers: { authorization: (await signed.json()).token } });
  expect((await handler(request, url, "GET", anonymous)).status).toBe(403);
});

test("broker/API admin matrix reaches settings, Users, policies, billing, flags and terminal as the actual signer", async () => {
  admin = true;
  for (const path of ["/api/instance-settings", "/api/admin/users", "/api/admin/signing-policies/mode", "/api/billing/team", "/api/terminal/status"]) {
    const response = await api(path);
    expect(response.status).toBe(200);
    const data = await response.json();
    if (data.actor) expect(data.actor).toBe(bot);
  }
  expect((await api("/api/feature-flags", "POST", JSON.stringify({ key: "fixture_flag", label: "Fixture", state: "on" }))).status).toBe(201);
  const signed = await sign("/api/instance-settings");
  admin = false;
  const url = new URL(`${origin}/api/instance-settings`);
  const request = new Request(url, { headers: { authorization: (await signed.json()).token } });
  expect((await handler(request, url, "GET", anonymous)).status).toBe(403);
});
