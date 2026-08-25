import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { generateSecretKey, nip19 } from "nostr-tools";

import type { AppRecord } from "../apps/app-registry";
import type { WingmanConfig } from "../config";
import { WappStore } from "../wapps/wapp-store";
import { getWappRuntimeEnvForWapp } from "../wapps/runtime-env";
import { buildUserAppSpawnPlan } from "../apps/app-runner";
import { appCommand } from "../apps/app-command";
import { consumeAppRuntimeEnvelope } from "../apps/app-runtime-envelope";
import {
  addAppToEcosystem,
  addUserAppToEcosystem,
  createAgentPm2StartOptions,
  createUserAppEcosystemConfig,
  getEcosystemPath,
  getLogsDirectory,
  readEcosystemConfig,
  withEcosystemConfigLock,
  type SessionConfig,
} from "./ecosystem-generator";

function makeApp(id: string, root: string): AppRecord {
  return {
    id,
    label: id === "wapp-app" ? "WApp App" : "Plain App",
    root,
    scripts: { start: appCommand("bun", "src/server.ts") },
    tmuxSession: id,
    ownerNpub: "npub1owner",
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    webApp: true,
    webAppPort: id === "wapp-app" ? 4010 : 4011,
  };
}

function makeSessionConfig(root: string, index: number): SessionConfig {
  const port = 4700 + index;
  return {
    sessionId: `session-${index}`,
    sessionName: `[sched] Concurrent ${index}`,
    agent: "codex",
    port,
    workingDirectory: root,
    userAlias: "tester",
    isAdmin: false,
    config: {
      agents: {
        codex: {
          label: "Codex",
          command: () => ["agentapi", "server", "--port", String(port), "--", "codex"],
        },
      },
    } as unknown as WingmanConfig,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createUserAppEcosystemConfig WApp env injection", () => {
  test("uses an absolute admin log directory so PM2 and the log API agree", () => {
    expect(isAbsolute(getLogsDirectory("/ignored", true))).toBe(true);
  });

  test("injects WAPP vars only for active WApp assignments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ecosystem-wapp-"));
    try {
      const store = new WappStore(join(dir, "wapps.sqlite"));
      const wappRoot = join(dir, "wapp-root");
      const plainRoot = join(dir, "plain-root");
      store.create({
        id: "wapp-1",
        appId: "wapp-app",
        title: "WApp App",
        ownerNpub: "npub1owner",
        createdByNpub: "npub1owner",
        workspaceOwnerNpub: "npub1workspace",
        scopeId: "scope-1",
        allowedNpubs: ["npub1member", "npub1owner"],
        launchUrl: "https://apps.example/wapp",
      });

      const wappConfig = await createUserAppEcosystemConfig({
        app: makeApp("wapp-app", wappRoot),
        userAlias: "tester",
        userRootDir: dir,
        isAdmin: false,
        wappStore: store,
      });
      const plainConfig = await createUserAppEcosystemConfig({
        app: makeApp("plain-app", plainRoot),
        userAlias: "tester",
        userRootDir: dir,
        isAdmin: false,
        wappStore: store,
      });

      const wappCommand = wappConfig.args.join(" ");
      expect(wappConfig.script).toBe("bun");
      expect(wappCommand).toContain("app-runner.ts");
      expect(wappConfig.args).toContain("--wapp-id");
      expect(wappConfig.args).toContain("wapp-1");
      expect(JSON.stringify(wappConfig)).not.toContain("WAPP_DB_PATH");

      const runnerPlan = await buildUserAppSpawnPlan({
        appId: "wapp-app",
        appLabel: "WApp App",
        appRoot: wappRoot,
        startCommand: appCommand("bun", "src/server.ts"),
        userAlias: "tester",
        port: "4010",
        wappId: "wapp-1",
        runtimeEnvEnvelope: { path: "/tmp/runtime-env.json", key: "test-key" },
      }, {
        hostEnv: {},
        runtimeEnvReader: async () => getWappRuntimeEnvForWapp("wapp-1", wappRoot, store),
        redshiftDetector: async () => false,
      });
      expect(runnerPlan.env.WAPP_ID).toBe("wapp-1");
      expect(runnerPlan.env.WAPP_APP_ID).toBe("wapp-app");
      expect(runnerPlan.env.WAPP_DB_PATH).toBe(join(wappRoot, "data", "db.sqlite"));
      expect(runnerPlan.env.WAPP_ALLOWED_NPUBS_JSON).toBe("[\"npub1member\",\"npub1owner\"]");
      expect(runnerPlan.env.PORT).toBe("4010");

      const plainCommand = plainConfig.args[1] ?? "";
      expect(plainCommand).not.toContain("WAPP_ID=");
      expect(plainCommand).not.toContain("WAPP_DB_PATH=");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails closed for Tower-backed WApps until an installation-scoped broker capability exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ecosystem-wapp-tower-"));
    try {
      const store = new WappStore(join(dir, "wapps.sqlite"));
      const appNsec = nip19.nsecEncode(generateSecretKey());
      const binding = store.createTowerBinding({
        id: "tower-dev",
        label: "Tower Dev",
        towerUrl: "https://tower.example",
        workspaceOwnerNpub: "npub1workspace",
        userAlias: "tester",
        isDefault: true,
      });
      store.create({
        id: "wapp-tower",
        appId: "wapp-app",
        title: "Tower WApp",
        ownerNpub: "npub1owner",
        createdByNpub: "npub1owner",
        workspaceOwnerNpub: "npub1workspace",
        scopeId: "scope-1",
        allowedNpubs: ["npub1owner"],
        launchUrl: "https://apps.example/wapp",
        towerBindingId: binding.id,
        appKeyMode: "import",
        appNsec,
      });

      const wappConfig = await createUserAppEcosystemConfig({
        app: makeApp("wapp-app", join(dir, "wapp-root")),
        userAlias: "tester",
        userRootDir: dir,
        isAdmin: false,
        wappStore: store,
      });

      const command = wappConfig.args.join(" ");
      const serializedConfig = JSON.stringify(wappConfig);
      expect(command).toContain("app-runner.ts");
      expect(serializedConfig).toContain("--wapp-id");
      expect(serializedConfig).toContain("wapp-tower");
      expect(serializedConfig).not.toContain(appNsec);
      expect(wappConfig.filter_env).toContain("WAPP_NSEC");

      await expect(addUserAppToEcosystem({
        app: makeApp("wapp-app", join(dir, "wapp-root")),
        userAlias: "tester",
        userRootDir: dir,
        isAdmin: false,
        wappStore: store,
      })).rejects.toThrow("installation-scoped NIP-98 signing broker capability");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agent ecosystem config concurrency", () => {
  test("builds inline PM2 options for agent sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-pm2-options-"));
    try {
      const options = createAgentPm2StartOptions(makeSessionConfig(dir, 3));

      expect(options.name).toBe("tester-sched-concurrent-3-session3");
      expect(options.namespace).toBe("wingman-agents");
      expect(options.script).toBe("bash");
      expect(options.interpreter).toBe("none");
      expect(options.args[0]).toBe("-lc");
      expect(options.args[1]).toContain("agentapi");
      expect(options.args[1]).toContain("--port");
      expect(options.args[1]).toContain("4703");
      expect(options.cwd).toBe(dir);
      expect(options.env?.SESSION_ID).toBe("session-3");
      expect(options.filterEnv).toContain("AGENT_NSEC");
      expect(options.filterEnv).toContain("WINGMAN_SIGNING_");
      expect(options.filterEnv).toContain("pm_");
      expect(options.filterEnv).toContain("PM2_");
      expect(options.filterEnv).toContain("exec_");
      expect(options.filterEnv).toContain("autorestart");
      expect(options.filterEnv).toContain("name");
      expect(options.filterEnv).toContain("namespace");
      expect(options.output).toContain("tester-sched-concurrent-3-session3-out.log");
      expect(options.error).toContain("tester-sched-concurrent-3-session3-error.log");
      expect(options.autorestart).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects executable ecosystem configuration instead of evaluating it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ecosystem-untrusted-"));
    const path = getEcosystemPath(dir, false);
    try {
      writeFileSync(path, "module.exports = (() => ({ apps: [] }))();\n");
      await expect(readEcosystemConfig(path)).rejects.toThrow("Refusing executable or malformed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serializes operations for the same ecosystem path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ecosystem-lock-"));
    try {
      const ecosystemPath = getEcosystemPath(dir, false);
      const events: string[] = [];

      await Promise.all([
        withEcosystemConfigLock(ecosystemPath, async () => {
          events.push("first:start");
          await sleep(20);
          events.push("first:end");
        }),
        withEcosystemConfigLock(ecosystemPath, async () => {
          events.push("second:start");
          events.push("second:end");
        }),
      ]);

      expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves all app entries across concurrent session additions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ecosystem-concurrent-"));
    try {
      const sessions = Array.from({ length: 8 }, (_, index) => makeSessionConfig(dir, index));

      await Promise.all(sessions.map((sessionConfig) => addAppToEcosystem(sessionConfig)));

      const config = await readEcosystemConfig(getEcosystemPath(dir, false));
      const sessionIds = config.apps.map((app) => app.env?.SESSION_ID).sort();
      expect(sessionIds).toEqual(sessions.map((session) => session.sessionId).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("user app ecosystem config concurrency", () => {
  test("keeps managed app environment plaintext out of the PM2 ecosystem file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ecosystem-user-app-env-"));
    try {
      const app = {
        ...makeApp("plain-app", join(dir, "app")),
        env: { API_TOKEN: "managed-secret-sentinel" },
      };
      const launch = await addUserAppToEcosystem({
        app,
        userAlias: "tester",
        userRootDir: dir,
        isAdmin: false,
      });
      const config = await readEcosystemConfig(getEcosystemPath(dir, false));
      const pm2App = config.apps.find((entry) => entry.name === launch.processName);
      const pathIndex = pm2App?.args.indexOf("--runtime-env-path") ?? -1;
      const keyIndex = pm2App?.args.indexOf("--runtime-env-key") ?? -1;

      expect(JSON.stringify(config)).not.toContain("managed-secret-sentinel");
      expect(pathIndex).toBeGreaterThanOrEqual(0);
      expect(keyIndex).toBeGreaterThanOrEqual(0);
      await expect(consumeAppRuntimeEnvelope({
        path: pm2App!.args[pathIndex + 1]!,
        key: pm2App!.args[keyIndex + 1]!,
      }, app.id)).resolves.toEqual({ API_TOKEN: "managed-secret-sentinel" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves all app entries across concurrent user app additions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ecosystem-user-apps-"));
    try {
      const apps = Array.from({ length: 6 }, (_, index) => ({
        ...makeApp(`plain-app-${index}`, join(dir, `app-${index}`)),
        label: `Plain App ${index}`,
      }));

      await Promise.all(apps.map((app) => addUserAppToEcosystem({
        app,
        userAlias: "tester",
        userRootDir: dir,
        isAdmin: false,
      })));

      const config = await readEcosystemConfig(getEcosystemPath(dir, false));
      const processNames = config.apps.map((app) => app.name).sort();
      expect(processNames).toEqual(apps.map((app) => `tester-app-${app.label.toLowerCase().replaceAll(" ", "-")}`).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
