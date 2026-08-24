import { describe, expect, test } from "bun:test";

import {
  getAlphabeticalApps,
  getAppListAction,
  getRunningApps,
  isRunningApp,
} from "./running-apps-modal.js";

describe("running apps modal helpers", () => {
  test("identifies running apps from app status", () => {
    expect(isRunningApp({ status: { status: "running" } })).toBe(true);
    expect(isRunningApp({ status: { status: "idle" } })).toBe(false);
    expect(isRunningApp({})).toBe(false);
  });

  test("lists user apps that are currently running", () => {
    const apps = [
      { id: "wingman-core", status: { status: "running" } },
      { id: "web", status: { status: "running" } },
      { id: "worker", status: { status: "idle" } },
      { id: "deploy", status: { status: "running" } },
    ];

    expect(getRunningApps(apps).map((app) => app.id)).toEqual(["web", "deploy"]);
  });

  test("sorts modal apps alphabetically and excludes Wingman core", () => {
    const apps = [
      { id: "zeta", label: "Zeta" },
      { id: "wingman-core", label: "Wingman Core" },
      { id: "alpha-10", label: "Alpha 10" },
      { id: "alpha-2", label: "Alpha 2" },
    ];

    expect(getAlphabeticalApps(apps).map((app) => app.id)).toEqual(["alpha-2", "alpha-10", "zeta"]);
  });

  test("chooses start for stopped apps and restart for running apps", () => {
    expect(getAppListAction({
      status: { status: "idle" },
      availableScripts: { start: true, restart: true },
    })).toBe("start");
    expect(getAppListAction({
      status: { status: "running" },
      availableScripts: { start: true, restart: true },
    })).toBe("restart");
    expect(getAppListAction({
      status: { status: "idle" },
      availableScripts: { restart: true },
    })).toBe("restart");
    expect(getAppListAction({
      status: { status: "idle" },
      availableScripts: {},
    })).toBe(null);
  });
});
