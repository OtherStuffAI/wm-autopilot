import { describe, expect, test } from "bun:test";

import { appCommand } from "./app-command";
import { buildManagedAppSpawnPlan } from "./app-runtime-env";

describe("managed app lifecycle environment", () => {
  for (const action of ["start", "setup", "build"] as const) {
    test(`${action} uses argv and excludes parent Autopilot secrets`, () => {
      const plan = buildManagedAppSpawnPlan({
        app: {
          id: "app-1",
          label: "App",
          env: { APP_SETTING: "explicit", WAPP_NSEC: "nsec1forbidden", BUNKER_URI: "bunker://forbidden" },
          webAppPort: 4100,
        },
        command: appCommand("bun", "run", action),
        cwd: "/tmp/app",
        userAlias: "admin",
        hostEnv: {
          PATH: "/runtime/bin",
          WINGMAN_PRIV: "sentinel",
          WINGMAN_CAPABILITY: "sentinel",
          IDENTITY_SESSION_SECRET: "sentinel",
          OPENROUTER_API_KEY: "sentinel",
          CAPROVER_URL: "sentinel",
          LOGIN_CODE: "sentinel",
          GITHUB_TOKEN: "sentinel",
          SSH_AUTH_SOCK: "sentinel",
          HOME: "/host/home",
        },
      });
      expect(plan.cmd).toEqual(["bun", "run", action]);
      expect(plan.env.APP_SETTING).toBe("explicit");
      for (const secret of [
        "WINGMAN_PRIV",
        "WINGMAN_CAPABILITY",
        "IDENTITY_SESSION_SECRET",
        "OPENROUTER_API_KEY",
        "CAPROVER_URL",
        "LOGIN_CODE",
        "GITHUB_TOKEN",
        "SSH_AUTH_SOCK",
        "HOME",
        "WAPP_NSEC",
        "BUNKER_URI",
      ]) expect(plan.env[secret]).toBeUndefined();
    });
  }
});
