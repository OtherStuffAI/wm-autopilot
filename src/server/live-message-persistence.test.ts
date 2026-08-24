import { describe, expect, test } from "bun:test";

import type { SessionSnapshot } from "../agents/process-manager";
import { LiveMessagePersistenceLoop, shouldPersistSession } from "./live-message-persistence";

const makeSession = (id: string, status: SessionSnapshot["status"] = "running"): SessionSnapshot => ({
  id,
  agent: "codex",
  status,
  npub: "npub1owner",
  port: 3700,
  pid: 1234,
  name: id,
  startedAt: new Date().toISOString(),
  command: ["codex"],
  workingDirectory: "/tmp/project",
  logs: [],
  agentRuntimeStatus: status === "running" ? "running" : "stable",
  origin: null,
  pm2Name: null,
  targetFile: undefined,
  metadata: { AGENT: false, billingMode: "subscription" },
});

class FakeManager {
  sessions: SessionSnapshot[] = [];
  listeners = new Set<(event: { type: "session-started" | "session-updated" | "session-stopped" | "session-deleted"; session: SessionSnapshot }) => void>();

  listSessions() {
    return this.sessions;
  }

  on(listener: (event: { type: "session-started" | "session-updated" | "session-stopped" | "session-deleted"; session: SessionSnapshot }) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type: "session-started" | "session-updated" | "session-stopped" | "session-deleted", session: SessionSnapshot) {
    for (const listener of this.listeners) {
      listener({ type, session });
    }
  }
}

describe("live message persistence", () => {
  test("shouldPersistSession only includes running sessions", () => {
    expect(shouldPersistSession(makeSession("running", "running"))).toBe(true);
    expect(shouldPersistSession(makeSession("stopped", "stopped"))).toBe(false);
    expect(shouldPersistSession(makeSession("error", "error"))).toBe(false);
  });

  test("sweepOnce forces sync for running sessions only", async () => {
    const manager = new FakeManager();
    manager.sessions = [makeSession("running-1", "running"), makeSession("stopped-1", "stopped")];
    const calls: Array<[string, boolean | undefined]> = [];
    const loop = new LiveMessagePersistenceLoop({
      manager,
      syncSessionMessages: async (sessionId, force) => {
        calls.push([sessionId, force]);
        return [];
      },
      intervalMs: 1000,
      initialDelayMs: 60_000,
    });

    await loop.sweepOnce();

    expect(calls).toEqual([["running-1", true]]);
    loop.stop();
  });

  test("sweepOnce rate limits repeated syncs within the interval", async () => {
    const manager = new FakeManager();
    manager.sessions = [makeSession("running-1", "running")];
    const calls: Array<[string, boolean | undefined]> = [];
    const loop = new LiveMessagePersistenceLoop({
      manager,
      syncSessionMessages: async (sessionId, force) => {
        calls.push([sessionId, force]);
        return [];
      },
      intervalMs: 60_000,
      initialDelayMs: 60_000,
    });

    await loop.sweepOnce();
    await loop.sweepOnce();

    expect(calls).toEqual([["running-1", true]]);
    loop.stop();
  });

  test("bounds concurrent multi-session hydration and only publishes changed revisions", async () => {
    const manager = new FakeManager();
    manager.sessions = Array.from({ length: 5 }, (_, index) => makeSession(`running-${index}`));
    let active = 0;
    let maxActive = 0;
    const updates: string[] = [];
    const loop = new LiveMessagePersistenceLoop({
      manager,
      syncSessionMessages: async (sessionId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return [{ role: "assistant", content: "same", createdAt: sessionId }];
      },
      intervalMs: 0,
      initialDelayMs: 60_000,
      maxConcurrency: 2,
      onMessagesChanged: (sessionId) => updates.push(sessionId),
    });

    await loop.sweepOnce();
    await loop.sweepOnce();

    expect(maxActive).toBe(2);
    expect(updates).toHaveLength(5);
    loop.stop();
  });
});
