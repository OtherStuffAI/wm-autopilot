import { describe, expect, test } from "bun:test";

import { buildUserAppSpawnPlan } from "./app-runner";
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
        appEnvReader: async () => ({
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
