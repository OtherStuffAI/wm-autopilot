import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "../storage/message-store";

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAppRecord {
  id: string;
  projectId: string;
  name: string;
  folderPath: string;
  appId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWithApps extends ProjectRecord {
  apps: ProjectAppRecord[];
}

export interface CreateProjectInput {
  name: string;
  rootPath: string;
}

export interface CreateProjectAppInput {
  projectId: string;
  name: string;
  folderPath: string;
  appId?: string | null;
}

const DEFAULT_DB_PATH = databaseFile;

class ProjectStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  listProjects(): ProjectWithApps[] {
    const projects = this.db
      .query<{
        id: string;
        name: string;
        rootPath: string;
        createdAt: string;
        updatedAt: string;
      }, []>(
        `SELECT
           id,
           name,
           root_path as rootPath,
           created_at as createdAt,
           updated_at as updatedAt
         FROM projects
         ORDER BY created_at DESC`,
      )
      .all() as ProjectRecord[];

    const apps = this.db
      .query<{
        id: string;
        projectId: string;
        name: string;
        folderPath: string;
        createdAt: string;
        updatedAt: string;
      }, []>(
        `SELECT
           id,
           project_id as projectId,
           name,
           folder_path as folderPath,
           app_id as appId,
           created_at as createdAt,
           updated_at as updatedAt
         FROM project_apps
         ORDER BY name ASC`,
      )
      .all() as ProjectAppRecord[];

    const appsByProject = new Map<string, ProjectAppRecord[]>();
    for (const app of apps) {
      const list = appsByProject.get(app.projectId);
      if (list) {
        list.push(app);
      } else {
        appsByProject.set(app.projectId, [app]);
      }
    }

    return projects.map((project) => ({
      ...project,
      apps: appsByProject.get(project.id) ?? [],
    }));
  }

  getProject(id: string): ProjectRecord | null {
    const statement = this.db.prepare(
      `SELECT
         id,
         name,
         root_path as rootPath,
         created_at as createdAt,
         updated_at as updatedAt
       FROM projects
       WHERE id = ?1`,
    );
    const result = statement.get(id) as ProjectRecord | undefined;
    return result ?? null;
  }

  getProjectWithApps(id: string): ProjectWithApps | null {
    const project = this.getProject(id);
    if (!project) {
      return null;
    }
    return {
      ...project,
      apps: this.listAppsForProject(id),
    };
  }

  createProject(input: CreateProjectInput): ProjectWithApps {
    const now = new Date().toISOString();
    const id = randomUUID();
    const statement = this.db.prepare(
      `INSERT INTO projects (id, name, root_path, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    );
    statement.run(id, input.name, input.rootPath, now, now);
    const created = this.getProjectWithApps(id);
    if (!created) {
      throw new Error("Failed to create project");
    }
    return created;
  }

  addProjectApp(input: CreateProjectAppInput): ProjectAppRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const statement = this.db.prepare(
      `INSERT INTO project_apps (id, project_id, name, folder_path, app_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    );
    statement.run(id, input.projectId, input.name, input.folderPath, input.appId ?? null, now, now);
    const created = this.getProjectApp(id);
    if (!created) {
      throw new Error("Failed to create project app");
    }
    return created;
  }

  listAppsForProject(projectId: string): ProjectAppRecord[] {
    const statement = this.db.prepare(
      `SELECT
        id,
        project_id as projectId,
        name,
        folder_path as folderPath,
        app_id as appId,
        created_at as createdAt,
        updated_at as updatedAt
       FROM project_apps
       WHERE project_id = ?1
       ORDER BY name ASC`,
    );
    return statement.all(projectId) as ProjectAppRecord[];
  }

  private getProjectApp(id: string): ProjectAppRecord | null {
    const statement = this.db.prepare(
      `SELECT
         id,
         project_id as projectId,
         name,
         folder_path as folderPath,
         created_at as createdAt,
         updated_at as updatedAt
       FROM project_apps
       WHERE id = ?1`,
    );
    const result = statement.get(id) as ProjectAppRecord | undefined;
    return result ?? null;
  }

  private initialise() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_apps (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        app_id TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_project_apps_project ON project_apps(project_id);
    `);

    const projectAppsColumns = this.db
      .query("PRAGMA table_info(project_apps)")
      .all() as { name: string }[];
    const hasAppIdColumn = projectAppsColumns.some((column) => column.name === "app_id");
    if (!hasAppIdColumn) {
      this.db.exec("ALTER TABLE project_apps ADD COLUMN app_id TEXT");
    }
  }
}

export { ProjectStore };
