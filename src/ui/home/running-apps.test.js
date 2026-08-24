import { describe, expect, test } from "bun:test";

import { getHomeRunningApps } from "../views/home-view.js";

describe("home running apps", () => {
  test("lists apps with running status", () => {
    const apps = [
      { id: "core", status: { status: "running" } },
      { id: "idle", status: { status: "idle" } },
      { id: "worker", status: { status: "running" } },
    ];

    expect(getHomeRunningApps(apps).map((app) => app.id)).toEqual(["core", "worker"]);
  });

  test("handles missing app lists", () => {
    expect(getHomeRunningApps(null)).toEqual([]);
    expect(getHomeRunningApps({})).toEqual([]);
  });
});
