import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import { SchedulerEngine, type SchedulerEngineDeps } from "./scheduler-engine";
import { SchedulerStore, type ScheduledJob } from "./scheduler-store";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wingmen-scheduler-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const identity: WingmanInstanceIdentity = {
  nsec: "nsec-test",
  nsecHex: "0".repeat(64),
  secretKey: new Uint8Array(32),
  pubkeyHex: "pubkey-test",
  npub: "npub-test",
  displayName: "test",
  source: "env",
};

function createPipelineJob(store: SchedulerStore): ScheduledJob {
  return store.createJob({
    name: "pipeline job",
    userNpub: "npub-user",
    botNpub: "npub-bot",
    wrappedKeyCiphertext: "ciphertext",
    wrappedKeyNonce: "nonce",
    agent: "codex",
    workingDirectory: tempDir,
    initialPrompt: "run it",
    nightwatchmanEnabled: false,
    triggerType: "cron",
    cronExpression: "* * * * *",
    actionType: "pipeline",
    pipelineDefinitionId: "test-pipeline",
    pipelineInputJson: JSON.stringify({ value: 1 }),
  });
}

function createCleanupJob(store: SchedulerStore): ScheduledJob {
  return store.createJob({
    name: "cleanup job",
    userNpub: "npub-user",
    botNpub: "",
    wrappedKeyCiphertext: "",
    wrappedKeyNonce: "",
    agent: "codex",
    workingDirectory: "",
    initialPrompt: "",
    nightwatchmanEnabled: false,
    triggerType: "cron",
    cronExpression: "* * * * *",
    actionType: "cleanup",
  });
}

function convertToHistoricalRelayJob(filePath: string, jobId: string): void {
  const db = new Database(filePath);
  db.query("UPDATE scheduled_jobs SET trigger_type = 'nostr', enabled = 1 WHERE id = ?1").run(jobId);
  db.close();
}

function createEngine(
  store: SchedulerStore,
  runPipeline: NonNullable<SchedulerEngineDeps["runPipeline"]>,
): SchedulerEngine {
  return new SchedulerEngine({
    store,
    createSession: async () => {
      throw new Error("pipeline jobs should not create sessions");
    },
    addPrompt: () => {},
    dispatchPrompt: () => {},
    getInstanceIdentity: () => identity,
    runPipeline,
  });
}

function createCleanupEngine(
  store: SchedulerStore,
  cleanupStopNextActionSessions: NonNullable<SchedulerEngineDeps["cleanupStopNextActionSessions"]>,
): SchedulerEngine {
  return new SchedulerEngine({
    store,
    createSession: async () => {
      throw new Error("cleanup jobs should not create sessions");
    },
    addPrompt: () => {},
    dispatchPrompt: () => {},
    cleanupStopNextActionSessions,
    getInstanceIdentity: () => null,
  });
}

describe("SchedulerEngine pipeline job bookkeeping", () => {
  test("links the scheduled run to the pipeline run before completion and finalizes success", async () => {
    const store = new SchedulerStore(join(tempDir, "wingman.db"));
    const job = createPipelineJob(store);
    const engine = createEngine(store, async (_job, _input, onRunCreated) => {
      onRunCreated?.("pipeline-ok");
      const linkedRun = store.getJobRuns(job.id, 1)[0];
      expect(linkedRun).toMatchObject({
        status: "started",
        pipelineRunId: "pipeline-ok",
      });
      return "pipeline-ok";
    });

    await expect(engine.executeJob(job.id)).resolves.toEqual({ pipelineRunId: "pipeline-ok" });

    const completedRun = store.getJobRuns(job.id, 1)[0];
    expect(completedRun).toMatchObject({
      status: "success",
      pipelineRunId: "pipeline-ok",
      sessionId: null,
      errorMessage: null,
    });
  });

  test("preserves the linked pipeline run when pipeline execution fails", async () => {
    const store = new SchedulerStore(join(tempDir, "wingman.db"));
    const job = createPipelineJob(store);
    const engine = createEngine(store, async (_job, _input, onRunCreated) => {
      onRunCreated?.("pipeline-error");
      throw new Error("pipeline failed");
    });

    await expect(engine.executeJob(job.id)).rejects.toThrow("pipeline failed");

    const failedRun = store.getJobRuns(job.id, 1)[0];
    expect(failedRun).toMatchObject({
      status: "error",
      pipelineRunId: "pipeline-error",
      sessionId: null,
      errorMessage: "pipeline failed",
    });
  });
});

