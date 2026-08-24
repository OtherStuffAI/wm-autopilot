import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "./message-store";

export interface StarterProjectRecord {
  id: string;
  name: string;
  gitUrl: string;
  webApp: boolean;
  scriptAuto: boolean;
  notes: string | null;
  setupCommand: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface CreateStarterProjectInput {
  id?: string;
  name: string;
  gitUrl: string;
  webApp?: boolean;
  scriptAuto?: boolean;
  notes?: string | null;
  setupCommand?: string | null;
  updatedBy?: string | null;
}

export interface UpdateStarterProjectInput {
  name?: string;
  gitUrl?: string;
  webApp?: boolean;
  scriptAuto?: boolean;
  notes?: string | null;
  setupCommand?: string | null;
  updatedBy?: string | null;
}

const DEFAULT_SETUP_COMMAND = "bun install";

const LEGACY_DEFAULT_STARTERS = [
  "Speedrun Lite Starter Project",
  "Speedrun Lite Agent",
];

const normaliseOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normaliseGitUrl = (value: string): string => {
  const normalized = value.trim();
  if (!/^https?:\/\/.+/i.test(normalized) && !/^git@.+:.+/.test(normalized)) {
    throw new Error("Starter Git URL must be a valid HTTPS or SSH Git URL");
  }
  return normalized;
};

export class StarterProjectStore {
  private readonly db: Database;

  constructor(filePath: string = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
    this.removeLegacyDefaults(LEGACY_DEFAULT_STARTERS);
  }

  list(): StarterProjectRecord[] {
    const statement = this.db.prepare(
      `SELECT
         id,
         name,
         git_url as gitUrl,
         web_app as webApp,
         script_auto as scriptAuto,
         notes,
         setup_command as setupCommand,
         created_at as createdAt,
         updated_at as updatedAt,
         updated_by as updatedBy
       FROM starter_projects
       ORDER BY name`,
    );
    return statement.all() as StarterProjectRecord[];
  }

  getById(id: string): StarterProjectRecord | null {
    const trimmedId = normaliseOptionalString(id);
    if (!trimmedId) return null;
    const statement = this.db.prepare(
      `SELECT
         id,
         name,
         git_url as gitUrl,
         web_app as webApp,
         script_auto as scriptAuto,
         notes,
         setup_command as setupCommand,
         created_at as createdAt,
         updated_at as updatedAt,
         updated_by as updatedBy
       FROM starter_projects
       WHERE id = ?1`,
    );
    const row = statement.get(trimmedId);
    return (row as StarterProjectRecord | undefined) ?? null;
  }

  create(input: CreateStarterProjectInput): StarterProjectRecord {
    const name = normaliseOptionalString(input.name);
    if (!name) throw new Error("Starter project name is required");
    const gitUrlInput = normaliseOptionalString(input.gitUrl);
    if (!gitUrlInput) throw new Error("Starter project Git URL is required");
    const gitUrl = normaliseGitUrl(gitUrlInput);

    const id = normaliseOptionalString(input.id) ?? randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO starter_projects (
           id,
           name,
           git_url,
           web_app,
           script_auto,
           notes,
           setup_command,
           created_at,
           updated_at,
           updated_by
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)`,
      )
      .run(
        id,
        name,
        gitUrl,
        input.webApp ? 1 : 0,
        input.scriptAuto ? 1 : 0,
        normaliseOptionalString(input.notes) ?? null,
        normaliseOptionalString(input.setupCommand) ?? null,
        now,
        normaliseOptionalString(input.updatedBy) ?? null,
      );

    const created = this.getById(id);
    if (!created) throw new Error("Failed to create starter project");
    return created;
  }

  update(id: string, updates: UpdateStarterProjectInput): StarterProjectRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error("Starter project not found");

    const fields: string[] = [];
    const values: Array<string | number | null> = [];

    if (Object.prototype.hasOwnProperty.call(updates, "name")) {
      const name = normaliseOptionalString(updates.name);
      if (!name) throw new Error("Starter project name is required");
      fields.push(`name = ?${fields.length + 1}`);
      values.push(name);
    }

    if (Object.prototype.hasOwnProperty.call(updates, "gitUrl")) {
      const gitUrlInput = normaliseOptionalString(updates.gitUrl);
      if (!gitUrlInput) throw new Error("Starter project Git URL is required");
      fields.push(`git_url = ?${fields.length + 1}`);
      values.push(normaliseGitUrl(gitUrlInput));
    }

    if (Object.prototype.hasOwnProperty.call(updates, "webApp")) {
      fields.push(`web_app = ?${fields.length + 1}`);
      values.push(updates.webApp ? 1 : 0);
    }

    if (Object.prototype.hasOwnProperty.call(updates, "scriptAuto")) {
      fields.push(`script_auto = ?${fields.length + 1}`);
      values.push(updates.scriptAuto ? 1 : 0);
    }

    if (Object.prototype.hasOwnProperty.call(updates, "notes")) {
      fields.push(`notes = ?${fields.length + 1}`);
      values.push(normaliseOptionalString(updates.notes) ?? null);
    }

    if (Object.prototype.hasOwnProperty.call(updates, "setupCommand")) {
      fields.push(`setup_command = ?${fields.length + 1}`);
      values.push(normaliseOptionalString(updates.setupCommand) ?? null);
    }

    if (fields.length === 0) {
      return existing;
    }

    fields.push(`updated_at = ?${fields.length + 1}`);
    values.push(new Date().toISOString());
    fields.push(`updated_by = ?${fields.length + 1}`);
    values.push(normaliseOptionalString(updates.updatedBy) ?? null);

    this.db
      .prepare(
        `UPDATE starter_projects
         SET ${fields.join(", ")}
         WHERE id = ?${fields.length + 1}`,
      )
      .run(...values, existing.id);

    const updated = this.getById(existing.id);
    if (!updated) throw new Error("Failed to update starter project");
    return updated;
  }

  remove(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;
    this.db.prepare("DELETE FROM starter_projects WHERE id = ?1").run(existing.id);
    return true;
  }

  ensureDefaults(defaults: CreateStarterProjectInput[]) {
    defaults.forEach((entry) => {
      const name = normaliseOptionalString(entry.name);
      const gitUrl = normaliseOptionalString(entry.gitUrl);
      if (!name || !gitUrl) return;
      const id = normaliseOptionalString(entry.id);
      const existing = (id
        ? this.db.prepare("SELECT id FROM starter_projects WHERE id = ?1 OR name = ?2").get(id, name)
        : this.db.prepare("SELECT id FROM starter_projects WHERE name = ?1").get(name)) as { id: string } | null;
      if (existing?.id) {
        this.update(existing.id, entry);
        return;
      }
      this.create(entry);
    });
  }

  removeLegacyDefaults(names: string[]) {
    names.forEach((name) => {
      const normalized = normaliseOptionalString(name);
      if (!normalized) return;
      this.db.prepare("DELETE FROM starter_projects WHERE name = ?1").run(normalized);
    });
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS starter_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        git_url TEXT NOT NULL,
        web_app INTEGER NOT NULL DEFAULT 0,
        script_auto INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        setup_command TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );
    `);
  }
}

export const starterProjectStore = new StarterProjectStore();
export { DEFAULT_SETUP_COMMAND };
