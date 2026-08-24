#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export type BackupEntry = { path: string; bytes: number; sha256: string; kind: "sqlite" | "metadata" | "upload" };
export type BackupManifest = {
  format: "wingman-autopilot-runtime-backup";
  version: 1;
  created_at: string;
  entries: BackupEntry[];
  excluded: string[];
};
export type BackupPlan = {
  data_dir: string;
  sqlite_files: Array<{ path: string; bytes: number }>;
  safe_metadata_files: string[];
  broker_envelope_files: number;
  uploads: { included: boolean; files: number; bytes: number };
  excluded_sensitive_registry_present: boolean;
};

const SQLITE_EXT = /\.(?:db|sqlite)$/i;
const SECRET_NAME = /(?:^|[._-])(?:nsec|secret|private[-_]?key|credential)(?:[._-]|$)/i;
const SAFE_METADATA = ["capability-broker-state.json", "app-aliases.json", "app-domains.json"];

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link in backup source: ${path}`);
    if (stat.isDirectory()) output.push(...walk(path));
    else if (stat.isFile()) output.push(path);
  }
  return output;
}

export function discoverSqliteFiles(dataDir: string): string[] {
  return walk(dataDir).filter((path) => SQLITE_EXT.test(path)
    && !/backup|\.bak\b|pre-/i.test(basename(path))).sort();
}

export function createBackupPlan(input: { dataDir: string; uploadsDir?: string; includeUploads?: boolean }): BackupPlan {
  const dataDir = resolve(input.dataDir);
  const uploadFiles = input.includeUploads && input.uploadsDir ? walk(resolve(input.uploadsDir)) : [];
  return {
    data_dir: dataDir,
    sqlite_files: discoverSqliteFiles(dataDir).map((path) => ({ path: relative(dataDir, path), bytes: statSync(path).size })),
    safe_metadata_files: SAFE_METADATA.filter((name) => existsSync(join(dataDir, name))),
    broker_envelope_files: walk(join(dataDir, "broker-vault")).length,
    uploads: {
      included: Boolean(input.includeUploads),
      files: uploadFiles.length,
      bytes: uploadFiles.reduce((sum, path) => sum + statSync(path).size, 0),
    },
    excluded_sensitive_registry_present: existsSync(join(dataDir, "apps.json")),
  };
}

async function sqliteOnlineBackup(source: string, destination: string): Promise<void> {
  const process = Bun.spawn(["sqlite3", source, `.backup ${JSON.stringify(destination)}`], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const errorText = await new Response(process.stderr).text();
  const code = await process.exited;
  if (code !== 0) throw new Error(`SQLite online backup failed for ${basename(source)}: ${errorText.trim()}`);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function entry(root: string, path: string, kind: BackupEntry["kind"]): BackupEntry {
  return { path: relative(root, path), bytes: statSync(path).size, sha256: sha256(path), kind };
}

async function copyFileSafe(source: string, destination: string): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  await Bun.write(destination, Bun.file(source));
  chmodSync(destination, 0o600);
}

function snapshotAppRegistryPair(dataDir: string, payload: string): BackupEntry[] {
  const metadata = join(dataDir, "app-registry.sqlite");
  const secrets = join(dataDir, "app-registry-secrets.sqlite");
  if (!existsSync(metadata) && !existsSync(secrets)) return [];
  if (!existsSync(metadata) || !existsSync(secrets)) {
    throw new Error("App registry backup requires both metadata and secret-provider databases");
  }
  const db = new Database(metadata);
  db.query("ATTACH DATABASE ? AS secret_provider").run(secrets);
  db.exec("BEGIN IMMEDIATE");
  try {
    const metadataDestination = join(payload, "data", basename(metadata));
    const secretDestination = join(payload, "data", basename(secrets));
    mkdirSync(dirname(metadataDestination), { recursive: true, mode: 0o700 });
    copyFileSync(metadata, metadataDestination);
    copyFileSync(secrets, secretDestination);
    chmodSync(metadataDestination, 0o600);
    chmodSync(secretDestination, 0o600);
    for (const path of [metadataDestination, secretDestination]) {
      const snapshot = new Database(path, { readonly: true });
      const result = snapshot.query("PRAGMA quick_check").get() as { quick_check: string };
      snapshot.close();
      if (result.quick_check !== "ok") throw new Error(`SQLite quick_check failed for ${basename(path)}`);
    }
    return [entry(payload, metadataDestination, "sqlite"), entry(payload, secretDestination, "sqlite")];
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
}

export async function stageRuntimeBackup(input: {
  dataDir: string;
  stageDir: string;
  uploadsDir?: string;
  includeUploads?: boolean;
}): Promise<BackupManifest> {
  const dataDir = resolve(input.dataDir);
  const payload = join(resolve(input.stageDir), "payload");
  mkdirSync(payload, { recursive: true, mode: 0o700 });
  const entries: BackupEntry[] = [];

  entries.push(...snapshotAppRegistryPair(dataDir, payload));

  for (const source of discoverSqliteFiles(dataDir)) {
    if (["app-registry.sqlite", "app-registry-secrets.sqlite"].includes(basename(source))) continue;
    const rel = relative(dataDir, source);
    const destination = join(payload, "data", rel);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    await sqliteOnlineBackup(source, destination);
    entries.push(entry(payload, destination, "sqlite"));
  }

  for (const name of SAFE_METADATA) {
    const source = join(dataDir, name);
    if (!existsSync(source)) continue;
    if (SECRET_NAME.test(name)) throw new Error(`Refusing secret-like metadata file: ${name}`);
    const destination = join(payload, "data", name);
    await copyFileSafe(source, destination);
    entries.push(entry(payload, destination, "metadata"));
  }

  // Vault envelopes contain ciphertext only. Their wrapping key is deliberately
  // not exported; it must be restored independently through operator custody.
  for (const source of walk(join(dataDir, "broker-vault"))) {
    const rel = relative(dataDir, source);
    const destination = join(payload, "data", rel);
    await copyFileSafe(source, destination);
    entries.push(entry(payload, destination, "metadata"));
  }

  if (input.includeUploads && input.uploadsDir && existsSync(input.uploadsDir)) {
    for (const source of walk(resolve(input.uploadsDir))) {
      const rel = relative(resolve(input.uploadsDir), source);
      const destination = join(payload, "uploads", rel);
      await copyFileSafe(source, destination);
      entries.push(entry(payload, destination, "upload"));
    }
  }

  const manifest: BackupManifest = {
    format: "wingman-autopilot-runtime-backup",
    version: 1,
    created_at: new Date().toISOString(),
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    excluded: [
      "environment files and process environment",
      "apps.json and legacy registry backups (may contain plaintext credentials)",
      "logs, SQLite WAL/SHM files, and pre-existing backups",
      input.includeUploads ? "none: uploads explicitly included" : "upload bodies (use --include-uploads)",
      "broker vault wrapping/master key",
    ],
  };
  writeFileSync(join(payload, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

export function assertDisposableRestoreTarget(target: string): string {
  const resolved = resolve(target);
  const allowedRoot = resolve(tmpdir()) + sep;
  if (!resolved.startsWith(allowedRoot) || !basename(resolved).startsWith("autopilot-restore-")) {
    throw new Error(`Restore target must be a new ${join(tmpdir(), "autopilot-restore-*")} directory`);
  }
  if (existsSync(resolved)) throw new Error("Restore target already exists; refusing to merge or overwrite");
  return resolved;
}

function usage(): never {
  console.error("Usage:\n  bun scripts/runtime-backup.ts plan [--data-dir DIR] [--uploads-dir DIR --include-uploads]\n  bun scripts/runtime-backup.ts create --recipient AGE_RECIPIENT --output FILE.age [--data-dir DIR] [--uploads-dir DIR --include-uploads]\n  bun scripts/runtime-backup.ts verify --identity AGE_IDENTITY_FILE FILE.age\n  bun scripts/runtime-backup.ts restore --identity AGE_IDENTITY_FILE FILE.age --target /tmp/autopilot-restore-NAME");
  process.exit(2);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function run(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  if (!command) usage();
  const repo = resolve(import.meta.dir, "..");
  if (command === "plan") {
    console.log(JSON.stringify(createBackupPlan({
      dataDir: option(args, "--data-dir") ?? join(repo, "data"),
      uploadsDir: option(args, "--uploads-dir") ?? join(repo, "tmp", "uploads"),
      includeUploads: args.includes("--include-uploads"),
    }), null, 2));
    return;
  }
  if (command === "create") {
    const recipient = option(args, "--recipient");
    const output = option(args, "--output");
    if (!recipient || !output || recipient.startsWith("AGE-SECRET-KEY-")) usage();
    if (existsSync(output)) throw new Error("Output already exists; refusing to overwrite");
    const stage = mkdtempSync(join(tmpdir(), "autopilot-backup-stage-"));
    try {
      await stageRuntimeBackup({
        dataDir: option(args, "--data-dir") ?? join(repo, "data"),
        stageDir: stage,
        uploadsDir: option(args, "--uploads-dir") ?? join(repo, "tmp", "uploads"),
        includeUploads: args.includes("--include-uploads"),
      });
      mkdirSync(dirname(resolve(output)), { recursive: true });
      const tar = Bun.spawn(["tar", "-C", stage, "-cf", "-", "payload"], { stdout: "pipe", stderr: "inherit" });
      const age = Bun.spawn(["age", "-r", recipient, "-o", resolve(output)], { stdin: tar.stdout, stdout: "inherit", stderr: "inherit" });
      const [tarCode, ageCode] = await Promise.all([tar.exited, age.exited]);
      if (tarCode !== 0 || ageCode !== 0) {
        rmSync(resolve(output), { force: true });
        throw new Error(`Encrypted backup failed (tar=${tarCode}, age=${ageCode})`);
      }
      console.log(`Encrypted backup created: ${resolve(output)}`);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    return;
  }

  if (command === "verify" || command === "restore") {
    const identity = option(args, "--identity");
    const archive = args.find((value, index) => index > 0 && !value.startsWith("--") && args[index - 1] !== "--identity" && args[index - 1] !== "--target");
    if (!identity || !archive) usage();
    const target = command === "restore"
      ? assertDisposableRestoreTarget(option(args, "--target") ?? "")
      : mkdtempSync(join(tmpdir(), "autopilot-restore-verify-"));
    if (command === "restore") mkdirSync(target, { mode: 0o700 });
    try {
      const age = Bun.spawn(["age", "-d", "-i", identity, archive], { stdout: "pipe", stderr: "inherit" });
      const tar = Bun.spawn(["tar", "-C", target, "-xf", "-"], { stdin: age.stdout, stderr: "inherit" });
      const [ageCode, tarCode] = await Promise.all([age.exited, tar.exited]);
      if (ageCode !== 0 || tarCode !== 0) throw new Error("Archive decryption/extraction failed");
      const payload = join(target, "payload");
      const manifest = JSON.parse(readFileSync(join(payload, "manifest.json"), "utf8")) as BackupManifest;
      if (manifest.format !== "wingman-autopilot-runtime-backup" || manifest.version !== 1) throw new Error("Unsupported manifest");
      for (const expected of manifest.entries) {
        const path = resolve(payload, expected.path);
        if (!path.startsWith(payload + sep) || !existsSync(path) || sha256(path) !== expected.sha256) throw new Error(`Checksum failed: ${expected.path}`);
        if (expected.kind === "sqlite") {
          const db = new Database(path, { readonly: true, create: false });
          try {
            const result = db.query("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
            if (result.length !== 1 || Object.values(result[0] ?? {})[0] !== "ok") throw new Error(`SQLite integrity failed: ${expected.path}`);
          } finally { db.close(); }
        }
      }
      console.log(`${command === "verify" ? "Verified" : "Restored to disposable directory"}: ${command === "verify" ? archive : target}`);
    } finally {
      if (command === "verify") rmSync(target, { recursive: true, force: true });
    }
    return;
  }
  usage();
}

if (import.meta.main) await run();
