import { describe, expect, test } from "bun:test";

import { resolveLiveSessionUiReconciliation } from "./session-ui-reconciliation.js";

const sessions = [
  { id: "session-alpha", name: "Agent Alpha" },
  { id: "session-autopilot", name: "Autopilot-1" },
];

describe("resolveLiveSessionUiReconciliation", () => {
  test("refreshes chrome when the mounted composer matches the route", () => {
    expect(resolveLiveSessionUiReconciliation({
      sessions,
      routeSessionId: "session-alpha",
      activeSessionId: "session-alpha",
      lastActiveSessionId: null,
      mountedSessionId: "session-alpha",
    })).toEqual({ action: "refresh", sessionId: "session-alpha" });
  });

  test("switches a composer that is detached from the route session", () => {
    expect(resolveLiveSessionUiReconciliation({
      sessions,
      routeSessionId: "session-alpha",
      activeSessionId: "session-alpha",
      lastActiveSessionId: null,
      mountedSessionId: "session-autopilot",
    })).toEqual({ action: "switch", sessionId: "session-alpha" });
  });

  test("rerenders when the route is no longer a live session", () => {
    expect(resolveLiveSessionUiReconciliation({
      sessions,
      routeSessionId: "session-stopped",
      activeSessionId: "session-stopped",
      lastActiveSessionId: null,
      mountedSessionId: "session-stopped",
    })).toEqual({ action: "render", sessionId: null });
  });

  test("rerenders when no composer is mounted yet", () => {
    expect(resolveLiveSessionUiReconciliation({
      sessions,
      routeSessionId: "session-alpha",
      activeSessionId: "session-alpha",
      lastActiveSessionId: null,
      mountedSessionId: null,
    })).toEqual({ action: "render", sessionId: "session-alpha" });
  });
});
