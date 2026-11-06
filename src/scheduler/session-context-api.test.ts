process.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerStore } from "./scheduler-store";
import { createSchedulerApiHandler } from "./scheduler-api";
import { createScheduledSessionContextResolver } from "./session-context";
import type { SchedulerEngine } from "./scheduler-engine";
import type { WorkspaceSubscriptionRecord } from "../agent-chat/types";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "schedule-api-")); roots.push(root);
  const store = new SchedulerStore(join(root, "test.sqlite"));
  const route = { ownerNpub: "owner", subscriptionId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
  const sub = { ...route, managedByNpub: "owner", botNpub: "bot", lifecycleStatus: "active", sseStatus: "connected",
    towerServiceNpub: "tower", backendConnectionId: "connection", backendBaseUrl: "https://tower.test", sourceAppNpub: "app" } as unknown as WorkspaceSubscriptionRecord;
  const handler = createSchedulerApiHandler({ store, engine: { scheduleJob() {}, unscheduleJob() {} } as unknown as SchedulerEngine,
    getNpub: () => "owner", getActiveBotOwnerNpub: () => "owner",
    validateSessionContext: createScheduledSessionContextResolver({ getSubscription: () => sub, getActiveBotOwnerNpub: () => "owner" }),
  });
  async function call(path: string, method: "GET" | "POST" | "PATCH", body?: object) {
    const url = new URL(`http://localhost/api/scheduler/jobs${path}`);
    return handler(new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), url, method);
  }
  const create = (context: unknown = route) => call("", "POST", { name: "private report", agent: "codex", botNpub: "bot",
    workingDirectory: root, initialPrompt: "bounded report", cronExpression: "0 0 * * *", enabled: false, flightdeckContext: context });
  return { root, store, route, sub, call, create };
}

test("typed API persists and reads exact binding without enabling a disabled job", async () => {
  const f = fixture(); const response = await f.create(); expect(response.status).toBe(201);
  const { job } = await response.json();
  expect(job.flightdeckContext).toEqual(f.route);
  expect(f.store.getJob(job.id)).toMatchObject({ enabled: false, flightdeckContext: f.route });
  const reloaded = new SchedulerStore(join(f.root, "test.sqlite"));
  expect(reloaded.getJob(job.id)).toMatchObject({ enabled: false, cronExpression: "0 0 * * *", flightdeckContext: f.route });
  expect((await f.call(`/${job.id}`, "PATCH", { flightdeckContext: null })).status).toBe(200);
  expect(f.store.getJob(job.id)?.flightdeckContext).toBeNull();
});
test("invalid bindings fail without persisting or changing a job", async () => {
  const f = fixture();
  expect((await f.create({ ...f.route, ownerNpub: "foreign" })).status).toBe(400);
  expect((await f.create({ ...f.route, workspaceId: crypto.randomUUID() })).status).toBe(400);
  expect((await f.create({ ...f.route, extra: true })).status).toBe(400);
  expect(f.store.listJobs()).toHaveLength(0);
  const { job } = await (await f.create()).json();
  expect((await f.call(`/${job.id}`, "PATCH", { botNpub: "foreign-bot" })).status).toBe(400);
  expect(f.store.getJob(job.id)?.botNpub).toBe("bot");
});
test("run API describes legacy launch truth without rewriting historical records", async () => {
  const f = fixture(); const { job } = await (await f.create()).json();
  const id = f.store.recordRun(job.id); f.store.completeRun(id, "success", "session");
  const { runs } = await (await f.call(`/${job.id}/runs`, "GET")).json();
  expect(runs[0]).toMatchObject({ status: "success", statusLabel: "Launched (legacy)", deliveryStatus: "unverified" });
  expect(f.store.getJobRuns(job.id)[0]?.status).toBe("success");
});

test("an invalid old binding never prevents disabling the job", async () => {
  const f = fixture(); const { job } = await (await f.create()).json();
  f.sub.sseStatus = "disabled";
  expect((await f.call(`/${job.id}`, "PATCH", { enabled: true })).status).toBe(400);
  expect((await f.call(`/${job.id}`, "PATCH", { enabled: false })).status).toBe(200);
  expect(f.store.getJob(job.id)?.enabled).toBe(false);
});
