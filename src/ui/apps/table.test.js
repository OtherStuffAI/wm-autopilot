import { describe, expect, test } from "bun:test";

import {
  filterAndSortApps,
  filterApps,
  getAppDisplayName,
  getAppOpenUrl,
  getAppStatusValue,
  getAppTypeLabel,
  sortApps,
} from "./table.js";

describe("apps table helpers", () => {
  test("summarizes app identity and state for table rows", () => {
    const app = {
      id: "demo-app",
      label: "Demo App",
      webApp: true,
      subdomainUrl: "/host/demo",
      status: { status: "running" },
    };

    expect(getAppDisplayName(app)).toBe("Demo App");
    expect(getAppStatusValue(app)).toBe("running");
    expect(getAppTypeLabel(app)).toBe("Web");
    expect(getAppOpenUrl(app)).toBe("/host/demo");
  });

  test("falls back when optional app fields are missing", () => {
    expect(getAppDisplayName({ id: "worker" })).toBe("worker");
    expect(getAppStatusValue({})).toBe("idle");
    expect(getAppTypeLabel({ webApp: false })).toBe("Process");
    expect(getAppOpenUrl({ webAppUrl: "http://localhost:3700" })).toBe("http://localhost:3700");
  });

  test("filters apps by title, port, and description terms", () => {
    const apps = [
      { id: "adapt", label: "Adapt Studio", webAppPort: 41001, notes: "Design workspace" },
      { id: "worker", label: "Queue Worker", webAppPort: 42000, notes: "Background jobs" },
      { id: "aperture", label: "Aperture", webAppPort: 41002, description: "Image review" },
    ];

    expect(filterApps(apps, "apt").map((app) => app.id)).toEqual(["adapt"]);
    expect(filterApps(apps, "410").map((app) => app.id)).toEqual(["adapt", "aperture"]);
    expect(filterApps(apps, "image").map((app) => app.id)).toEqual(["aperture"]);
  });

  test("sorts apps by title, port, updated time, and status", () => {
    const apps = [
      { id: "b", label: "Beta", webAppPort: 41002, status: { status: "running", updatedAt: "2026-01-02T00:00:00Z" } },
      { id: "a", label: "Alpha", webAppPort: 41001, status: { status: "failed", updatedAt: "2026-01-03T00:00:00Z" } },
      { id: "c", label: "Gamma", status: { status: "idle", updatedAt: "2026-01-01T00:00:00Z" } },
    ];

    expect(sortApps(apps, { key: "title", direction: "asc" }).map((app) => app.id)).toEqual(["a", "b", "c"]);
    expect(sortApps(apps, { key: "port", direction: "asc" }).map((app) => app.id)).toEqual(["a", "b", "c"]);
    expect(sortApps(apps, { key: "port", direction: "desc" }).map((app) => app.id)).toEqual(["b", "a", "c"]);
    expect(sortApps(apps, { key: "updated", direction: "desc" }).map((app) => app.id)).toEqual(["a", "b", "c"]);
    expect(sortApps(apps, { key: "status", direction: "asc" }).map((app) => app.id)).toEqual(["a", "c", "b"]);
  });

  test("filters before sorting", () => {
    const apps = [
      { id: "b", label: "Beta", webAppPort: 41002 },
      { id: "a", label: "Alpha", webAppPort: 41001 },
      { id: "c", label: "Gamma", webAppPort: 42001 },
    ];

    expect(filterAndSortApps(apps, "410", { key: "title", direction: "asc" }).map((app) => app.id)).toEqual(["a", "b"]);
  });
});
