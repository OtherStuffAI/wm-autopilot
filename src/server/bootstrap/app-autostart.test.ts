import { describe, expect, test } from "bun:test";

import type { AppRecord } from "../../apps/app-registry";
import type { AppProcessStatus } from "../../apps/app-process-manager";
import { autostartApps } from "./app-autostart";
import { appCommand } from "../../apps/app-command";

function app(overrides: Partial<AppRecord>): AppRecord {
  return {
    id: overrides.id ?? "app-1",
    label: overrides.label ?? "Test App",
    root: overrides.root ?? "/tmp/test-app",
    scripts: overrides.scripts ?? { start: appCommand("bun", "run", "start") },
    tmuxSession: overrides.tmuxSession ?? "test-app",
    pm2Name: overrides.pm2Name,
    logsDir: overrides.logsDir,
    notes: overrides.notes,
    ownerNpub: overrides.ownerNpub ?? null,
    autoStart: overrides.autoStart ?? false,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    webApp: overrides.webApp ?? false,
    webAppPort: overrides.webAppPort ?? null,
  };
}

function status(overrides: Partial<AppProcessStatus>): AppProcessStatus {
  return {
    appId: overrides.appId ?? "app-1",
    status: overrides.status ?? "idle",
    lastAction: overrides.lastAction ?? null,
    lastExitCode: overrides.lastExitCode ?? null,
    message: overrides.message,
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    lastSuccessAt: overrides.lastSuccessAt,
    lastFailureAt: overrides.lastFailureAt,
    running: overrides.running ?? false,
    inProgressAction: overrides.inProgressAction ?? null,
    runtimePort: overrides.runtimePort,
    pid: overrides.pid,
    memory: overrides.memory,
  };
}

describe("autostartApps", () => {
  test("restarts stopped apps marked for autostart", async () => {
    const restarted: string[] = [];
    const result = await autostartApps(
      {
        listApps: async () => [
          app({ id: "auto", label: "Auto", autoStart: true }),
          app({ id: "manual", label: "Manual", autoStart: false }),
        ],
      },
      {
        getStatus: async (appId) => status({ appId, running: false }),
        restart: async (appId) => {
          restarted.push(appId);
          return status({ appId, status: "running", running: true });
        },
      },
      { log: () => undefined, warn: () => undefined },
    );

    expect(restarted).toEqual(["auto"]);
    expect(result.started).toBe(1);
    expect(result.checked).toBe(1);
  });

  test("restarts running apps marked for autostart", async () => {
    const restarted: string[] = [];
    const result = await autostartApps(
      {
        listApps: async () => [
          app({ id: "running", label: "Running", autoStart: true }),
        ],
      },
      {
        getStatus: async (appId) => status({ appId, status: "running", running: true }),
        restart: async (appId) => {
          restarted.push(appId);
          return status({ appId, status: "running", running: true });
        },
      },
      { log: () => undefined, warn: () => undefined },
    );

    expect(restarted).toEqual(["running"]);
    expect(result.started).toBe(1);
    expect(result.skippedRunning).toBe(0);
  });

  test("skips apps that are missing a start script or already have an action in progress", async () => {
    const restarted: string[] = [];
    const result = await autostartApps(
      {
        listApps: async () => [
          app({ id: "missing", label: "Missing", autoStart: true, scripts: {} }),
          app({ id: "busy", label: "Busy", autoStart: true }),
        ],
      },
      {
        getStatus: async (appId) => status({
          appId,
          status: appId === "busy" ? "restarting" : "idle",
          running: false,
          inProgressAction: appId === "busy" ? "restart" : null,
        }),
        restart: async (appId) => {
          restarted.push(appId);
          return status({ appId, status: "running", running: true });
        },
      },
      { log: () => undefined, warn: () => undefined },
    );

    expect(restarted).toEqual([]);
    expect(result.skippedInProgress).toBe(1);
    expect(result.skippedMissingStartScript).toBe(1);
  });
});

test("abandons a stalled app and continues with the next app", async () => {
  const restarted: string[] = [];
  let abandoned: AbortSignal | undefined;
  const result = await autostartApps(
    { listApps: async () => [app({ id: "stalled", autoStart: true }), app({ id: "next", autoStart: true })] },
    {
      getStatus: async (appId) => status({ appId }),
      restart: async (appId, signal) => {
        restarted.push(appId);
        if (appId === "stalled") {
          abandoned = signal;
          return new Promise(() => {});
        }
        return status({ appId, running: true });
      },
    },
    { log() {}, warn() {} },
    10,
  );
  expect(restarted).toEqual(["stalled", "next"]);
  expect(abandoned?.aborted).toBe(true);
  expect(result.started).toBe(1);
  expect(result.failed[0]?.error).toContain("start manually from the Apps UI");
});

test("deadline also covers stalled status checks", async () => {
  let restarted = false;
  const result = await autostartApps(
    { listApps: async () => [app({ autoStart: true })] },
    {
      getStatus: async () => new Promise(() => {}),
      restart: async () => { restarted = true; return status({}); },
    },
    { log() {}, warn() {} },
    10,
  );
  expect(restarted).toBe(false);
  expect(result.failed).toHaveLength(1);
});
