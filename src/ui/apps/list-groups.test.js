import { describe, expect, test } from "bun:test";

import { partitionAppsByRuntimeStatus } from "./list-groups.js";

describe("app runtime groups", () => {
  test("puts running apps first and every non-running state in stopped apps", () => {
    const groups = partitionAppsByRuntimeStatus([
      { id: "idle", status: { status: "idle" } },
      { id: "live", status: { status: "running" } },
      { id: "failed", status: { status: "failed" } },
      { id: "missing-status" },
    ]);

    expect(groups.running.map((app) => app.id)).toEqual(["live"]);
    expect(groups.stopped.map((app) => app.id)).toEqual(["idle", "failed", "missing-status"]);
  });

  test("handles missing app lists", () => {
    expect(partitionAppsByRuntimeStatus(null)).toEqual({ running: [], stopped: [] });
  });
});
