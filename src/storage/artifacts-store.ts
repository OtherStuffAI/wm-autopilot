/**
 * Artifacts Store
 *
 * SQLite table tracking artifacts (images, documents, webviews, files)
 * associated with agent sessions.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "./message-store";

// ============================================================
// Types
// ============================================================

export type ArtifactType = "image" | "document" | "webview" | "file";

export interface Artifact {
  id: string;
  sessionId: string;
  type: ArtifactType;
  label: string;
  filePath: string;
  url: string | null;
  mimeType: string | null;
  createdAt: string;
}

export interface CreateArtifactInput {
  sessionId: string;
  type: ArtifactType;
  label: string;
  filePath: string;
  url?: string | null;
  mimeType?: string | null;
}

// ============================================================
// Store Implementation
// ============================================================

class ArtifactsStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  add(input: CreateArtifactInput): Artifact {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db
      .query(
        `INSERT INTO artifacts (id, session_id, type, label, file_path, url, mime_type, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .run(
        id,
        input.sessionId,
        input.type,
        input.label,
        input.filePath,
        input.url ?? null,
        input.mimeType ?? null,
        now,
      );

    const created = this.get(id);
    if (!created) {
      throw new Error("Failed to create artifact record");
    }
    return created;
  }

  get(id: string): Artifact | null {
    const row = this.db
      .query<Artifact, [string]>(
        `SELECT
           id,
           session_id as sessionId,
           type,
           label,
           file_path as filePath,
           url,
           mime_type as mimeType,
           created_at as createdAt
         FROM artifacts
         WHERE id = ?1`,
      )
      .get(id);
    return row ?? null;
  }

  listBySession(sessionId: string): Artifact[] {
    return this.db
      .query<Artifact, [string]>(
        `SELECT
           id,
           session_id as sessionId,
           type,
           label,
           file_path as filePath,
           url,
           mime_type as mimeType,
           created_at as createdAt
         FROM artifacts
         WHERE session_id = ?1
         ORDER BY created_at ASC`,
      )
      .all(sessionId);
  }

  delete(id: string): boolean {
    const result = this.db.query("DELETE FROM artifacts WHERE id = ?1").run(id);
    return result.changes > 0;
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        file_path TEXT NOT NULL,
        url TEXT,
        mime_type TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id);
    `);
  }
}

export const artifactsStore = new ArtifactsStore();
export { ArtifactsStore };
