import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { decryptSettingValue, encryptSettingValue } from "../storage/setting-value-crypto";
import type { AppRecord } from "./app-registry";

export const APP_REGISTRY_MIGRATION = "apps-json-to-sqlite-v1";

type MetadataRow = {
  id: string;
  label: string;
  root: string;
  scripts_json: string;
  tmux_session: string;
  pm2_name: string | null;
  logs_dir: string | null;
  notes: string | null;
  owner_npub: string | null;
  auto_start: number;
  env_binding_id: string | null;
  created_at: string;
  updated_at: string;
  web_app: number;
  web_app_port: number | null;
  lifecycle_review_required: number;
  lifecycle_review_reasons_json: string;
  legacy_scripts_json: string | null;
};

export class AppRegistryStore {
  private readonly metadata: Database;

  constructor(
    readonly databasePath: string,
    readonly secretDatabasePath: string,
    private readonly beforeVerification?: () => void,
  ) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(secretDatabasePath), { recursive: true, mode: 0o700 });
    this.metadata = new Database(databasePath, { create: true });
    // SQLite only guarantees atomic transactions across attached databases
    // when the main database is not WAL and the files share a filesystem.
    this.metadata.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.metadata.query("ATTACH DATABASE ? AS secret_provider").run(secretDatabasePath);
    if (statSync(databasePath).dev !== statSync(secretDatabasePath).dev) {
      throw new Error("App registry metadata and secret provider must share one filesystem for atomic commits");
    }
    this.metadata.exec("PRAGMA secret_provider.journal_mode=DELETE; PRAGMA secret_provider.synchronous=FULL;");
    this.metadata.exec(`
      CREATE TABLE IF NOT EXISTS app_registry (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        root TEXT NOT NULL UNIQUE,
        scripts_json TEXT NOT NULL,
        tmux_session TEXT NOT NULL,
        pm2_name TEXT,
        logs_dir TEXT,
        notes TEXT,
        owner_npub TEXT,
        auto_start INTEGER NOT NULL CHECK(auto_start IN (0,1)),
        env_binding_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        web_app INTEGER NOT NULL CHECK(web_app IN (0,1)),
        web_app_port INTEGER,
        lifecycle_review_required INTEGER NOT NULL CHECK(lifecycle_review_required IN (0,1)),
        lifecycle_review_reasons_json TEXT NOT NULL,
        legacy_scripts_json TEXT
      );
      CREATE TABLE IF NOT EXISTS app_registry_migrations (
        name TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL,
        record_count INTEGER NOT NULL,
        source_fingerprint TEXT NOT NULL,
        legacy_retired_at TEXT
      );
    `);
    this.restrictPermissions();
    // This is deliberately a separate provider/database boundary. The registry
    // contains only its opaque binding id, never plaintext or ciphertext.
    this.metadata.exec(`
      CREATE TABLE IF NOT EXISTS secret_provider.app_environment_bindings (
        binding_id TEXT NOT NULL,
        env_key TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        PRIMARY KEY(binding_id, env_key)
      );
    `);
  }

  migration(): { recordCount: number; sourceFingerprint: string; legacyRetiredAt: string | null } | null {
    return this.metadata.query(`SELECT record_count AS recordCount, source_fingerprint AS sourceFingerprint,
      legacy_retired_at AS legacyRetiredAt FROM app_registry_migrations WHERE name = ?`)
      .get(APP_REGISTRY_MIGRATION) as { recordCount: number; sourceFingerprint: string; legacyRetiredAt: string | null } | null;
  }

  markLegacyRetired(): void {
    this.metadata.query(`UPDATE app_registry_migrations SET legacy_retired_at = ? WHERE name = ?`)
      .run(new Date().toISOString(), APP_REGISTRY_MIGRATION);
  }

  load(): AppRecord[] {
    const rows = this.metadata.query("SELECT * FROM app_registry ORDER BY id").all() as MetadataRow[];
    return rows.map((row) => {
      const env = row.env_binding_id ? this.loadEnvironment(row.env_binding_id) : undefined;
      return {
        id: row.id,
        label: row.label,
        root: row.root,
        scripts: JSON.parse(row.scripts_json),
        tmuxSession: row.tmux_session,
        pm2Name: row.pm2_name ?? undefined,
        logsDir: row.logs_dir ?? undefined,
        notes: row.notes ?? undefined,
        ownerNpub: row.owner_npub,
        autoStart: Boolean(row.auto_start),
        env,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        webApp: Boolean(row.web_app),
        webAppPort: row.web_app_port,
        lifecycleReviewRequired: Boolean(row.lifecycle_review_required),
        lifecycleReviewReasons: JSON.parse(row.lifecycle_review_reasons_json),
        legacyScripts: row.legacy_scripts_json ? JSON.parse(row.legacy_scripts_json) : undefined,
      };
    });
  }

  replaceAll(records: AppRecord[], migration?: { sourceFingerprint: string }): void {
    const metadataTransaction = this.metadata.transaction(() => {
      this.metadata.exec("DELETE FROM secret_provider.app_environment_bindings");
      const insertSecret = this.metadata.query("INSERT INTO secret_provider.app_environment_bindings(binding_id, env_key, encrypted_value) VALUES (?, ?, ?)");
      for (const app of records) {
        for (const [key, value] of Object.entries(app.env ?? {})) {
          insertSecret.run(`app-env:${app.id}`, key, encryptSettingValue(value));
        }
      }
      this.metadata.exec("DELETE FROM app_registry");
      const insert = this.metadata.query(`INSERT INTO app_registry (
        id,label,root,scripts_json,tmux_session,pm2_name,logs_dir,notes,owner_npub,auto_start,
        env_binding_id,created_at,updated_at,web_app,web_app_port,lifecycle_review_required,
        lifecycle_review_reasons_json,legacy_scripts_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const app of records) {
        const bindingId = Object.keys(app.env ?? {}).length > 0 ? `app-env:${app.id}` : null;
        insert.run(app.id, app.label, app.root, JSON.stringify(app.scripts), app.tmuxSession,
          app.pm2Name ?? null, app.logsDir ?? null, app.notes ?? null, app.ownerNpub,
          app.autoStart ? 1 : 0, bindingId, app.createdAt, app.updatedAt, app.webApp ? 1 : 0,
          app.webAppPort, app.lifecycleReviewRequired ? 1 : 0,
          JSON.stringify(app.lifecycleReviewReasons ?? []), app.legacyScripts ? JSON.stringify(app.legacyScripts) : null);
      }
      this.beforeVerification?.();
      const stored = this.metadata.query(`SELECT id, label, root, owner_npub, web_app_port
        FROM app_registry ORDER BY id`).all() as Array<{
          id: string; label: string; root: string; owner_npub: string | null; web_app_port: number | null;
        }>;
      const expected = [...records].sort((left, right) => left.id.localeCompare(right.id));
      if (stored.length !== expected.length || stored.some((row, index) => {
        const app = expected[index];
        return !app || row.id !== app.id || row.label !== app.label || row.root !== app.root
          || row.owner_npub !== app.ownerNpub || row.web_app_port !== app.webAppPort;
      })) {
        throw new Error("App registry transactional verification failed");
      }
      if (migration) {
        this.metadata.query(`INSERT INTO app_registry_migrations
          (name, completed_at, record_count, source_fingerprint, legacy_retired_at)
          VALUES (?, ?, ?, ?, NULL)
          ON CONFLICT(name) DO NOTHING`).run(
          APP_REGISTRY_MIGRATION, new Date().toISOString(), records.length, migration.sourceFingerprint,
        );
      }
    });
    // ATTACH keeps metadata and its separate secret-provider file in one
    // SQLite transaction: neither side can commit alone.
    metadataTransaction();
    this.restrictPermissions();
  }

  private loadEnvironment(bindingId: string): Record<string, string> | undefined {
    const rows = this.metadata.query("SELECT env_key, encrypted_value FROM secret_provider.app_environment_bindings WHERE binding_id = ? ORDER BY env_key")
      .all(bindingId) as Array<{ env_key: string; encrypted_value: string }>;
    if (rows.length === 0) return undefined;
    return Object.fromEntries(rows.map((row) => [row.env_key, decryptSettingValue(row.encrypted_value)]));
  }

  private restrictPermissions(): void {
    for (const path of [
      this.databasePath,
      this.secretDatabasePath,
      `${this.databasePath}-journal`,
      `${this.secretDatabasePath}-journal`,
    ]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }
}
