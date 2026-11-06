import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { SchedulerStore } from "./scheduler-store";
import { SchedulerEngine, type SchedulerEngineDeps } from "./scheduler-engine";
import { createScheduledSessionContextResolver } from "./session-context";
import { selectFlightDeckTransportSubscription } from "../agent-chat/flightdeck-session-transport";
import { createWingmanMcpApiHandler, type WingmanMcpApiDependencies } from "../mcp/wingman-api";
import type { SessionSnapshot } from "../agents/process-manager";
import type { WorkspaceSubscriptionRecord } from "../agent-chat/types";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "scheduled-context-")); directories.push(directory);
  const store = new SchedulerStore(join(directory, "test.sqlite"));
  const botSecret = generateSecretKey();
  const botNpub = nip19.npubEncode(getPublicKey(botSecret));
  const owner = nip19.npubEncode(getPublicKey(generateSecretKey()));
  const route = { ownerNpub: owner, subscriptionId: crypto.randomUUID(), workspaceId: crypto.randomUUID(),
    scopeId: crypto.randomUUID(), channelId: crypto.randomUUID(), threadId: crypto.randomUUID(), taskId: crypto.randomUUID() };
  const subscription = { subscriptionId: route.subscriptionId, workspaceId: route.workspaceId, managedByNpub: owner,
    botNpub, lifecycleStatus: "active", sseStatus: "connected", towerServiceNpub: "tower", backendConnectionId: "connection",
    backendBaseUrl: "https://tower.test", sourceAppNpub: "app" } as WorkspaceSubscriptionRecord;
  const job = store.createJob({ name: "bounded report", userNpub: owner, botNpub, agentId: "exact-profile",
    wrappedKeyCiphertext: "", wrappedKeyNonce: "", agent: "codex", workingDirectory: directory,
    initialPrompt: "Perform a bounded report", cronExpression: "0 0 * * *", flightdeckContext: route });
  let session: SessionSnapshot | null = null;
  const events: string[] = [];
  const deps: SchedulerEngineDeps = {
    store, getInstanceIdentity: () => ({ npub: "instance" }) as any,
    resolveSessionMetadata: createScheduledSessionContextResolver({ getSubscription: () => subscription, getActiveBotOwnerNpub: () => owner }),
    createSession: async (agent, dir, name, origin, _target, explicitNpub, metadata) => {
      events.push("create");
      session = { id: crypto.randomUUID(), agent, workingDirectory: dir, name, origin, npub: explicitNpub,
        metadata, status: "running", port: 3700, startedAt: new Date().toISOString(), command: [], logs: [] } as SessionSnapshot;
      return session;
    },
    awaitSessionReadyForPrompt: async () => {
      expect(store.getJobRuns(job.id)[0]).toMatchObject({ status: "started", sessionId: session!.id });
      events.push("ready");
    },
    addPrompt: () => { events.push("queued"); },
    dispatchPrompt: async () => { await Promise.resolve(); events.push("dispatch-attempt"); },
  };
  return { store, route, job, subscription, botNpub, botSecret, owner, deps, events, getSession: () => session! };
}

test("fresh scheduled session resolves actual broker context and exact signed task reads", async () => {
  const f = fixture();
  await new SchedulerEngine(f.deps).executeJob(f.job.id);
  const session = f.getSession();
  expect(f.events).toEqual(["create", "ready", "queued", "dispatch-attempt"]);
  expect(session.npub).toBe(f.owner);
  expect(session.metadata?.agentChatAgentId).toBe("exact-profile");
  const handler = createWingmanMcpApiHandler({
    getSession: id => id === session.id ? session : null,
    resolveFlightDeckDirectContext: binding => {
      const sub = selectFlightDeckTransportSubscription([f.subscription], binding);
      return sub ? { subscriptionId: sub.subscriptionId, backendBaseUrl: sub.backendBaseUrl, appNpub: sub.sourceAppNpub,
        botIdentity: { botNpub: f.botNpub, botPubkeyHex: getPublicKey(f.botSecret), botSecret: f.botSecret } } : null;
    },
  } as WingmanMcpApiDependencies);
  async function call(action: string) {
    const request = new Request("http://localhost/api/mcp/wingman/flightdeck", { method: "POST", body: JSON.stringify({ sessionId: session.id, action }) });
    return (await handler(request, new URL(request.url), "POST"))!;
  }
  expect(await (await call("context")).json()).toMatchObject({
    scheduledSession: { id: session.id, origin: { type: "scheduler", id: f.job.id }, npub: f.owner },
    workspace: { workspaceId: f.route.workspaceId, subscriptionId: f.route.subscriptionId, backendBaseUrl: "https://tower.test" },
    bot: { npub: f.botNpub, available: true }, chat: { channelId: f.route.channelId, threadId: f.route.threadId },
    record: { recordId: f.route.taskId },
  });
  const fetchBefore = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = (async (url, init) => { requests.push(new Request(url, init)); return Response.json({ comments: [] }); }) as typeof fetch;
  try { expect((await call("task_comments")).status).toBe(200); } finally { globalThis.fetch = fetchBefore; }
  expect(requests[0]!.url).toBe(`https://tower.test/api/v4/flightdeck-pg/workspaces/${f.route.workspaceId}/tasks/${f.route.taskId}/comments?limit=200`);
  const signed = JSON.parse(Buffer.from(requests[0]!.headers.get("authorization")!.slice(6), "base64").toString());
  expect(signed.pubkey).toBe(getPublicKey(f.botSecret));
  expect(f.store.getJobRuns(f.job.id)[0]).toMatchObject({ status: "launched", sessionId: session.id });
  session.metadata!.flightdeckWorkspaceId = crypto.randomUUID();
  expect(await (await call("context")).json()).toMatchObject({ bot: { available: false }, workspace: { workspaceId: null } });
});

test.each(["ready", "dispatch"])("%s failure retains the created session link and records error", async stage => {
  const f = fixture();
  if (stage === "ready") f.deps.awaitSessionReadyForPrompt = async () => { throw new Error("not ready"); };
  else f.deps.dispatchPrompt = async () => { throw new Error("dispatch failed"); };
  await expect(new SchedulerEngine(f.deps).executeJob(f.job.id)).rejects.toThrow();
  expect(f.store.getJobRuns(f.job.id)[0]).toMatchObject({ status: "error", sessionId: f.getSession().id });
});

test("missing resolver and invalid bindings fail before creating or queuing a session", async () => {
  const f = fixture(); f.deps.resolveSessionMetadata = undefined;
  await expect(new SchedulerEngine(f.deps).executeJob(f.job.id)).rejects.toThrow("resolver is unavailable");
  expect(f.events).toEqual([]);
  const g = fixture(); g.subscription.workspaceId = crypto.randomUUID();
  await expect(new SchedulerEngine(g.deps).executeJob(g.job.id)).rejects.toThrow("exact active owner");
  expect(g.events).toEqual([]);
});
