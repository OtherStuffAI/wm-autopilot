import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "./message-store";

const STOP_SESSION_WATCHER_ID = "stop-session-json-trigger";
const START_SESSION_WATCHER_ID = "start-session-json-trigger";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface FileWatcherRecord {
  id: string;
  name: string;
  relativeDir: string;
  pattern: string;
  payloadPointer: string;
  expectedPayload: JsonValue;
  actionKey: string;
  options: JsonValue;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  lastTriggeredAt: string | null;
}

export interface FileWatcherInput {
  id: string;
  name: string;
  relativeDir: string;
  pattern?: string;
  payloadPointer?: string;
  expectedPayload: JsonValue;
  actionKey: string;
  options?: JsonValue;
  enabled?: boolean;
}

interface FileWatcherRow {
  id: string;
  name: string;
  relative_dir: string;
  pattern: string;
  payload_pointer: string;
  expected_payload: string;
  action_key: string;
  options: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  last_triggered_at: string | null;
}

class FileWatcherStore {
  private readonly db: Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  listWatchers(): FileWatcherRecord[] {
    const statement = this.db.prepare(
      `SELECT
         id,
         name,
         relative_dir,
         pattern,
         payload_pointer,
         expected_payload,
         action_key,
         options,
         enabled,
         created_at,
         updated_at,
         last_error,
         last_triggered_at
       FROM file_watchers
       ORDER BY name`,
    );
    const rows = statement.all() as FileWatcherRow[];
    return rows.map((row) => this.mapRow(row)).filter((record): record is FileWatcherRecord => record !== null);
  }

  getWatcher(id: string): FileWatcherRecord | null {
    const statement = this.db.prepare(
      `SELECT
         id,
         name,
         relative_dir,
         pattern,
         payload_pointer,
         expected_payload,
         action_key,
         options,
         enabled,
         created_at,
         updated_at,
         last_error,
         last_triggered_at
       FROM file_watchers
       WHERE id = ?1`,
    );
    const row = statement.get(id);
    if (!row) {
      return null;
    }
    return this.mapRow(row as FileWatcherRow);
  }