describe("SchedulerEngine cleanup jobs", () => {
  test("runs next-action cleanup without requiring an instance identity", async () => {
    const store = new SchedulerStore(join(tempDir, "wingman.db"));
    const job = createCleanupJob(store);
    const engine = createCleanupEngine(store, async (cleanupJob) => {
      expect(cleanupJob.id).toBe(job.id);
      return {
        checked: 3,
        matched: 2,
        stopped: 2,
        archiveScheduled: 2,
        failed: 0,
      };
    });

    await expect(engine.executeJob(job.id)).resolves.toEqual({
      cleanup: {
        checked: 3,
        matched: 2,
        stopped: 2,
        archiveScheduled: 2,
        failed: 0,
      },
    });

    const completedRun = store.getJobRuns(job.id, 1)[0];
    expect(completedRun).toMatchObject({
      status: "success",
      pipelineRunId: null,
      sessionId: null,
      errorMessage: null,
    });
  });
});

describe("SchedulerEngine WApp activity binding", () => {
  test("copies the scheduled installation authority into the created session", async () => {
    const store = new SchedulerStore(join(tempDir, "wingman.db"));
    const job = store.createJob({
      name: "Book of Sand news graph",
      userNpub: "npub-user",
      botNpub: "npub-bot",
      wrappedKeyCiphertext: "ciphertext",
      wrappedKeyNonce: "nonce",
      agent: "codex",
      workingDirectory: tempDir,
      initialPrompt: "Publish one verified story.",
      model: "gpt-5.5",
      nightwatchmanEnabled: false,
      triggerType: "cron",
      cronExpression: "* * * * *",
      actionType: "session",
      wappActivityInstallationId: "book-of-sand",
    });
    let createdMetadata: Parameters<SchedulerEngineDeps["createSession"]>[6];
    let createdModel: Parameters<SchedulerEngineDeps["createSession"]>[7];
    const engine = new SchedulerEngine({
      store,
      createSession: async (_agent, dir, name, origin, _target, npub, metadata, model) => {
        createdMetadata = metadata;
        createdModel = model;
        return { id: "scheduled-session", agent: "codex", port: 3700, name, status: "running", startedAt: new Date().toISOString(), npub, command: [], workingDirectory: dir, logs: [], origin, metadata: { AGENT: true, billingMode: "subscription", ...metadata } };
      },
      addPrompt: () => {},
      dispatchPrompt: () => {},
      getInstanceIdentity: () => identity,
    });

    await expect(engine.executeJob(job.id)).resolves.toEqual({ sessionId: "scheduled-session" });
    expect(createdMetadata).toMatchObject({
      AGENT: true,
      agentChatBotNpub: "npub-bot",
      wappActivityInstallationId: "book-of-sand",
    });
    expect(createdModel).toBe("gpt-5.5");
    expect(store.getJob(job.id)?.model).toBe("gpt-5.5");
    expect(store.getJob(job.id)?.wappActivityInstallationId).toBe("book-of-sand");
  });
});

describe("SchedulerEngine unsupported historical jobs", () => {
  test("keeps persisted relay jobs visible but inert without reaching work sinks", async () => {
    const filePath = join(tempDir, "wingman.db");
    const store = new SchedulerStore(filePath);
    const created = createPipelineJob(store);
    convertToHistoricalRelayJob(filePath, created.id);

    const historical = store.getJob(created.id);
    expect(historical).toMatchObject({
      triggerType: "unsupported",
      persistedTriggerType: "nostr",
      enabled: false,
    });
    expect(historical?.unsupportedReason).toContain("cannot initiate work");
    expect(store.listJobs().some((job) => job.id === created.id)).toBe(true);
    expect(store.listEnabledJobs().some((job) => job.id === created.id)).toBe(false);

    let createSessionCalls = 0;
    let addPromptCalls = 0;
    let dispatchPromptCalls = 0;
    let pipelineCalls = 0;
    const engine = new SchedulerEngine({
      store,
      createSession: async () => {
        createSessionCalls += 1;
        throw new Error("unexpected session creation");
      },
      addPrompt: () => { addPromptCalls += 1; },
      dispatchPrompt: () => { dispatchPromptCalls += 1; },
      runPipeline: async () => {
        pipelineCalls += 1;
        return "unexpected";
      },
      getInstanceIdentity: () => identity,
    });

    engine.start();
    await expect(engine.executeJob(created.id)).rejects.toThrow("cannot initiate work");
    expect({ createSessionCalls, addPromptCalls, dispatchPromptCalls, pipelineCalls }).toEqual({
      createSessionCalls: 0,
      addPromptCalls: 0,
      dispatchPromptCalls: 0,
      pipelineCalls: 0,
    });
    expect(store.getJobRuns(created.id)).toHaveLength(0);
  });
});
