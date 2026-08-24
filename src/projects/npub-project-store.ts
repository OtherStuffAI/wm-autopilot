import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, basename, normalize } from "node:path";

import { Database } from "bun:sqlite";

import { normaliseNpub } from "../identity/npub-utils";

export interface NpubProjectRecord {
  id: string;
  npub: string;
  directoryPath: string;
  name: string;
  isCustomName: boolean;
  worktreeName: string | null;
  appId: string | null;
  taskBoardUrl: string | null;
  lastUsedAt: string;
  sessionCount: number;
  createdAt: string;
  updatedAt: string;
}

type NpubProjectRow = {
  id: string;
  npub: string;
  directoryPath: string;
  name: string;
  isCustomName: number;
  worktreeName: string | null;
  appId: string | null;
  taskBoardUrl: string | null;
  lastUsedAt: string;
  sessionCount: number;
  createdAt: string;
  updatedAt: string;
};

export interface TrackProjectInput {
  npub: string;
  directoryPath: string;
  worktreeName?: string | null;
  autoName?: string;
}

const DEFAULT_DB_PATH = new URL("../../data/npub-projects.db", import.meta.url).pathname;

class NpubProjectStore {
  private readonly db: Database;

  constructor(filePath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS npub_projects (
        id TEXT PRIMARY KEY,
        npub TEXT NOT NULL,
        directory_path TEXT NOT NULL,
        name TEXT NOT NULL,
        is_custom_name INTEGER NOT NULL DEFAULT 0,
        worktree_name TEXT,
        last_used_at TEXT NOT NULL,
        session_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(npub, directory_path)
      );

      CREATE INDEX IF NOT EXISTS idx_npub_projects_npub ON npub_projects(npub);
      CREATE INDEX IF NOT EXISTS idx_npub_projects_last_used ON npub_projects(last_used_at DESC);
    `);

    // Migrations: add columns if they don't exist
    const columns = this.db.query("PRAGMA table_info(npub_projects)").all() as { name: string }[];
    const colNames = new Set(columns.map((c) => c.name));

    if (!colNames.has("app_id")) {
      this.db.exec("ALTER TABLE npub_projects ADD COLUMN app_id TEXT");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_npub_projects_app_id ON npub_projects(app_id)");
    }

    if (!colNames.has("task_board_url")) {
      this.db.exec("ALTER TABLE npub_projects ADD COLUMN task_board_url TEXT");
    }
  }

  trackProject(input: TrackProjectInput): NpubProjectRecord {
    const normalized = normaliseNpub(input.npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }

    const directoryPath = normalize(input.directoryPath);
    const existing = this.getByPath(normalized, directoryPath);
    const now = new Date().toISOString();

    if (existing) {
      // Update last used and session count
      const update = this.db.prepare(`
        UPDATE npub_projects
        SET last_used_at = ?2,
            session_count = session_count + 1,
            worktree_name = COALESCE(?3, worktree_name),
            updated_at = ?4
        WHERE id = ?1
      `);
      update.run(existing.id, now, input.worktreeName ?? null, now);
      return this.getById(existing.id)!;
    }

    // Create new project record
    const id = randomUUID();
    const autoName = input.autoName ?? this.generateAutoName(directoryPath, input.worktreeName);

    const insert = this.db.prepare(`
      INSERT INTO npub_projects (
        id, npub, directory_path, name, is_custom_name, worktree_name,
        last_used_at, session_count, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, 1, ?6, ?6)
    `);
    insert.run(id, normalized, directoryPath, autoName, input.worktreeName ?? null, now);
    return this.getById(id)!;
  }

  listByNpub(npub: string): NpubProjectRecord[] {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      return [];
    }

    const statement = this.db.prepare<NpubProjectRow, [string]>(`
      SELECT
        id, npub, directory_path as directoryPath, name,
        is_custom_name as isCustomName, worktree_name as worktreeName,
        app_id as appId, task_board_url as taskBoardUrl,
        last_used_at as lastUsedAt, session_count as sessionCount,
        created_at as createdAt, updated_at as updatedAt
      FROM npub_projects
      WHERE npub = ?1
      ORDER BY last_used_at DESC
    `);
    const rows = statement.all(normalized);
    return rows.map((row) => this.hydrate(row));
  }

  getById(id: string): NpubProjectRecord | null {
    const statement = this.db.prepare<NpubProjectRow, [string]>(`
      SELECT
        id, npub, directory_path as directoryPath, name,
        is_custom_name as isCustomName, worktree_name as worktreeName,
        app_id as appId, task_board_url as taskBoardUrl,
        last_used_at as lastUsedAt, session_count as sessionCount,
        created_at as createdAt, updated_at as updatedAt
      FROM npub_projects
      WHERE id = ?1
    `);
    const row = statement.get(id);
    return row ? this.hydrate(row) : null;
  }

  getByPath(npub: string, directoryPath: string): NpubProjectRecord | null {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      return null;
    }

    const normalizedPath = normalize(directoryPath);
    const statement = this.db.prepare<NpubProjectRow, [string, string]>(`
      SELECT
        id, npub, directory_path as directoryPath, name,
        is_custom_name as isCustomName, worktree_name as worktreeName,
        app_id as appId, task_board_url as taskBoardUrl,
        last_used_at as lastUsedAt, session_count as sessionCount,
        created_at as createdAt, updated_at as updatedAt
      FROM npub_projects
      WHERE npub = ?1 AND directory_path = ?2
    `);
    const row = statement.get(normalized, normalizedPath);
    return row ? this.hydrate(row) : null;
  }

  updateName(id: string, name: string): NpubProjectRecord | null {
    const existing = this.getById(id);
    if (!existing) {
      return null;
    }

    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Project name cannot be empty");
    }

    const now = new Date().toISOString();
    const update = this.db.prepare(`
      UPDATE npub_projects
      SET name = ?2,
          is_custom_name = 1,
          updated_at = ?3
      WHERE id = ?1
    `);
    update.run(id, trimmed, now);
    return this.getById(id);
  }

  resetName(id: string): NpubProjectRecord | null {
    const existing = this.getById(id);
    if (!existing) {
      return null;
    }

    const autoName = this.generateAutoName(existing.directoryPath, existing.worktreeName);
    const now = new Date().toISOString();
    const update = this.db.prepare(`
      UPDATE npub_projects
      SET name = ?2,
          is_custom_name = 0,
          updated_at = ?3
      WHERE id = ?1
    `);
    update.run(id, autoName, now);
    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM npub_projects WHERE id = ?1").run(id);
    return result.changes > 0;
  }

  /**
   * Manually create a project entry (not through auto-tracking).
   * Returns null if project already exists for this npub+path.
   */
  createProject(npub: string, directoryPath: string, customName?: string): NpubProjectRecord | null {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      throw new Error("A valid npub is required");
    }

    const normalizedPath = normalize(directoryPath);
    const existing = this.getByPath(normalized, normalizedPath);
    if (existing) {
      return null; // Already exists
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const name = customName?.trim() || this.generateAutoName(normalizedPath, null);
    const isCustomName = customName?.trim() ? 1 : 0;

    const insert = this.db.prepare(`
      INSERT INTO npub_projects (
        id, npub, directory_path, name, is_custom_name, worktree_name,
        last_used_at, session_count, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 0, ?6, ?6)
    `);
    insert.run(id, normalized, normalizedPath, name, isCustomName, now);
    return this.getById(id)!;
  }

  private generateAutoName(directoryPath: string, worktreeName?: string | null): string {
    const folderName = basename(directoryPath);
    if (worktreeName && worktreeName.trim().length > 0) {
      return `${folderName} - ${worktreeName.trim()}`;
    }
    return folderName;
  }

  /**
   * Link an app to a project.
   */
  setAppId(id: string, appId: string): NpubProjectRecord | null {
    const existing = this.getById(id);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    const update = this.db.prepare(`
      UPDATE npub_projects
      SET app_id = ?2,
          updated_at = ?3
      WHERE id = ?1
    `);
    update.run(id, appId, now);
    return this.getById(id);
  }

  /**
   * Remove app link from a project.
   */
  clearAppId(id: string): NpubProjectRecord | null {
    const existing = this.getById(id);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    const update = this.db.prepare(`
      UPDATE npub_projects
      SET app_id = NULL,
          updated_at = ?2
      WHERE id = ?1
    `);
    update.run(id, now);
    return this.getById(id);
  }

  /**
   * Clear app link from all projects that reference a specific app.
   * Useful when an app is deleted.
   */
  clearAppIdByAppId(appId: string): number {
    const now = new Date().toISOString();
    const update = this.db.prepare(`
      UPDATE npub_projects
      SET app_id = NULL,
          updated_at = ?2
      WHERE app_id = ?1
    `);
    const result = update.run(appId, now);
    return result.changes;
  }

  /**
   * Find project by app ID for a specific user.
   */
  getByAppId(npub: string, appId: string): NpubProjectRecord | null {
    const normalized = normaliseNpub(npub);
    if (!normalized) {
      return null;
    }

    const statement = this.db.prepare<NpubProjectRow, [string, string]>(`
      SELECT
        id, npub, directory_path as directoryPath, name,
        is_custom_name as isCustomName, worktree_name as worktreeName,
        app_id as appId, task_board_url as taskBoardUrl,
        last_used_at as lastUsedAt, session_count as sessionCount,
        created_at as createdAt, updated_at as updatedAt
      FROM npub_projects
      WHERE npub = ?1 AND app_id = ?2
    `);
    const row = statement.get(normalized, appId);
    return row ? this.hydrate(row) : null;
  }

  /**
   * Update the task board URL for a project.
   * Pass null to clear.
   */
  updateTaskBoardUrl(id: string, url: string | null): NpubProjectRecord | null {
    const existing = this.getById(id);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    const update = this.db.prepare(`
      UPDATE npub_projects
      SET task_board_url = ?2,
          updated_at = ?3
      WHERE id = ?1
    `);
    update.run(id, url, now);
    return this.getById(id);
  }

  /**
   * Find any project matching a directory path (regardless of npub).
   * Useful for MCP tools that only know the session working directory.
   */
  findByDirectory(directoryPath: string): NpubProjectRecord | null {
    const normalizedPath = normalize(directoryPath);
    const statement = this.db.prepare<NpubProjectRow, [string]>(`
      SELECT
        id, npub, directory_path as directoryPath, name,
        is_custom_name as isCustomName, worktree_name as worktreeName,
        app_id as appId, task_board_url as taskBoardUrl,
        last_used_at as lastUsedAt, session_count as sessionCount,
        created_at as createdAt, updated_at as updatedAt
      FROM npub_projects
      WHERE directory_path = ?1
      ORDER BY last_used_at DESC
      LIMIT 1
    `);
    const row = statement.get(normalizedPath);
    return row ? this.hydrate(row) : null;
  }

  private hydrate(row: NpubProjectRow): NpubProjectRecord {
    return {
      id: row.id,
      npub: row.npub,
      directoryPath: row.directoryPath,
      name: row.name,
      isCustomName: row.isCustomName === 1,
      worktreeName: row.worktreeName,
      appId: row.appId,
      taskBoardUrl: row.taskBoardUrl,
      lastUsedAt: row.lastUsedAt,
      sessionCount: row.sessionCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

export const npubProjectStore = new NpubProjectStore();
