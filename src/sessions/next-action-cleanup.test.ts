import { describe, expect, test } from "bun:test";
import { cleanupStopNextActionSessions } from "./next-action-cleanup";

const now = Date.parse("2026-09-21T12:00:00.000Z");

function session(id: string, options: { automatic?: boolean; ageMinutes?: number; nextAction?: string } = {}) {
  return {
    id,
    agent: "codex",
    name: id,
    status: "running",
    startedAt: new Date(now - (options.ageMinutes ?? 61) * 60_000).toISOString(),
    lastUpdatedAt: null,
    metadata: {
      AGENT: options.automatic ?? true,
      ...(options.nextAction ? { nextAction: options.nextAction } : {}),
    },
  } as any;
}

function harness(sessions: any[], options: {
  lastUpdatedAt?: Record<string, string | null>;
  readiness?: Record<string, "ready" | "busy">;
  protectedIds?: string[];
  currentSessionId?: string;
} = {}) {
  const stopped: string[] = [];
  const archived: string[] = [];
  const byId = new Map(sessions.map((item) => [item.id, item]));
  return {
    stopped,
    archived,
    run: () => cleanupStopNextActionSessions({
      manager: {
        listSessions: () => sessions,
        getSession: (id: string) => byId.get(id),
        stopSession: async (id: string) => { stopped.push(id); return byId.get(id); },
      } as any,
      scheduleArchive: (id) => archived.push(id),
      isSessionProtected: (id) => options.protectedIds?.includes(id) ?? false,
      getLastUpdatedAt: (id) => options.lastUpdatedAt?.[id] ?? null,
      getReadiness: async (item) => ({
        state: options.readiness?.[item.id] ?? "ready",
        reason: "test",
        retryAfterMs: 0,
      }),
      now: () => now,
      currentSessionId: options.currentSessionId,
    }),
  };
}

describe("scheduled automatic-session cleanup", () => {
  test("closes an automatic session older than 60 minutes without nextAction", async () => {
    const f = harness([session("stale", { ageMinutes: 61 })]);
    const result = await f.run();
    expect(result).toMatchObject({ checked: 1, matched: 1, stopped: 1, archiveScheduled: 1, failed: 0 });
    expect(result.details[0]?.reason).toBe("stale");
    expect(f.stopped).toEqual(["stale"]);
  });

  test("preserves automatic sessions at or under 60 minutes", async () => {
    for (const ageMinutes of [59, 60]) {
      const f = harness([session(`age-${ageMinutes}`, { ageMinutes })]);
      const result = await f.run();
      expect(result.matched).toBe(0);
      expect(result.skipped).toEqual([{ id: `age-${ageMinutes}`, reason: "not-stale" }]);
    }
  });

  test("uses authoritative message activity ahead of the start-time fallback", async () => {
    const item = session("recent-output", { ageMinutes: 180 });
    const f = harness([item], { lastUpdatedAt: { "recent-output": new Date(now - 10 * 60_000).toISOString() } });
    const result = await f.run();
    expect(result.matched).toBe(0);
    expect(result.skipped).toEqual([{ id: "recent-output", reason: "not-stale" }]);
  });

  test("preserves user-created sessions regardless of age", async () => {
    const f = harness([session("user", { automatic: false, ageMinutes: 600 })]);
    const result = await f.run();
    expect(result.matched).toBe(0);
    expect(result.skipped).toEqual([{ id: "user", reason: "user-started" }]);
  });

  test("preserves active, protected, and cleanup-runner sessions", async () => {
    const sessions = [session("busy"), session("direct"), session("runner")];
    const f = harness(sessions, {
      readiness: { busy: "busy" },
      protectedIds: ["direct"],
      currentSessionId: "runner",
    });
    const result = await f.run();
    expect(result.matched).toBe(0);
    expect(result.skipped).toEqual([
      { id: "busy", reason: "not-ready" },
      { id: "direct", reason: "protected" },
      { id: "runner", reason: "protected" },
    ]);
  });

  test("still closes nextAction=stop automatic sessions immediately", async () => {
    const f = harness([session("terminal", { ageMinutes: 1, nextAction: "stop" })], {
      readiness: { terminal: "busy" },
    });
    const result = await f.run();
    expect(result).toMatchObject({ matched: 1, stopped: 1, archiveScheduled: 1, failed: 0 });
    expect(result.details[0]?.reason).toBe("next-action-stop");
  });

  test("reports failed eligible work instead of a zero match", async () => {
    const item = session("failed");
    const result = await cleanupStopNextActionSessions({
      manager: {
        listSessions: () => [item], getSession: () => item,
        stopSession: async () => { throw new Error("stop failed"); },
      } as any,
      scheduleArchive: () => {}, getReadiness: async () => ({ state: "ready", reason: "test", retryAfterMs: 0 }),
      now: () => now,
    });
    expect(result).toMatchObject({ matched: 1, stopped: 0, failed: 1 });
    expect(result.details[0]?.error).toBe("stop failed");
  });
});
