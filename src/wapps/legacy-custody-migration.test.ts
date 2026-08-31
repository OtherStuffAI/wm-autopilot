import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { AppRegistry, WAPP_TOWER_BROKER_REVIEW_REASON, type AppRecord } from "../apps/app-registry";
import {
  LegacyWappCustodyMigration,
} from "./legacy-custody-migration";
import {
  parseLegacyWappCustodyMigrationInput,
  type LegacyWappCustodyMigrationInput,
} from "./legacy-custody-migration-contract";
import { WappStore } from "./wapp-store";

function identity(): { nsec: string; npub: string } {
  const secret = generateSecretKey();
  return {
    nsec: nip19.nsecEncode(secret),
    npub: nip19.npubEncode(getPublicKey(secret)),
  };
}

function filesBelow(root: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...filesBelow(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "legacy-wapp-custody-"));
  const appRoot = join(directory, "kindling-api");
  mkdirSync(appRoot);
  writeFileSync(join(appRoot, "package.json"), JSON.stringify({ scripts: { start: "bun src/index.ts" } }));
  const appIdentity = identity();
  const owner = identity().npub;
  const creator = identity().npub;
  const collaborator = identity().npub;
  const appId = "64765f89-035a-4832-acba-b633068ba2e0";
  const installationId = "kindling-installation";
  const sourceEnvFile = join(appRoot, ".env.production");
  writeFileSync(sourceEnvFile, [
    "# Kindling production",
    "PORT=4200",
    `export WAPP_NSEC='${appIdentity.nsec}'`,
    "TOWER_URL=https://tower.example",
    "FEATURE_FLAG=true",
    "",
  ].join("\r\n"));
  chmodSync(sourceEnvFile, 0o640);
  const legacyRegistryPath = join(directory, "apps.json");
  const app: AppRecord = {
    id: appId,
    label: "Kindling API",
    root: appRoot,
    scripts: { start: { executable: "bun", args: ["run", "start"] } },
    tmuxSession: "kindling-api",
    ownerNpub: owner,
    autoStart: false,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    webApp: true,
    webAppPort: 4200,
    lifecycleReviewRequired: true,
    lifecycleReviewReasons: [WAPP_TOWER_BROKER_REVIEW_REASON, "retain-this-review"],
  };
  writeFileSync(legacyRegistryPath, JSON.stringify({ apps: [app] }));
  const registry = new AppRegistry(
    legacyRegistryPath,
    join(directory, "app-registry.sqlite"),
    join(directory, "app-registry-secrets.sqlite"),
  );
  await registry.getApp(appId);
  const store = new WappStore(join(directory, "wapps.sqlite"));
  store.createTowerBinding({
    id: "be7f5e54-becc-4283-aba6-d88d56e9f6ec",
    label: "Pete Tower",
    towerUrl: "https://tower.example",
    workspaceId: "workspace-1",
    workspaceOwnerNpub: owner,
  });
  const input: LegacyWappCustodyMigrationInput = {
    appId,
    sourceEnvFile,
    expectedAppNpub: appIdentity.npub,
    towerBindingId: "be7f5e54-becc-4283-aba6-d88d56e9f6ec",
    installation: {
      installationId,
      title: "Kindling API",
      description: "Shared company enrichment service",
      ownerNpub: owner,
      createdByNpub: creator,
      workspaceOwnerNpub: owner,
      scopeId: "bbfd13f9-1cdf-4f56-8213-cf0cffbe4d3c",
      allowedNpubs: [owner, creator, collaborator],
      launchUrl: "https://kindling.example/api",
      sourceWingmanUrl: "https://wingman.example",
      registeredOpenOrigins: ["https://kindling.example"],
    },
  };
  return {
    directory,
    appIdentity,
    appId,
    installationId,
    sourceEnvFile,
    registry,
    store,
    input,
    migration: new LegacyWappCustodyMigration(store, registry),
  };
}

