import { describe, expect, test } from "bun:test";

import type { SessionSnapshot } from "../agents/process-manager";
import { shouldArchiveStoppedSession } from "./stopped-session-archive";

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "session-1",
    agent: "codex",
    port: 3700,
    name: "session",
    status: "stopped",
    agentRuntimeStatus: "stable",
    startedAt: "2026-09-15T06:00:00.000Z",
    command: [],
    workingDirectory: "/tmp/project",
    logs: [],
    origin: { type: "agent-work", id: "task-1" },
    metadata: { AGENT: true, billingMode: "subscription" },
    ...overrides,
  };
}

describe("shouldArchiveStoppedSession", () => {
  test("archives stopped automatically managed sessions", () => {
    expect(shouldArchiveStoppedSession(session())).toBe(true);
  });

  test("does not archive user-started stopped sessions", () => {
    expect(shouldArchiveStoppedSession(session({
      origin: undefined,
      metadata: { AGENT: false, billingMode: "subscription" },
    }))).toBe(false);
  });

  test("does not archive running or protected sessions", () => {
    expect(shouldArchiveStoppedSession(session({ status: "running" }))).toBe(false);
    expect(shouldArchiveStoppedSession(session(), { isProtected: () => true })).toBe(false);
  });
});
