import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertDisposableRestoreTarget, createBackupPlan, discoverSqliteFiles, stageRuntimeBackup } from "./runtime-backup";

test("stages SQLite through backup API and excludes plaintext registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "autopilot-backup-test-"));
  const data = join(root, "data");
  await Bun.write(join(data, ".keep"), "");
  const db = new Database(join(data, "runtime.sqlite"));
  db.run("CREATE TABLE records (value TEXT)");
  db.run("INSERT INTO records VALUES ('private-body-not-inspected-by-tooling')");
  db.close();
  writeFileSync(join(data, "apps.json"), JSON.stringify({ WAPP_NSEC: "must-not-copy" }));
  writeFileSync(join(data, "capability-broker-state.json"), "{}\n");
  const stage = join(root, "stage");
  const manifest = await stageRuntimeBackup({ dataDir: data, stageDir: stage });
  expect(manifest.entries.map((item) => item.path)).toEqual([
    "data/capability-broker-state.json",
    "data/runtime.sqlite",
  ]);
  expect(readFileSync(join(stage, "payload", "manifest.json"), "utf8")).not.toContain("must-not-copy");
  const restored = new Database(join(stage, "payload", "data", "runtime.sqlite"), { readonly: true });
  expect(restored.query("SELECT count(*) AS count FROM records").get()).toEqual({ count: 1 });
  restored.close();
});

test("discovery excludes old backups and journals", async () => {
  const root = mkdtempSync(join(tmpdir(), "autopilot-backup-discovery-"));
  for (const name of ["live.db", "live.sqlite", "live.db-wal", "old.backup.db", "old.bak"]) await Bun.write(join(root, name), "");
  expect(discoverSqliteFiles(root).map((path) => path.split("/").pop())).toEqual(["live.db", "live.sqlite"]);
});

test("coherently stages app metadata and encrypted environment bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "autopilot-registry-backup-"));
  const data = join(root, "data");
  await Bun.write(join(data, ".keep"), "");
  const metadata = new Database(join(data, "app-registry.sqlite"));
  const secrets = new Database(join(data, "app-registry-secrets.sqlite"));
  metadata.run("CREATE TABLE app_registry (id TEXT PRIMARY KEY, env_binding_id TEXT)");
  secrets.run("CREATE TABLE app_environment_bindings (binding_id TEXT, encrypted_value TEXT)");
  metadata.run("INSERT INTO app_registry VALUES ('app-1', 'binding-1')");
  secrets.run("INSERT INTO app_environment_bindings VALUES ('binding-1', 'enc::ciphertext')");
  metadata.close();
  secrets.close();
  const stage = join(root, "stage");
  const manifest = await stageRuntimeBackup({ dataDir: data, stageDir: stage });
  expect(manifest.entries.map((item) => item.path)).toEqual([
    "data/app-registry-secrets.sqlite",
    "data/app-registry.sqlite",
  ]);
  for (const name of ["app-registry.sqlite", "app-registry-secrets.sqlite"]) {
    const path = join(stage, "payload", "data", name);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const restored = new Database(path, { readonly: true });
    expect(restored.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    restored.close();
  }
});

test("restore guard only permits a new named temp directory", () => {
  expect(() => assertDisposableRestoreTarget("/srv/autopilot/data")).toThrow();
  const allowed = join(tmpdir(), `autopilot-restore-${crypto.randomUUID()}`);
  expect(assertDisposableRestoreTarget(allowed)).toBe(allowed);
});

test("dry-run plan inventories files without opening database content", async () => {
  const root = mkdtempSync(join(tmpdir(), "autopilot-backup-plan-"));
  await Bun.write(join(root, "runtime.sqlite"), "not opened by plan");
  await Bun.write(join(root, "apps.json"), "sensitive legacy registry");
  const plan = createBackupPlan({ dataDir: root });
  expect(plan.sqlite_files).toEqual([{ path: "runtime.sqlite", bytes: 18 }]);
  expect(plan.excluded_sensitive_registry_present).toBe(true);
  expect(plan.uploads.included).toBe(false);
});
