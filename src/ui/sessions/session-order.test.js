import { describe, expect, test } from "bun:test";

import { getSessionPosition, sortSessionsForTabs } from "./session-order.js";

describe("session tab ordering", () => {
  test("sorts explicit tab order before start time fallback", () => {
    const sessions = [
      { id: "late", startedAt: "2026-06-12T10:00:00.000Z" },
      { id: "ordered-2", tabOrder: 2, startedAt: "2026-06-12T12:00:00.000Z" },
      { id: "ordered-1", tabOrder: 1, startedAt: "2026-06-12T11:00:00.000Z" },
      { id: "early", startedAt: "2026-06-12T09:00:00.000Z" },
    ];

    expect(sortSessionsForTabs(sessions).map((session) => session.id)).toEqual([
      "ordered-1",
      "ordered-2",
      "early",
      "late",
    ]);
  });

  test("reports a one-based position in the ordered stack", () => {
    const session = { id: "exampleAgent", tabOrder: 2 };
    const sessions = [
      { id: "autopilot", tabOrder: 1 },
      session,
      { id: "fable", tabOrder: 3 },
    ];

    expect(getSessionPosition(session, sessions)).toBe(2);
  });
});
