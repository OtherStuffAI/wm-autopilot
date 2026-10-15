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
import { loadWarmRestartMarker, restoreRestartedSessions } from "./bootstrap/warm-restart";

const session = (id: string, options: Record<string, unknown> = {}) => ({
  id, agent: "codex", port: 3700, name: id, status: "running", startedAt: new Date().toISOString(),
  npub: "npub1owner", command: [], workingDirectory: "/tmp", logs: [], metadata: {}, ...options,
});

async function fixture(sessions = [session("idle")]) {
  const root = await mkdtemp(join(tmpdir(), "controlled-restart-test-"));
  const live = new Map(sessions.map((value) => [value.id, value]));
  const queues = new Map<string, number>();
  const directTurns = new Set<string>();
  const supervisedWork = new Set<string>();
  const stopFailures = new Set<string>();
  const stopped: string[] = [];
  const queueRebindings: Array<[string, string]> = [];
  const dispatchRebindings: Array<[string, string]> = [];
  let launches = 0;
  const input = {
    manager: {
      listSessions: () => [...live.values()], getSession: (id: string) => live.get(id),
      stopSession: async (id: string) => {
        if (stopFailures.has(id)) throw new Error(`failed to stop ${id}`);
        stopped.push(id);
        live.delete(id);
      },
      createSession: async () => { launches += 1; return { id: `replacement-${launches}` }; },
    },
    messageStore: { listSessions: () => [...sessions, { ...session("terminal"), id: "terminal" }] },
    promptQueueStore: {
      getQueueCount: (id: string) => queues.get(id) ?? 0,
      rebindSession: (sourceId: string, replacementId: string) => {
        queueRebindings.push([sourceId, replacementId]);
        return 0;
      },
    },
    directChatTurnStore: { hasRecoverableSessionTurn: (id: string) => directTurns.has(id) },
    sessionDispatchStore: {
      hasRecoveryWork: (id: string) => supervisedWork.has(id),
      rebindSession: (sourceId: string, replacementId: string) => {
        dispatchRebindings.push([sourceId, replacementId]);
      },
    },
    queueDispatchInFlight: new Set<string>(),
    operationPath: join(root, "operation.json"), markerPath: join(root, "marker.json"),
    requesterNpub: "npub1pete", gracePeriodMs: 0, isAgentType: (agent: string) => agent === "codex",
    launch: async () => Response.json({ status: "scheduled" }, { status: 202 }),
  };
  return {
    input,
    live,
    queues,
    directTurns,
    supervisedWork,
    stopFailures,
    stopped,
    queueRebindings,
    dispatchRebindings,
    launches: () => launches,
  };
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
    expect(operation?.counts).toMatchObject({ "active-in-flight": 1, "user-persistent": 1, queued: 1, scheduled: 1, terminal: 1, forced: 1 });
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

  test("restores only eligible sessions after supervisor rejection", async () => {
    const f = await fixture([
      session("eligible"),
      session("settled", {
        origin: { type: "agent-chat", id: "route" },
        metadata: { AGENT: true, role: "agent-chat", nextAction: "reflect" },
      }),
    ]);
    f.input.launch = async () => Response.json({ error: "supervisor refused" }, { status: 503 });
    const response = await requestControlledRestart(f.input as never);
    const operation = await loadControlledRestartOperation(f.input.operationPath);
    expect(response.status).toBe(500);
    expect(operation).toMatchObject({ status: "failed", failure: { phase: "restart-requested" } });
    expect(operation?.failure?.message).toContain("supervisor refused");
    expect(f.stopped).toEqual(["eligible", "settled"]);
    expect(f.launches()).toBe(1);
    expect(f.queueRebindings).toEqual([["eligible", "replacement-1"]]);
    expect(f.dispatchRebindings).toEqual([["eligible", "replacement-1"]]);
    expect(await Bun.file(f.input.markerPath).exists()).toBe(false);
    expect(restartDrainGate.isDraining()).toBe(false);
  });

  test("restores only stopped eligible sessions after a separate stop fails", async () => {
    const f = await fixture([
      session("eligible"),
      session("settled", {
        origin: { type: "agent-chat", id: "route" },
        metadata: { AGENT: true, role: "agent-chat", nextAction: "reflect" },
      }),
      session("stop-failure"),
    ]);
    f.stopFailures.add("stop-failure");

    const response = await requestControlledRestart(f.input as never);
    const operation = await loadControlledRestartOperation(f.input.operationPath);

    expect(response.status).toBe(500);
    expect(operation).toMatchObject({ status: "failed", failure: { phase: "stopping" } });
    expect(f.stopped).toEqual(["eligible", "settled"]);
    expect(f.launches()).toBe(1);
    expect(f.queueRebindings).toEqual([["eligible", "replacement-1"]]);
    expect(f.dispatchRebindings).toEqual([["eligible", "replacement-1"]]);
    expect(await Bun.file(f.input.markerPath).exists()).toBe(false);
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

  test("uses durable work invariants and still stops settled auto sessions cleanly", async () => {
    const automatic = { AGENT: true, role: "agent-chat", nextAction: "reflect" };
    const f = await fixture([
      session("active", { agentRuntimeStatus: "running", metadata: automatic }),
      session("uncertain", { metadata: automatic }),
      session("direct", { metadata: automatic }),
      session("supervisor", { metadata: automatic }),
      session("scheduled", { origin: { type: "scheduler", id: "job-1" }, metadata: automatic }),
      session("user-idle"),
      session("settled", { origin: { type: "agent-chat", id: "route" }, metadata: automatic }),
    ]);
    // getQueueCount includes both pending prompts and claimed uncertain deliveries.
    f.queues.set("uncertain", 1);
    f.directTurns.add("direct");
    f.supervisedWork.add("supervisor");

    await requestControlledRestart(f.input as never);
    const operation = await loadControlledRestartOperation(f.input.operationPath);

    expect(operation?.affectedSessionIds.sort()).toEqual([
      "active", "direct", "scheduled", "supervisor", "uncertain", "user-idle",
    ]);
    expect(operation?.sessions.find((entry) => entry.id === "settled")).toMatchObject({
      classification: "settled-auto",
      eligible: false,
      recoveryStatus: "not-eligible",
    });
    expect(f.stopped.sort()).toEqual([
      "active", "direct", "scheduled", "settled", "supervisor", "uncertain", "user-idle",
    ]);
  });

  test("does not resurrect a settled auto Agent Direct session across two restart cycles", async () => {
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const settled = session(`settled-${cycle}`, {
        origin: { type: "agent-chat", id: "route" },
        metadata: { AGENT: true, role: "agent-chat", nextAction: "reflect" },
      });
      const f = await fixture([settled]);
      await requestControlledRestart(f.input as never);
      const marker = await loadWarmRestartMarker(f.input.markerPath);
      const outcome = await restoreRestartedSessions(
        marker,
        f.input.markerPath,
        f.input.manager as never,
        f.input.messageStore as never,
        ["codex"],
        { promptQueueStore: f.input.promptQueueStore, sessionDispatchStore: f.input.sessionDispatchStore } as never,
      );
      expect(marker?.sessionIds).toEqual([]);
      expect(outcome?.restored).toBe(0);
      expect(f.launches()).toBe(0);
      restartDrainGate.leave();
    }
  });
});
