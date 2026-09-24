import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadControlledRestartOperation,
  recordControlledRestartRecovery,
  requestControlledRestart,
  restartDrainGate,
} from "./controlled-restart";

const session = (id: string, options: Record<string, unknown> = {}) => ({
  id, agent: "codex", port: 3700, name: id, status: "running", startedAt: new Date().toISOString(),
  npub: "npub1owner", command: [], workingDirectory: "/tmp", logs: [], metadata: {}, ...options,
});

async function fixture(sessions = [session("idle")]) {
  const root = await mkdtemp(join(tmpdir(), "controlled-restart-test-"));
  const live = new Map(sessions.map((value) => [value.id, value]));
  const queues = new Map<string, number>();
  const stopped: string[] = [];
  const input = {
    manager: {
      listSessions: () => [...live.values()], getSession: (id: string) => live.get(id),
      stopSession: async (id: string) => { stopped.push(id); live.delete(id); },
      createSession: async () => ({ id: "rollback-session" }),
    },
    messageStore: { listSessions: () => [...sessions, { ...session("terminal"), id: "terminal" }] },
    promptQueueStore: { getQueueCount: (id: string) => queues.get(id) ?? 0, rebindSession: () => 0 },
    queueDispatchInFlight: new Set<string>(),
    operationPath: join(root, "operation.json"), markerPath: join(root, "marker.json"),
    requesterNpub: "npub1pete", gracePeriodMs: 0, isAgentType: (agent: string) => agent === "codex",
    launch: async () => Response.json({ status: "scheduled" }, { status: 202 }),
  };
  return { input, live, queues, stopped };
}

afterEach(() => restartDrainGate.leave());

describe("controlled restart coordinator", () => {
  test("classifies all session states, drains cooperatively, and reports forced termination", async () => {
    const f = await fixture([
      session("busy", { agentRuntimeStatus: "running" }), session("idle"),
      session("queued"), session("scheduled", { origin: { type: "scheduler", id: "job-1" } }),
    ]);
    f.queues.set("queued", 2);
    const response = await requestControlledRestart(f.input as never);
    const operation = await loadControlledRestartOperation(f.input.operationPath);
    expect(response.status).toBe(202);
    expect(operation?.counts).toMatchObject({ "active-in-flight": 1, idle: 1, queued: 1, scheduled: 1, terminal: 1, forced: 1 });
    expect(operation?.forcedSessionIds).toEqual(["busy"]);
    expect(operation?.phases.find((entry) => entry.phase === "draining")?.outcome).toBe("partial");
    expect(f.stopped.sort()).toEqual(["busy", "idle", "queued", "scheduled"]);
    expect(() => restartDrainGate.assertSessionStartAllowed()).toThrow("drain is active");
  });

  test("lets an in-flight turn finish inside the grace period", async () => {
    const f = await fixture([session("busy", { agentRuntimeStatus: "running" })]);
    f.input.gracePeriodMs = 100;
    setTimeout(() => f.live.set("busy", session("busy", { agentRuntimeStatus: "stable" })), 10);
    await requestControlledRestart(f.input as never);
    const operation = await loadControlledRestartOperation(f.input.operationPath);
    expect(operation?.forcedSessionIds).toEqual([]);
    expect(operation?.phases.find((entry) => entry.phase === "draining")?.outcome).toBe("succeeded");
  });

  test("gates new starts and prompt execution deterministically during drain", async () => {
    const f = await fixture([session("busy", { agentRuntimeStatus: "running" })]);
    f.input.gracePeriodMs = 50;
    const pending = requestControlledRestart(f.input as never);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(() => restartDrainGate.assertSessionStartAllowed()).toThrow("new sessions");
    expect(() => restartDrainGate.assertPromptExecutionAllowed()).toThrow("prompt execution");
    await pending;
  });

  test("surfaces checkpoint failure without stopping sessions", async () => {
    const f = await fixture();
    f.input.operationPath = join(f.input.operationPath, "missing", "operation.json");
    const response = await requestControlledRestart(f.input as never);
    expect(response.status).toBe(500);
    expect(f.stopped).toEqual([]);
    expect(restartDrainGate.isDraining()).toBe(false);
  });

  test("persists supervisor rejection and releases the gate", async () => {
    const f = await fixture();
    f.input.launch = async () => Response.json({ error: "supervisor refused" }, { status: 503 });
    const response = await requestControlledRestart(f.input as never);
    const operation = await loadControlledRestartOperation(f.input.operationPath);
    expect(response.status).toBe(500);
    expect(operation).toMatchObject({ status: "failed", failure: { phase: "restart-requested" } });
    expect(operation?.failure?.message).toContain("supervisor refused");
    expect(restartDrainGate.isDraining()).toBe(false);
  });

  test("records partial recovery idempotently without duplicating completed bindings", async () => {
    const f = await fixture([session("one"), session("two")]);
    await requestControlledRestart(f.input as never);
    const outcome = { failed: ["two"], resumedSessions: [{ sourceSessionId: "one", sessionId: "one-new" }], freshSessions: [] };
    const first = await recordControlledRestartRecovery(f.input.operationPath, outcome);
    const firstBytes = await readFile(f.input.operationPath, "utf8");
    const second = await recordControlledRestartRecovery(f.input.operationPath, outcome);
    expect(first?.status).toBe("partial");
    expect(first?.sessions.find((entry) => entry.id === "one")).toMatchObject({ recoveryStatus: "restored", replacementSessionId: "one-new" });
    expect(first?.sessions.find((entry) => entry.id === "two")?.recoveryStatus).toBe("failed");
    expect(second).toEqual(first);
    expect(await readFile(f.input.operationPath, "utf8")).toBe(firstBytes);
  });

  test("records a recovery failure when startup produces no outcome", async () => {
    const f = await fixture();
    await requestControlledRestart(f.input as never);
    const operation = await recordControlledRestartRecovery(f.input.operationPath, null);
    expect(operation?.status).toBe("partial");
    expect(operation?.sessions.find((entry) => entry.id === "idle")?.recoveryStatus).toBe("failed");
  });
});
