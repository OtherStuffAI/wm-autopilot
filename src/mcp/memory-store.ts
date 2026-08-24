/**
 * Memory Store
 *
 * SQLite store for agent memories — lets agents persist learnings and notes
 * across sessions, scoped by Wingman npub and user npub.
 * Follows the Nip98GrantStore pattern — shared database file, class-based API.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "../storage/message-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Memory {
  id: string;
  wingmanNpub: string;
  userNpub: string;
  project: string | null;
  workingDir: string | null;
  projectMetadata: Record<string, unknown> | null;
  tags: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveMemoryInput {
  wingmanNpub: string;
  userNpub: string;
  project?: string | null;
  workingDir?: string | null;
  projectMetadata?: Record<string, unknown> | null;
  tags?: string | null;
  content: string;
}

export interface SearchMemoriesInput {
  query?: string;
  tags?: string;
  project?: string;
  userNpub?: string;
  wingmanNpub?: string;
  workingDir?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class MemoryStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  /** Save a new memory. Returns the persisted record. */
  saveMemory(input: SaveMemoryInput): Memory {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .query(
        `INSERT INTO memories (
           id, wingman_npub, user_npub, project, working_dir,
           project_metadata, tags, content, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .run(
        id,
        input.wingmanNpub,
        input.userNpub,
        input.project ?? null,
        input.workingDir ?? null,
        input.projectMetadata ? JSON.stringify(input.projectMetadata) : null,
        input.tags ?? null,
        input.content,
        now,
        now,
      );

    const created = this.getMemory(id);
    if (!created) {
      throw new Error("Failed to save memory");
    }
    return created;
  }

  /** Retrieve a single memory by ID. */
  getMemory(id: string): Memory | null {
    const row = this.db
      .query<MemoryRow, [string]>(
        `SELECT id, wingman_npub, user_npub, project, working_dir,
                project_metadata, tags, content, created_at, updated_at
         FROM memories
         WHERE id = ?1`,
      )
      .get(id);
    return row ? rowToMemory(row) : null;
  }

  /**
   * Flexible search by any combination of: text content, tags, project,
   * user_npub, wingman_npub, working_dir. Default limit 20.
   */
  searchMemories(input: SearchMemoriesInput): Memory[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let idx = 1;

    if (input.query) {
      conditions.push(`content LIKE ?${idx}`);
      params.push(`%${input.query}%`);
      idx++;
    }

    if (input.tags) {
      // Support searching for any of the comma-separated tags
      const tagList = input.tags.split(",").map((t) => t.trim()).filter(Boolean);
      const tagConditions = tagList.map((tag) => {
        const placeholder = `?${idx}`;
        params.push(`%${tag}%`);
        idx++;
        return `tags LIKE ${placeholder}`;
      });
      if (tagConditions.length > 0) {
        conditions.push(`(${tagConditions.join(" OR ")})`);
      }
    }

    if (input.project) {
      conditions.push(`project = ?${idx}`);
      params.push(input.project);
      idx++;
    }

    if (input.userNpub) {
      conditions.push(`user_npub = ?${idx}`);
      params.push(input.userNpub);
      idx++;
    }

    if (input.wingmanNpub) {
      conditions.push(`wingman_npub = ?${idx}`);
      params.push(input.wingmanNpub);
      idx++;
    }

    if (input.workingDir) {
      conditions.push(`working_dir = ?${idx}`);
      params.push(input.workingDir);
      idx++;
    }

    const limit = Math.min(input.limit ?? 20, 100);
    conditions.push(`1=1`); // ensure WHERE clause is never empty

    const sql = `
      SELECT id, wingman_npub, user_npub, project, working_dir,
             project_metadata, tags, content, created_at, updated_at
      FROM memories
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT ?${idx}
    `;
    params.push(limit);

    const rows = this.db.query<MemoryRow, (string | number)[]>(sql).all(...params);
    return rows.map(rowToMemory);
  }

  /** Delete a memory by ID. Returns true if a row was removed. */
  deleteMemory(id: string): boolean {
    const result = this.db
      .query("DELETE FROM memories WHERE id = ?1")
      .run(id);
    return result.changes > 0;
  }

  /** List recent memories for a user, optionally scoped to a wingman. */
  listMemories(
    userNpub: string,
    wingmanNpub?: string,
    limit?: number,
  ): Memory[] {
    const cap = Math.min(limit ?? 20, 100);

    if (wingmanNpub) {
      const rows = this.db
        .query<MemoryRow, [string, string, number]>(
          `SELECT id, wingman_npub, user_npub, project, working_dir,
                  project_metadata, tags, content, created_at, updated_at
           FROM memories
           WHERE user_npub = ?1 AND wingman_npub = ?2
           ORDER BY updated_at DESC
           LIMIT ?3`,
        )
        .all(userNpub, wingmanNpub, cap);
      return rows.map(rowToMemory);
    }

    const rows = this.db
      .query<MemoryRow, [string, number]>(
        `SELECT id, wingman_npub, user_npub, project, working_dir,
                project_metadata, tags, content, created_at, updated_at
         FROM memories
         WHERE user_npub = ?1
         ORDER BY updated_at DESC
         LIMIT ?2`,
      )
      .all(userNpub, cap);
    return rows.map(rowToMemory);
  }

  // ----------------------------------------------------------
  // Schema
  // ----------------------------------------------------------

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id                TEXT PRIMARY KEY,
        wingman_npub      TEXT NOT NULL,
        user_npub         TEXT NOT NULL,
        project           TEXT,
        working_dir       TEXT,
        project_metadata  TEXT,
        tags              TEXT,
        content           TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_wingman_npub
        ON memories(wingman_npub);
      CREATE INDEX IF NOT EXISTS idx_memories_user_npub
        ON memories(user_npub);
      CREATE INDEX IF NOT EXISTS idx_memories_project
        ON memories(project);
      CREATE INDEX IF NOT EXISTS idx_memories_tags
        ON memories(tags);
    `);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface MemoryRow {
  id: string;
  wingman_npub: string;
  user_npub: string;
  project: string | null;
  working_dir: string | null;
  project_metadata: string | null;
  tags: string | null;
  content: string;
  created_at: string;
  updated_at: string;
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    wingmanNpub: row.wingman_npub,
    userNpub: row.user_npub,
    project: row.project,
    workingDir: row.working_dir,
    projectMetadata: row.project_metadata
      ? JSON.parse(row.project_metadata)
      : null,
    tags: row.tags,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { MemoryStore };