  ensureWatcher(input: FileWatcherInput): FileWatcherRecord {
    const id = input.id.trim();
    if (!id) {
      throw new Error("File watcher id cannot be blank");
    }

    const name = input.name.trim();
    if (!name) {
      throw new Error("File watcher name cannot be blank");
    }

    const relativeDir = this.normaliseRelativeDir(input.relativeDir);
    if (!relativeDir) {
      throw new Error("File watcher relative directory cannot be blank");
    }

    const pattern = (input.pattern ?? "*.json").trim() || "*.json";
    const payloadPointer = (input.payloadPointer ?? "/").trim() || "/";
    const expectedPayload = this.stringifyJson(input.expectedPayload);
    const options = this.stringifyJson(input.options ?? {});
    const enabled = input.enabled === false ? 0 : 1;
    const now = new Date().toISOString();
    const actionKey = input.actionKey.trim();
    if (!actionKey) {
      throw new Error("File watcher action key cannot be blank");
    }

    const existing = this.getWatcher(id);
    if (existing) {
      const statement = this.db.prepare(
        `UPDATE file_watchers
           SET name = ?2,
               relative_dir = ?3,
               pattern = ?4,
               payload_pointer = ?5,
               expected_payload = ?6,
               action_key = ?7,
               options = ?8,
               enabled = ?9,
               updated_at = ?10
         WHERE id = ?1`,
      );
      statement.run(id, name, relativeDir, pattern, payloadPointer, expectedPayload, actionKey, options, enabled, now);
      const record = this.getWatcher(id);
      if (!record) {
        throw new Error(`Failed to update file watcher ${id}`);
      }
      return record;
    }

    const statement = this.db.prepare(
      `INSERT INTO file_watchers (
         id,
         name,
         relative_dir,
         pattern,
         payload_pointer,
         expected_payload,
         action_key,
         options,
         enabled,
         created_at,
         updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    );
    statement.run(
      id,
      name,
      relativeDir,
      pattern,
      payloadPointer,
      expectedPayload,
      actionKey,
      options,
      enabled,
      now,
    );
    const record = this.getWatcher(id);
    if (!record) {
      throw new Error(`Failed to create file watcher ${id}`);
    }
    return record;
  }

  ensureStopSessionWatcher() {
    return this.ensureWatcher({
      id: STOP_SESSION_WATCHER_ID,
      name: "Stop Session Trigger",
      relativeDir: "orchestrator/triggers",
      pattern: "*.json",
      payloadPointer: "/",
      expectedPayload: { action: "stop" },
      actionKey: "stop-session",
      options: {
        sessionPointer: "/session",
        cleanupStrategy: "delete",
      },
    });
  }

  ensureStartSessionWatcher() {
    return this.ensureWatcher({
      id: START_SESSION_WATCHER_ID,
      name: "Start Session Trigger",
      relativeDir: "orchestrator/triggers",
      pattern: "*.json",
      payloadPointer: "/",
      expectedPayload: { action: "start" },
      actionKey: "start-session",
      options: {
        agentPointer: "/agent",
        directoryPointer: "/directory",
        namePointer: "/name",
        messagePointer: "/message",
        cleanupStrategy: "delete",
      },
    });
  }

  listEnabledWatchers(): FileWatcherRecord[] {
    return this.listWatchers().filter((watcher) => watcher.enabled);
  }

  markTriggered(id: string, triggeredAt = new Date()): void {
    const statement = this.db.prepare(
      `UPDATE file_watchers
         SET last_triggered_at = ?2,
             last_error = NULL,
             updated_at = ?2
       WHERE id = ?1`,
    );
    statement.run(id, triggeredAt.toISOString());
  }

  recordError(id: string, error: string, erroredAt = new Date()): void {
    const statement = this.db.prepare(
      `UPDATE file_watchers
         SET last_error = ?2,
             updated_at = ?3
       WHERE id = ?1`,
    );
    statement.run(id, error, erroredAt.toISOString());
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_watchers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        relative_dir TEXT NOT NULL,
        pattern TEXT NOT NULL DEFAULT '*.json',
        payload_pointer TEXT NOT NULL DEFAULT '/',
        expected_payload TEXT NOT NULL,
        action_key TEXT NOT NULL,
        options TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        last_triggered_at TEXT,
        CHECK (json_valid(expected_payload)),
        CHECK (json_valid(options))
      );

      CREATE INDEX IF NOT EXISTS idx_file_watchers_enabled ON file_watchers(enabled);
      CREATE INDEX IF NOT EXISTS idx_file_watchers_action ON file_watchers(action_key);
    `);
  }

  private mapRow(row: FileWatcherRow): FileWatcherRecord | null {
    const expectedPayload = this.parseJson(row.expected_payload);
    const options = this.parseJson(row.options);
    if (expectedPayload === null || options === null) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      relativeDir: row.relative_dir,
      pattern: row.pattern,
      payloadPointer: row.payload_pointer,
      expectedPayload,
      actionKey: row.action_key,
      options,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastError: row.last_error ?? null,
      lastTriggeredAt: row.last_triggered_at ?? null,
    };
  }

  private parseJson(value: string): JsonValue | null {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return null;
    }
  }

  private stringifyJson(value: JsonValue): string {
    return JSON.stringify(value ?? {});
  }

  private normaliseRelativeDir(input: string): string {
    const trimmed = input.trim().replace(/\\/g, "/");
    const stripped = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!stripped) {
      return "";
    }
    const segments = stripped.split("/");
    if (segments.some((segment) => segment === ".." || segment === ".")) {
      throw new Error(`Invalid relative directory: ${input}`);
    }
    return segments.join("/");
  }
}

export const fileWatcherStore = new FileWatcherStore(databaseFile);
