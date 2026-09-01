import { describe, expect, test } from "bun:test";

import { buildSessionAttentionChanges } from "./session-attention.js";

describe("session attention transitions", () => {
  const now = "2026-09-01T08:05:00.000Z";

  test("records a new running turn", () => {
    const result = buildSessionAttentionChanges(
      [{ id: "session-1", agentRuntimeStatus: "running" }],
      [{ sessionId: "session-1", runtimeStatus: "stable", viewedAt: "2026-09-01T08:00:00.000Z" }],
      null,
      now,
    );

    expect(result.updates[0]).toEqual({
      sessionId: "session-1",
      runtimeStatus: "running",
      viewedAt: "2026-09-01T08:00:00.000Z",
      lastRunningAt: now,
    });
  });

  test("marks an unviewed running to stable transition complete", () => {
    const result = buildSessionAttentionChanges(
      [{ id: "session-1", agentRuntimeStatus: "stable" }],
      [{ sessionId: "session-1", runtimeStatus: "running", lastRunningAt: "2026-09-01T08:00:00.000Z" }],
      null,
      now,
    );

    expect(result.updates[0].completedAt).toBe(now);
    expect(result.updates[0].viewedAt).toBeUndefined();
  });

  test("considers a transition read when the session is currently viewed", () => {
    const result = buildSessionAttentionChanges(
      [{ id: "session-1", agentRuntimeStatus: "stable" }],
      [{ sessionId: "session-1", runtimeStatus: "running" }],
      "session-1",
      now,
    );

    expect(result.updates[0].completedAt).toBe(now);
    expect(result.updates[0].viewedAt).toBe(now);
  });
});
