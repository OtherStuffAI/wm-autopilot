import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { buildUserAppSpawnPlan, superviseUserAppChild } from "./app-runner";
import { appCommand } from "./app-command";

describe("buildUserAppSpawnPlan", () => {
  test("uses only runtime essentials and explicitly managed app env", async () => {
    const plan = await buildUserAppSpawnPlan(
      {
        appId: "app-1",
        appLabel: "Demo App",
        appRoot: "/tmp/demo-app",
        startCommand: appCommand("bun", "run", "start"),
        userAlias: "owner",
        port: "4100",
        runtimeEnvEnvelope: { path: "/tmp/runtime-env.json", key: "test-key" },
      },
      {
        hostEnv: {
          API_TOKEN: "from-host",
          HOST_ONLY: "yes",
          PORT: "3000",
          WINGMAN_PRIV: "server-secret-sentinel",
          OPENROUTER_API_KEY: "provider-secret-sentinel",
          SSH_AUTH_SOCK: "/tmp/agent.sock",
          HOME: "/host/home",
          PATH: "/runtime/bin",
        },
        runtimeEnvReader: async () => ({
          API_TOKEN: "from-card",
          APP_ID: "ignored-by-runtime",
        }),
        redshiftDetector: async () => false,
      },
    );

    expect(plan.env.API_TOKEN).toBe("from-card");
    expect(plan.env.HOST_ONLY).toBeUndefined();
    expect(plan.env.DOTENV_ONLY).toBeUndefined();
    expect(plan.env.WINGMAN_PRIV).toBeUndefined();
    expect(plan.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(plan.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(plan.env.HOME).toBeUndefined();
    expect(plan.env.PATH).toBe("/runtime/bin");
    expect(plan.env.APP_ID).toBe("app-1");
    expect(plan.env.PORT).toBe("4100");
    expect(plan.cmd).toEqual(["bun", "run", "start"]);
  });
});

describe("superviseUserAppChild", () => {
  test("forwards PM2 termination to the complete app process group", async () => {
    const signalSource = new EventEmitter();
    const groupSignals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    let finish!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const directSignals: Array<NodeJS.Signals | number | undefined> = [];

    const supervised = superviseUserAppChild({
      pid: 4321,
      exited,
      kill: (signal) => {
        directSignals.push(signal);
      },
    }, {
      signalSource: signalSource as any,
      platform: "darwin",
      killProcessGroup: (pid, signal) => {
        groupSignals.push({ pid, signal });
      },
      forceKillAfterMs: 10_000,
    });

    signalSource.emit("SIGTERM");
    expect(groupSignals).toEqual([{ pid: -4321, signal: "SIGTERM" }]);
    expect(directSignals).toEqual([]);
    finish(0);
    await expect(supervised).resolves.toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  test("falls back to signalling the direct child when process groups are unavailable", async () => {
    const signalSource = new EventEmitter();
    const directSignals: Array<NodeJS.Signals | number | undefined> = [];
    let finish!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });

    const supervised = superviseUserAppChild({
      pid: 4321,
      exited,
      kill: (signal) => {
        directSignals.push(signal);
      },
    }, {
      signalSource: signalSource as any,
      platform: "darwin",
      killProcessGroup: () => {
        throw new Error("unsupported");
      },
      forceKillAfterMs: 10_000,
    });

    signalSource.emit("SIGINT");
    expect(directSignals).toEqual(["SIGINT"]);
    finish(0);
    await expect(supervised).resolves.toBe(0);
  });
});
