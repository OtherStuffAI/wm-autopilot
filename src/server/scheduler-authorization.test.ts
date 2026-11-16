import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestContext, runWithRequestContext, type RequestAuthContext } from "../auth/request-context";
import type { BotKeyRecord } from "../identity/bot-key-store";
import { createSchedulerRunIdentityPolicy } from "../scheduler/run-identity-policy";
import { schedulerRequestAuthority } from "../scheduler/request-authority";
import { createSchedulerApiHandler } from "../scheduler/scheduler-api";
import { SchedulerEngine } from "../scheduler/scheduler-engine";
import { SchedulerStore } from "../scheduler/scheduler-store";
import { createScheduledSessionContextResolver } from "../scheduler/session-context";
import { handleOwnerSpaceApi, type OwnerSpaceRoutesContext } from "./owner-space-routes";
import type { WorkspaceDelegationRecord } from "../storage/workspace-delegation-store";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const owner = "npub-owner";
const other = "npub-other";
const instance = "npub-instance";
const admin = "npub-admin";
const delegate = "npub-delegate";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "scheduler-authorization-")); directories.push(dir);
  const store = new SchedulerStore(join(dir, "scheduler.sqlite"));
  let availableInstance: string | null = instance;
  const profiles = [instance, "registered", "revoked", "unavailable", "foreign"]
    .map(botNpub => ({ agentId: `profile-${botNpub}`, botNpub, label: botNpub, enabled: true }));
  const keys = new Map(["registered", "unavailable", "foreign"].map(botNpub =>
    [botNpub, { botNpub, userNpub: botNpub === "foreign" ? other : owner } as BotKeyRecord]));
  let grantedScopes = ["sessions:read", "sessions:create", "sessions:manage"];
  const policy = createSchedulerRunIdentityPolicy({
    keys: { getActiveKeyForBotNpub: bot => keys.get(bot) ?? null },
    getInstanceNpub: () => availableInstance,
    listProfiles: npub => npub === owner ? profiles : [],
    isKeyAvailable: key => key.botNpub !== "unavailable",
  });
  const launches: Array<{ owner: string; bot: string; actor: string | null }> = [];
  const engine = new SchedulerEngine({
    store, validateRunIdentity: policy.validate,
    getInstanceIdentity: () => availableInstance ? { npub: availableInstance } as never : null,
    resolveSessionMetadata: createScheduledSessionContextResolver({ validateRunIdentity: policy.validate, getSubscription: () => null }),
    createSession: async (_agent, _dir, _name, _origin, _target, npub, metadata) => {
      launches.push({ owner: npub!, bot: metadata!.agentChatBotNpub!, actor: getRequestContext().signerNpub ?? null });
      return { id: "session" } as never;
    },
    addPrompt() {}, dispatchPrompt() {},
    runPipeline: async job => {
      launches.push({ owner: job.userNpub, bot: job.botNpub, actor: getRequestContext().signerNpub ?? null });
      return "pipeline-run";
    },
  });
  const handler = createSchedulerApiHandler({
    store, engine, ...schedulerRequestAuthority(npub => npub === admin),
    listRunIdentities: policy.list, validateRunIdentity: policy.validate,
    getAgentIdForBotNpub: (botNpub, userNpub) => policy.resolve({ botNpub, userNpub }).agentId,
  });
  const context = {
    schedulerStore: store, schedulerApiHandler: handler, isAdminNpub: npub => npub === admin,
    workspaceDelegationStore: { findActiveDelegation: (target: string, subject: string, scope: string) =>
      target === owner && subject === delegate && grantedScopes.includes(scope)
        ? { id: "grant", scopes: grantedScopes, resourceFilters: null } as WorkspaceDelegationRecord : null },
    resolveWorkspace: () => ({ allowedDirectories: [dir], docsRoot: dir, docsRootBoundary: `${dir}/`, defaultDirectory: dir }),
    ensureSessionsAccess: async () => null,
  } as OwnerSpaceRoutesContext;
  async function request(actor: string, path: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: unknown) {
    const req = new Request(`http://autopilot.test/api${path}`, { method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const auth: RequestAuthContext = { npub: actor, signerNpub: actor, subjectNpub: actor, targetOwnerNpub: actor, session: null };
    return runWithRequestContext(auth, async () => path.startsWith("/owners/")
      ? (await handleOwnerSpaceApi(req, new URL(req.url), method, auth, context))!
      : handler(req, new URL(req.url), method));
  }
  const body = { name: "Research", actionType: "pipeline", pipelineDefinitionId: "research", botNpub: instance,
    cronExpression: "0 0 1 1 *", enabled: false };
  return { store, engine, policy, keys, profiles, launches, request, body, dir,
    setScopes: (scopes: string[]) => { grantedScopes = scopes; },
    setInstance: (npub: string | null) => { availableInstance = npub; } };
}

test.each([[admin, "pipeline"], [delegate, "pipeline"], [admin, "session"], [delegate, "session"]])("%s can discover, create, update and execute instance %s in authorized owner space", async (actor, actionType) => {
  const f = fixture();
  try {
    const base = `/owners/${owner}/scheduler`;
    const listing = await f.request(actor, `${base}/identities`);
    expect(listing.status).toBe(200);
    expect((await listing.json()).identities).toEqual([
      { botNpub: instance, name: instance }, { botNpub: "registered", name: "registered" },
    ]);
    const created = await f.request(actor, `${base}/jobs`, "POST", { ...f.body, actionType, agent: "codex", workingDirectory: f.dir, initialPrompt: "Research" });
    expect(created.status).toBe(201);
    const { job } = await created.json();
    expect(job).toMatchObject({ userNpub: owner, botNpub: instance, agentId: `profile-${instance}`, enabled: false });
    expect((await f.request(actor, `${base}/jobs/${job.id}`, "PATCH", { enabled: true })).status).toBe(200);
    expect((await f.request(actor, `${base}/jobs/${job.id}/trigger`, "POST")).status).toBe(200);
    expect(f.launches).toEqual([{ owner, bot: instance, actor }]);
    expect((await (await f.request(actor, `${base}/jobs/${job.id}/runs`)).json()).runs[0].status).toBe(actionType === "session" ? "launched" : "success");
    expect((await (await f.request(actor, `${base}/jobs`)).json()).jobs).toHaveLength(1);
    expect(f.keys.has(instance)).toBe(false);
  } finally { f.engine.stop(); }
});

test("raw admin stays in signer namespace; explicit owner listings and job access stay isolated", async () => {
  const f = fixture();
  const base = `/owners/${owner}/scheduler`;
  const created = await f.request(admin, `${base}/jobs`, "POST", f.body);
  const { job } = await created.json();
  expect((await f.request(admin, "/scheduler/jobs", "POST", f.body)).status).toBe(400);
  expect((await (await f.request(admin, "/scheduler/identities")).json()).identities).toEqual([]);
  expect((await (await f.request(admin, `/owners/${admin}/scheduler/jobs`)).json()).jobs).toEqual([]);
  expect((await f.request(admin, `/owners/${other}/scheduler/jobs/${job.id}`, "PATCH", { enabled: true })).status).toBe(404);
  expect((await f.request(other, `${base}/identities`)).status).toBe(403);
  expect((await f.request(other, "/scheduler/jobs", "POST", f.body)).status).toBe(400);
  expect((await f.request(other, `/scheduler/jobs/${job.id}/trigger`, "POST")).status).toBe(404);
  expect((await f.request(other, `/scheduler/jobs/${job.id}`, "PATCH", { botNpub: instance })).status).toBe(404);
  expect((await (await f.request(other, "/scheduler/jobs")).json()).jobs).toEqual([]);
});

test("delegation is checked per operation and revocation denies further owner-space access", async () => {
  const f = fixture(); const base = `/owners/${owner}/scheduler`;
  f.setScopes(["sessions:read"]);
  expect((await f.request(delegate, `${base}/identities`)).status).toBe(200);
  expect((await f.request(delegate, `${base}/jobs`, "POST", f.body)).status).toBe(403);
  f.setScopes([]);
  expect((await f.request(delegate, `${base}/identities`)).status).toBe(403);
});

test.each(["unknown", "revoked", "unavailable", "foreign"])("admin cannot save or rebind to %s", async botNpub => {
  const f = fixture(); const base = `/owners/${owner}/scheduler/jobs`;
  expect((await f.request(admin, base, "POST", { ...f.body, botNpub })).status).toBe(400);
  const { job } = await (await f.request(admin, base, "POST", f.body)).json();
  expect((await f.request(admin, `${base}/${job.id}`, "PATCH", { botNpub })).status).toBe(400);
  expect(f.store.getJob(job.id)?.botNpub).toBe(instance);
});

test("ordinary owner can schedule its registered identity; no owner or signer is substituted", async () => {
  const f = fixture();
  try {
    const { job } = await (await f.request(owner, "/scheduler/jobs", "POST", { ...f.body, botNpub: "registered" })).json();
    expect(job).toMatchObject({ userNpub: owner, botNpub: "registered" });
    expect((await f.request(owner, `/scheduler/jobs/${job.id}`, "PATCH", { enabled: true })).status).toBe(200);
    expect((await f.request(owner, `/scheduler/jobs/${job.id}/trigger`, "POST")).status).toBe(200);
    expect(f.launches).toEqual([{ owner, bot: "registered", actor: owner }]);
  } finally { f.engine.stop(); }
});

test.each(["pipeline", "session"])("revoked registered %s identity cannot execute or be enabled by an admin", async actionType => {
  const f = fixture(); const base = `/owners/${owner}/scheduler/jobs`;
  const { job } = await (await f.request(admin, base, "POST", { ...f.body, actionType, botNpub: "registered",
    agent: "codex", workingDirectory: f.dir, initialPrompt: "Research" })).json();
  try {
    expect((await f.request(admin, `${base}/${job.id}`, "PATCH", { enabled: true })).status).toBe(200);
    f.keys.delete("registered");
    expect((await f.request(admin, `${base}/${job.id}/trigger`, "POST")).status).toBe(500);
    expect(f.launches).toEqual([]);
    expect(f.store.getJobRuns(job.id)[0]).toMatchObject({ status: "error", pipelineRunId: null, sessionId: null });
    expect((await f.request(admin, `${base}/${job.id}`, "PATCH", { enabled: false })).status).toBe(200);
    expect((await f.request(admin, `${base}/${job.id}`, "PATCH", { enabled: true })).status).toBe(400);
  } finally { f.engine.stop(); }
});

test.each(["pipeline", "session"])("%s rechecks live identity before work; stale jobs can be disabled but not re-enabled", async actionType => {
  const f = fixture(); const base = `/owners/${owner}/scheduler/jobs`;
  const { job } = await (await f.request(admin, base, "POST", { ...f.body, actionType,
    agent: "codex", workingDirectory: f.dir, initialPrompt: "Research" })).json();
  try {
    expect((await f.request(admin, `${base}/${job.id}`, "PATCH", { enabled: true })).status).toBe(200);
    f.setInstance("replacement");
    const trigger = await f.request(admin, `${base}/${job.id}/trigger`, "POST");
    expect(trigger.status).toBe(500);
    expect(f.launches).toEqual([]);
    expect(f.store.getJobRuns(job.id)[0]).toMatchObject({ status: "error", sessionId: null, pipelineRunId: null });
    expect((await f.request(admin, `${base}/${job.id}`, "PATCH", { name: "Misleading success" })).status).toBe(400);
    expect((await f.request(admin, `${base}/${job.id}`, "PATCH", { enabled: false })).status).toBe(200);
    expect((await f.request(admin, `${base}/${job.id}`, "PATCH", { name: "Historical" })).status).toBe(200);
    expect((await f.request(admin, `${base}/${job.id}`, "PATCH", { enabled: true })).status).toBe(400);
    f.setInstance(instance);
    f.profiles[0]!.enabled = false;
    expect((await f.request(admin, `${base}/${job.id}`, "PATCH", { enabled: true })).status).toBe(400);
    expect(f.store.getJob(job.id)?.botNpub).toBe(instance);
  } finally { f.engine.stop(); }
});
