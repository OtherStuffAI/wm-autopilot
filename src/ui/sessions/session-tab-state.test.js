import { describe, expect, test } from "bun:test";

import {
  getSessionTabState,
  isSessionComplete,
  sortSessionsForTabState,
} from "./session-tab-state.js";

describe("session tab state", () => {
  const completeAttention = {
    completedAt: "2026-09-01T08:05:00.000Z",
    viewedAt: "2026-09-01T08:00:00.000Z",
  };

  test("treats stable sessions as complete until viewed", () => {
    const session = { id: "done", agentRuntimeStatus: "stable" };
    expect(isSessionComplete(session, completeAttention)).toBe(true);
    expect(isSessionComplete(session, {
      ...completeAttention,
      viewedAt: "2026-09-01T08:06:00.000Z",
    })).toBe(false);
  });

  test("gives selected styling precedence over runtime and attention states", () => {
    const session = { id: "selected", agentRuntimeStatus: "stable" };
    expect(getSessionTabState(session, completeAttention, "selected")).toBe("selected");
    expect(getSessionTabState({ id: "busy", agentRuntimeStatus: "running" }, null, null)).toBe("running");
    expect(getSessionTabState({ id: "ready", agentRuntimeStatus: "stable" }, null, null)).toBe("ready");
  });

  test("promotes complete sessions while preserving each group's normal order", () => {
    const sessions = [
      { id: "ready-1", tabOrder: 1, agentRuntimeStatus: "stable" },
      { id: "complete-1", tabOrder: 2, agentRuntimeStatus: "stable" },
      { id: "running", tabOrder: 3, agentRuntimeStatus: "running" },
      { id: "complete-2", tabOrder: 4, agentRuntimeStatus: "stable" },
    ];
    const attentionById = {
      "complete-1": completeAttention,
      "complete-2": completeAttention,
    };

    expect(sortSessionsForTabState(sessions, attentionById).map((session) => session.id)).toEqual([
      "complete-1",
      "complete-2",
      "ready-1",
      "running",
    ]);
  });
});
