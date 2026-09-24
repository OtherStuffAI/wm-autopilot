import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { SchedulerStore } from "./scheduler-store";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wingmen-scheduler-store-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function jobInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Daily review",
    userNpub: "npub-owner",
    botNpub: "npub-bot",
    wrappedKeyCiphertext: "ciphertext",
    wrappedKeyNonce: "nonce",
    agent: "codex",
    workingDirectory: "/workspace",
    initialPrompt: "Review",
    cronExpression: "0 9 * * *",
    timezone: "UTC",
    ...overrides,
  };
}

describe("SchedulerStore stable agent binding", () => {
  test("migrates an existing scheduler table before indexing stable agent identity", () => {
    const path = join(tempDir, "legacy.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE scheduled_jobs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, user_npub TEXT NOT NULL, bot_npub TEXT NOT NULL,
        wrapped_key_ciphertext TEXT NOT NULL, wrapped_key_nonce TEXT NOT NULL, agent TEXT NOT NULL,
        working_directory TEXT NOT NULL, initial_prompt TEXT NOT NULL, nightwatchman_enabled INTEGER NOT NULL DEFAULT 0,
        cron_expression TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'UTC', enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT, next_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const store = new SchedulerStore(path);
    expect(store.listJobsForAgent("agent-stable")).toEqual([]);
  });

  test("persists agentId and filters independently of labels and execution identity", () => {
    const store = new SchedulerStore(join(tempDir, "scheduler.sqlite"));
    const first = store.createJob(jobInput({ agentId: "agent-stable" }));
    store.createJob(jobInput({ agentId: "agent-other", name: "Other" }));

    expect(first.agentId).toBe("agent-stable");
    expect(store.listJobsForAgent("agent-stable").map((job) => job.id)).toEqual([first.id]);
    store.updateJob(first.id, { botNpub: "npub-rotated" });
    expect(store.listJobsForAgent("agent-stable")[0]).toMatchObject({
      agentId: "agent-stable",
      botNpub: "npub-rotated",
    });
  });

  test("reconciles legacy null bindings only for the exact owner and bot", () => {
    const store = new SchedulerStore(join(tempDir, "scheduler.sqlite"));
    const legacy = store.createJob(jobInput());
    store.createJob(jobInput({ userNpub: "npub-other-owner" }));

    expect(legacy.agentId).toBeNull();
    expect(store.bindLegacyJobsToAgent("agent-stable", "npub-bot", "npub-owner")).toBe(1);
    expect(store.listJobsForAgent("agent-stable").map((job) => job.id)).toEqual([legacy.id]);
  });
});
