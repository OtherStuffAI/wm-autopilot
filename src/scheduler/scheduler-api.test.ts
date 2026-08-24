import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSchedulerApiHandler } from "./scheduler-api";
import type { SchedulerEngine } from "./scheduler-engine";
import { RELAY_TRIGGER_UNSUPPORTED_REASON, SchedulerStore } from "./scheduler-store";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wingmen-scheduler-api-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createJob(store: SchedulerStore) {
  return store.createJob({
    name: "scheduled job",
    userNpub: "npub-user",
    botNpub: "npub-bot",
    wrappedKeyCiphertext: "ciphertext",
    wrappedKeyNonce: "nonce",
    agent: "codex",
    workingDirectory: tempDir,
    initialPrompt: "run it",
    triggerType: "cron",
    cronExpression: "* * * * *",
  });
}

function createHandler(store: SchedulerStore, executeJob?: (jobId: string) => Promise<Record<string, unknown>>) {
  const engine = {
    scheduleJob() {},
    unscheduleJob() {},
    executeJob: executeJob ?? (async () => ({})),
  } as unknown as SchedulerEngine;
  return createSchedulerApiHandler({
    store,
    engine,
    getNpub: () => "npub-user",
    getInstanceIdentity: () => null,
    getActiveBotOwnerNpub: (botNpub) => botNpub === "npub-current-bot" ? "npub-user" : null,
  });
}

describe("scheduler bot identity binding", () => {
  test("rebinds an owned trigger only to an active bot identity", async () => {
    const store = new SchedulerStore(join(tempDir, "wingman.db"));
    const handler = createHandler(store);
    const job = createJob(store);

    const rejected = new Request(`http://wingman.test/api/scheduler/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botNpub: "npub-retired-bot" }),
    });
    expect((await handler(rejected, new URL(rejected.url), "PATCH")).status).toBe(400);

    const request = new Request(`http://wingman.test/api/scheduler/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botNpub: "npub-current-bot" }),
    });
    const response = await handler(request, new URL(request.url), "PATCH");
    expect(response.status).toBe(200);
    expect(store.getJob(job.id)?.botNpub).toBe("npub-current-bot");
  });
});

describe("scheduler agent model selection", () => {
  test("persists model overrides and normalises the default option", async () => {
    const store = new SchedulerStore(join(tempDir, "wingman.db"));
    const handler = createHandler(store);
    const job = createJob(store);

    const selectRequest = new Request(`http://wingman.test/api/scheduler/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5" }),
    });
    expect((await handler(selectRequest, new URL(selectRequest.url), "PATCH")).status).toBe(200);
    expect(store.getJob(job.id)?.model).toBe("gpt-5.5");

    const defaultRequest = new Request(`http://wingman.test/api/scheduler/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default" }),
    });
    expect((await handler(defaultRequest, new URL(defaultRequest.url), "PATCH")).status).toBe(200);
    expect(store.getJob(job.id)?.model).toBeNull();
  });
});

describe("scheduler Night Watchman retirement", () => {
  test("keeps the legacy setting disabled even when an old client requests it", async () => {
    const store = new SchedulerStore(join(tempDir, "wingman.db"));
    const handler = createHandler(store);
    const job = createJob(store);
    expect(job.nightwatchmanEnabled).toBe(false);

    const request = new Request(`http://wingman.test/api/scheduler/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nightwatchmanEnabled: true }),
    });
    expect((await handler(request, new URL(request.url), "PATCH")).status).toBe(200);
    expect(store.getJob(job.id)?.nightwatchmanEnabled).toBe(false);
  });
});

describe("scheduler API relay trigger removal", () => {
  test("rejects attempted relay trigger creation and updates with a clear unsupported result", async () => {
    const store = new SchedulerStore(join(tempDir, "wingman.db"));
    const handler = createHandler(store);
    const createRequest = new Request("http://wingman.test/api/scheduler/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ triggerType: "nostr" }),
    });
    const createResponse = await handler(createRequest, new URL(createRequest.url), "POST");
    expect(createResponse.status).toBe(400);
    expect(await createResponse.json()).toEqual({ error: RELAY_TRIGGER_UNSUPPORTED_REASON });

    const job = createJob(store);
    const updateRequest = new Request(`http://wingman.test/api/scheduler/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ triggerType: "nostr" }),
    });
    const updateResponse = await handler(updateRequest, new URL(updateRequest.url), "PATCH");
    expect(updateResponse.status).toBe(400);
    expect(await updateResponse.json()).toEqual({ error: RELAY_TRIGGER_UNSUPPORTED_REASON });
  });

  test("returns historical relay jobs as unsupported and refuses manual execution", async () => {
    const filePath = join(tempDir, "wingman.db");
    const store = new SchedulerStore(filePath);
    const job = createJob(store);
    const db = new Database(filePath);
    db.query("UPDATE scheduled_jobs SET trigger_type = 'nostr', enabled = 1 WHERE id = ?1").run(job.id);
    db.close();

    let executeCalls = 0;
    const handler = createHandler(store, async () => {
      executeCalls += 1;
      return {};
    });
    const listRequest = new Request("http://wingman.test/api/scheduler/jobs");
    const listResponse = await handler(listRequest, new URL(listRequest.url), "GET");
    const listPayload = await listResponse.json() as { jobs: Array<Record<string, unknown>> };
    expect(listPayload.jobs[0]).toMatchObject({
      id: job.id,
      triggerType: "unsupported",
      persistedTriggerType: "nostr",
      enabled: false,
      unsupportedReason: RELAY_TRIGGER_UNSUPPORTED_REASON,
    });

    const triggerRequest = new Request(`http://wingman.test/api/scheduler/jobs/${job.id}/trigger`, { method: "POST" });
    const triggerResponse = await handler(triggerRequest, new URL(triggerRequest.url), "POST");
    expect(triggerResponse.status).toBe(409);
    expect(await triggerResponse.json()).toEqual({ error: RELAY_TRIGGER_UNSUPPORTED_REASON });
    expect(executeCalls).toBe(0);
  });
});