describe("LegacyWappCustodyMigration", () => {
  test("rejects request fields that could carry signing material", async () => {
    const f = await fixture();
    try {
      expect(() => parseLegacyWappCustodyMigrationInput({
        ...f.input,
        WAPP_NSEC: f.appIdentity.nsec,
      })).toThrow("Migration input contains unsupported fields");
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  test("dry-runs without writing custody, registry state, or the source env", async () => {
    const f = await fixture();
    try {
      const before = readFileSync(f.sourceEnvFile, "utf8");
      const result = await f.migration.migrate(f.input);
      expect(result).toMatchObject({
        dryRun: true,
        assignment: "create",
        custodyVerified: false,
        sourceSecretPresent: true,
        sourceSecretRemoved: false,
        reviewReason: "clear",
        autoStart: false,
      });
      expect(f.store.getByAppId(f.appId)).toBeNull();
      expect(readFileSync(f.sourceEnvFile, "utf8")).toBe(before);
      expect((await f.registry.getApp(f.appId))?.lifecycleReviewReasons).toContain(WAPP_TOWER_BROKER_REVIEW_REASON);
      expect(JSON.stringify(result)).not.toContain(f.appIdentity.nsec);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  test("imports exact identity into encrypted custody, atomically cleans only WAPP_NSEC, and is idempotent", async () => {
    const f = await fixture();
    try {
      const result = await f.migration.migrate({ ...f.input, apply: true });
      expect(result).toMatchObject({
        dryRun: false,
        assignment: "create",
        appNpub: f.appIdentity.npub,
        custodyVerified: true,
        sourceSecretPresent: true,
        sourceSecretRemoved: true,
        autoStart: false,
      });
      expect(result.remainingReviewReasons).toContain("retain-this-review");
      expect(readFileSync(f.sourceEnvFile, "utf8")).toBe([
        "# Kindling production",
        "PORT=4200",
        "TOWER_URL=https://tower.example",
        "FEATURE_FLAG=true",
        "",
      ].join("\r\n"));
      expect(statSync(f.sourceEnvFile).mode & 0o777).toBe(0o600);
      const assignment = f.store.get(f.installationId)!;
      expect(assignment.appId).toBe(f.appId);
      expect(assignment.appNpub).toBe(f.appIdentity.npub);
      expect(assignment.allowedNpubs).toEqual([...f.input.installation.allowedNpubs].sort());
      expect(f.store.hasAppSigningKey(f.installationId)).toBeTrue();
      expect(await f.store.withAppSigningKey(f.installationId, (nsec) => nip19.npubEncode(getPublicKey(nip19.decode(nsec).data as Uint8Array))))
        .toBe(f.appIdentity.npub);
      const app = await f.registry.getApp(f.appId);
      expect(app?.lifecycleReviewReasons).toContain("retain-this-review");
      expect(app?.lifecycleReviewReasons).not.toContain(WAPP_TOWER_BROKER_REVIEW_REASON);
      expect(app?.scripts.start).toEqual({ executable: "bun", args: ["run", "start"] });
      expect(app?.autoStart).toBeFalse();
      for (const path of filesBelow(f.directory)) {
        expect(readFileSync(path).includes(Buffer.from(f.appIdentity.nsec))).toBeFalse();
      }

      const repeated = await f.migration.migrate({ ...f.input, apply: true });
      expect(repeated).toMatchObject({
        dryRun: false,
        assignment: "verified",
        custodyVerified: true,
        sourceSecretPresent: false,
        sourceSecretRemoved: false,
        reviewReason: "already-clear",
      });
      expect(f.store.list().filter((record) => record.appId === f.appId)).toHaveLength(1);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  test("refuses identity, assignment, binding, and source-path conflicts before cleanup", async () => {
    const f = await fixture();
    try {
      const otherIdentity = identity();
      await expect(f.migration.migrate({ ...f.input, expectedAppNpub: otherIdentity.npub, apply: true }))
        .rejects.toMatchObject({ code: "legacy_custody_conflict", status: 409 });
      expect(readFileSync(f.sourceEnvFile, "utf8")).toContain(f.appIdentity.nsec);

      await expect(f.migration.migrate({
        ...f.input,
        sourceEnvFile: join(f.directory, "outside.env"),
      })).rejects.toMatchObject({ code: "legacy_custody_invalid", status: 400 });

      f.store.create({
        id: f.installationId,
        appId: f.appId,
        title: "Conflicting title",
        ownerNpub: f.input.installation.ownerNpub,
        createdByNpub: f.input.installation.createdByNpub,
        workspaceOwnerNpub: f.input.installation.workspaceOwnerNpub,
        scopeId: f.input.installation.scopeId,
        allowedNpubs: f.input.installation.allowedNpubs,
        launchUrl: f.input.installation.launchUrl,
        towerBindingId: f.input.towerBindingId,
        appKeyMode: "import",
        appNsec: f.appIdentity.nsec,
      });
      await expect(f.migration.migrate({ ...f.input, apply: true }))
        .rejects.toMatchObject({ code: "legacy_custody_conflict", status: 409 });
      expect(readFileSync(f.sourceEnvFile, "utf8")).toContain(f.appIdentity.nsec);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  test("changes autoStart only through the explicit flag", async () => {
    const f = await fixture();
    try {
      await f.migration.migrate({ ...f.input, apply: true, autoStart: true });
      expect((await f.registry.getApp(f.appId))?.autoStart).toBeTrue();
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
});
