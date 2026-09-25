import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AgentAdapter } from "../agents/agent-adapter";
import type { SessionSnapshot } from "../agents/process-manager";
import type { SessionApiContext } from "../server/session-api-routes";
import { finalizePipelineAgentSession } from "./agent-session-finalization";
import { PipelineStore, type PipelineStatus } from "./pipeline-store";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createHarness(statuses: Array<"running" | "stable">) {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-agent-finalization-"));
  tempDirs.push(directory);
  const store = new PipelineStore(join(directory, "pipelines.sqlite"));
  const run = store.createRun({
    definitionId: "test",
    name: "test",
    scope: "user",
    input: {},
  });
  const step = store.createStep({ runId: run.id, stepIndex: 0, name: "agent", kind: "agent", input: {} });
  store.completeStep({ id: step.id, status: "ok", result: {}, output: {} });
  const session = {
    id: "session-1",
    agent: "codex",
    port: 49999,
    name: "Pipeline agent",
    status: "running",
    startedAt: new Date().toISOString(),
    workingDirectory: directory,
    command: [],
    logs: [],
    metadata: {},
  } as SessionSnapshot;
  const calls: string[] = [];
  let now = 0;
  let statusIndex = 0;
  const adapter = {
    async fetchStatus() {
      const status = statuses[Math.min(statusIndex, statuses.length - 1)] ?? "running";
      statusIndex += 1;
      calls.push(`status:${status}`);
      return status;
    },
  } as AgentAdapter;
  const ctx = {
    manager: {
      getSession: () => session,
      getAdapter: () => adapter,
      updateSessionMetadata: () => { calls.push("metadata:stop"); },
      stopSession: async () => { calls.push("stop"); return session; },
    },
    syncSessionMessages: async (_sessionId: string, force?: boolean) => { calls.push(`sync:${String(force)}`); return []; },
    scheduleSessionArchive: () => { calls.push("archive"); },
  } as unknown as SessionApiContext;
  const clock = {
    now: () => now,
    sleep: async (milliseconds: number) => { calls.push(`sleep:${milliseconds}`); now += milliseconds; },
  };
  return { store, run, step, ctx, clock, calls };
}

describe("pipeline agent session finalization", () => {
  test("does not stop a running turn and syncs before stopping after stable completion", async () => {
    const harness = createHarness(["running", "stable", "stable"]);

    await finalizePipelineAgentSession({
      ctx: harness.ctx,
      store: harness.store,
      runId: harness.run.id,
      stepId: harness.step.id,
      sessionId: "session-1",
      callbackStatus: "ok",
      graceMs: 1_000,
      pollMs: 10,
      clock: harness.clock,
    });

    expect(harness.calls).toEqual([
      "status:running", "sleep:10",
      "status:stable", "sleep:10",
      "status:stable", "sync:true", "metadata:stop", "stop", "archive",
    ]);
    expect(harness.store.listEvents(harness.run.id).some((event) => event.type === "agent_session_grace_completed")).toBe(true);
  });

  test("forces cleanup at the deadline and persists grace-expiry evidence", async () => {
    const harness = createHarness(["running"]);

    await finalizePipelineAgentSession({
      ctx: harness.ctx,
      store: harness.store,
      runId: harness.run.id,
      stepId: harness.step.id,
      sessionId: "session-1",
      callbackStatus: "ok",
      graceMs: 25,
      pollMs: 10,
      clock: harness.clock,
    });

    expect(harness.calls).toEqual([
      "status:running", "sleep:10",
      "status:running", "sleep:10",
      "status:running", "sleep:5",
      "sync:true", "metadata:stop", "stop", "archive",
    ]);
    const expiry = harness.store.listEvents(harness.run.id).find((event) => event.type === "agent_session_grace_expired");
    expect(expiry).toMatchObject({ level: "warn", message: "expired" });
    expect(JSON.parse(String(expiry?.data_json))).toMatchObject({ sessionId: "session-1", graceMs: 25, elapsedMs: 25 });
  });

  test.each(["cancelled", "error", null] as Array<PipelineStatus | null>)(
    "stops promptly without grace for callback status %s",
    async (callbackStatus) => {
      const harness = createHarness(["running"]);

      await finalizePipelineAgentSession({
        ctx: harness.ctx,
        store: harness.store,
        runId: harness.run.id,
        stepId: harness.step.id,
        sessionId: "session-1",
        callbackStatus,
        graceMs: 1_000,
        pollMs: 10,
        clock: harness.clock,
      });

      expect(harness.calls).toEqual(["metadata:stop", "stop", "archive"]);
    },
  );
});
