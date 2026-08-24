import { describe, expect, test } from "bun:test";

import type { SessionSnapshot } from "../agents/process-manager";
import { closeStaleStableAutoSessions } from "./bulk-close-auto-sessions";

const NOW = Date.parse("2026-07-25T05:00:00.000Z");

function session(id: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id,
    agent: "codex",
    port: 3700,
    name: id,
    status: "running",
    agentRuntimeStatus: "stable",
    startedAt: new Date(NOW - 60 * 60_000).toISOString(),
    command: [],
    workingDirectory: "/tmp",
    logs: [],
    origin: { type: "agent-work", id: `origin-${id}` },
    metadata: { AGENT: true, billingMode: "subscription" },
    ...overrides,
  };
}

function harness(input: {
  sessions: SessionSnapshot[];
  updatedAt?: Record<string, string | null>;
  readiness?: Record<string, "ready" | "busy">;
  beforeSecondReadiness?: (id: string, sessions: Map<string, SessionSnapshot>) => void;
  stopErrorId?: string;
}) {
  const current = new Map(input.sessions.map((item) => [item.id, item]));
  const stopped: string[] = [];
  const archived: string[] = [];
  const readinessCalls = new Map<string, number>();
  return {
    stopped,
    archived,
    run: () => closeStaleStableAutoSessions({
      sessions: input.sessions,
      manager: {
        getSession: (id) => current.get(id),
        stopSession: async (id) => {
          if (id === input.stopErrorId) throw new Error("stop failed");
          const item = current.get(id);
          if (item) stopped.push(id);
          return item;
        },
      },
      now: () => NOW,
      getLastUpdatedAt: (id) => input.updatedAt?.[id] ?? new Date(NOW - 22 * 60_000).toISOString(),
      getReadiness: async (item) => {
        const calls = (readinessCalls.get(item.id) ?? 0) + 1;
        readinessCalls.set(item.id, calls);
        if (calls === 2) input.beforeSecondReadiness?.(item.id, current);
        const state = input.readiness?.[item.id] ?? "ready";
        return { state, reason: `test-${state}`, retryAfterMs: 1, observedAt: NOW };
      },
      onClosed: (id) => archived.push(id),
    }),
  };
}

describe("closeStaleStableAutoSessions", () => {
  test("closes stable auto sessions but never user-created sessions", async () => {
    const auto = session("auto");
    const user = session("user", { origin: undefined, metadata: { AGENT: false, billingMode: "subscription" } });
    const testHarness = harness({ sessions: [auto, user] });

    const result = await testHarness.run();

    expect(result.closed).toEqual(["auto"]);
    expect(result.skipped).toContainEqual({ id: "user", reason: "user-started" });
    expect(testHarness.archived).toEqual(["auto"]);
  });

  test("closes an old stable worker with the exact production dispatch shape", async () => {
    const dispatchedWorker = session("production-dispatched-worker", {
      origin: { type: "session-dispatch", id: "supervisor-session" },
      metadata: { AGENT: false, role: "dispatched-worker", billingMode: "subscription" },
    });
    const testHarness = harness({
      sessions: [dispatchedWorker],
      updatedAt: {
        [dispatchedWorker.id]: new Date(NOW - 21 * 60_000 - 1).toISOString(),
      },
    });

    const result = await testHarness.run();

    expect(result.eligible).toBe(1);
    expect(result.closed).toEqual([dispatchedWorker.id]);
    expect(result.skipped).toEqual([]);
    expect(testHarness.archived).toEqual([dispatchedWorker.id]);
  });

  test("uses a strict more-than-21-minute boundary", async () => {
    const boundary = session("boundary");
    const older = session("older");
    const testHarness = harness({
      sessions: [boundary, older],
      updatedAt: {
        boundary: new Date(NOW - 21 * 60_000).toISOString(),
        older: new Date(NOW - 21 * 60_000 - 1).toISOString(),
      },
    });

    const result = await testHarness.run();

    expect(result.closed).toEqual(["older"]);
    expect(result.skipped).toContainEqual({ id: "boundary", reason: "not-stale" });
  });

  test("skips thinking sessions using runtime readiness", async () => {
    const testHarness = harness({ sessions: [session("thinking")], readiness: { thinking: "busy" } });
    const result = await testHarness.run();
    expect(result.closed).toEqual([]);
    expect(result.skipped).toEqual([{ id: "thinking", reason: "not-stable" }]);
  });

  test("re-checks state before mutation and preserves a session that becomes busy", async () => {
    let readinessCall = 0;
    const item = session("racing");
    const current = new Map([[item.id, item]]);
    const stopped: string[] = [];
    const result = await closeStaleStableAutoSessions({
      sessions: [item],
      manager: {
        getSession: (id) => current.get(id),
        stopSession: async (id) => {
          stopped.push(id);
          return current.get(id);
        },
      },
      now: () => NOW,
      getLastUpdatedAt: () => new Date(NOW - 22 * 60_000).toISOString(),
      getReadiness: async () => ({
        state: ++readinessCall === 1 ? "ready" : "busy",
        reason: "race",
        retryAfterMs: 1,
        observedAt: NOW,
      }),
      onClosed: () => {},
    });

    expect(stopped).toEqual([]);
    expect(result.skipped).toEqual([{ id: "racing", reason: "not-stable" }]);
  });

  test("continues after a close error and reports failed and successful items", async () => {
    const testHarness = harness({
      sessions: [session("fails"), session("closes")],
      stopErrorId: "fails",
    });
    const result = await testHarness.run();
    expect(result.failed).toEqual([{ id: "fails", error: "stop failed" }]);
    expect(result.closed).toEqual(["closes"]);
    expect(result.eligible).toBe(2);
  });
});
