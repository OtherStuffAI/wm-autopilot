import { describe, expect, test } from "bun:test";

import { resolveHomeSessionStatus } from "./session-status.js";

describe("home session status presentation", () => {
  test("shows stopped sessions as stopped even when runtime status is stale", () => {
    expect(resolveHomeSessionStatus({
      status: "stopped",
      agentRuntimeStatus: "running",
    })).toMatchObject({
      key: "stopped",
      label: "Stopped",
    });
  });

  test("separates waiting sessions from sessions with active turns", () => {
    expect(resolveHomeSessionStatus({
      status: "running",
      agentRuntimeStatus: "stable",
    })).toMatchObject({
      key: "online",
      label: "Online",
    });

    expect(resolveHomeSessionStatus({
      status: "running",
      agentRuntimeStatus: "running",
    })).toMatchObject({
      key: "active",
      label: "Active",
    });
  });

  test("surfaces missing runtime state as an error for live sessions", () => {
    expect(resolveHomeSessionStatus({
      status: "running",
      agentRuntimeStatus: null,
    })).toMatchObject({
      key: "error",
      label: "Error",
    });
  });
});
