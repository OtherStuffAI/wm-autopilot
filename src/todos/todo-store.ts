import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database, type Statement } from "bun:sqlite";

import { normaliseNpub } from "../identity/npub-utils";
import { decryptTodoPayload, encryptTodoPayload, type TodoPayload } from "./encryption";

const DEFAULT_DB_PATH = new URL("../../data/todos.db", import.meta.url).pathname;

export type TodoCategory = "rock" | "pebble" | "sand";

const TODO_CATEGORIES: TodoCategory[] = ["rock", "pebble", "sand"];

export interface TodoRecord {
  id: string;
  ownerNpub: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  appId: string | null;
  projectId: string | null;
  category: TodoCategory;
  parentId: string | null;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTodoInput {
  ownerNpub: string;
  title: string;
  description?: string | null;
  dueDate?: string | null;
  appId?: string | null;
  projectId?: string | null;
  category?: TodoCategory | null;
  parentId?: string | null;
  starred?: boolean | null;
}

export interface UpdateTodoInput {
  title?: string;
  description?: string | null;
  dueDate?: string | null;
  appId?: string | null;
  projectId?: string | null;
  category?: TodoCategory | null;
  parentId?: string | null;
  starred?: boolean | null;
}

interface TodoRow {
  id: string;
  owner_npub: string;
  app_id: string | null;
  project_id: string | null;
  category: string | null;
  parent_id: string | null;
  starred: number;
  payload_iv: string;
  payload_tag: string;
  payload_ciphertext: string;
  created_at: string;
  updated_at: string;
}

const normaliseNullableString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const toBooleanInteger = (value: boolean | null | undefined): number => (value ? 1 : 0);

const normaliseCategory = (value: string | null | undefined): TodoCategory => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (TODO_CATEGORIES.includes(normalized as TodoCategory)) {
    return normalized as TodoCategory;
  }
  return "sand";
};

const mapRowToRecord = (row: TodoRow): TodoRecord => {
  const payload = decryptTodoPayload({
    iv: row.payload_iv,
    authTag: row.payload_tag,
    ciphertext: row.payload_ciphertext,
  });
  return {
    id: row.id,
    ownerNpub: row.owner_npub,
    title: payload.title,
    description: payload.description ?? null,
    dueDate: payload.dueDate ?? null,
    appId: row.app_id,
    projectId: row.project_id ?? null,
    category: normaliseCategory(row.category ?? undefined),
    parentId: row.parent_id ?? null,
    starred: row.starred === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export class TodoStore {
  private readonly db: Database;
  private readonly insertStatement: Statement;
  private readonly updateStatement: Statement;
  private readonly deleteStatement: Statement;
  private readonly selectByIdStatement: Statement;
  private readonly selectByOwnerStatement: Statement;
  private readonly selectStarredStatement: Statement;

  constructor(filePath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
    this.insertStatement = this.prepareInsert();
    this.updateStatement = this.prepareUpdate();
    this.deleteStatement = this.prepareDelete();
    this.selectByIdStatement = this.prepareSelectById();
    this.selectByOwnerStatement = this.prepareSelectByOwner();
    this.selectStarredStatement = this.prepareSelectStarred();
  }

  list(ownerNpub: string): TodoRecord[] {
    const npub = normaliseNpub(ownerNpub);
    if (!npub) {
      return [];
    }
    const rows = this.selectByOwnerStatement.all(npub) as TodoRow[];
    return rows.map(mapRowToRecord);
  }

  listStarred(ownerNpub: string): TodoRecord[] {
    const npub = normaliseNpub(ownerNpub);
    if (!npub) {
      return [];
    }
    const rows = this.selectStarredStatement.all(npub) as TodoRow[];
    return rows.map(mapRowToRecord);
  }

  get(ownerNpub: string, id: string): TodoRecord | null {
    const npub = normaliseNpub(ownerNpub);
    if (!npub || !id) {
      return null;
    }
    const row = this.selectByIdStatement.get(npub, id) as TodoRow | undefined;
    return row ? mapRowToRecord(row) : null;
  }

  create(input: CreateTodoInput): TodoRecord {
    const owner = normaliseNpub(input.ownerNpub);
    if (!owner) {
      throw new Error("Invalid owner npub");
    }
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) {
      throw new Error("Todo title is required");
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const appId = normaliseNullableString(input.appId);
    const projectId = normaliseNullableString(input.projectId);
    const category = normaliseCategory(input.category ?? undefined);
    const parentId = category === "rock" ? null : normaliseNullableString(input.parentId);
    const starred = Boolean(input.starred);
    const payload: TodoPayload = {
      title,
      description: normaliseNullableString(input.description) ?? undefined,
      dueDate: normaliseNullableString(input.dueDate) ?? undefined,
    };
    const encrypted = encryptTodoPayload(payload);
    const params = [
      id,
      owner,
      appId,
      projectId,
      category,
      parentId,
      toBooleanInteger(starred),
      encrypted.iv,
      encrypted.authTag,
      encrypted.ciphertext,
      now,
      now,
    ];
    this.insertStatement.run(...params);
    return {
      id,
      ownerNpub: owner,
      title: payload.title,
      description: payload.description ?? null,
      dueDate: payload.dueDate ?? null,
      appId,
      projectId,
      category,
      parentId,
      starred,
      createdAt: now,
      updatedAt: now,
    };
  }

  update(ownerNpub: string, id: string, input: UpdateTodoInput): TodoRecord | null {
    const current = this.get(ownerNpub, id);
    if (!current) {
      return null;
    }
    const npub = normaliseNpub(ownerNpub);
    if (!npub) {
      return null;
    }
    const title =
      typeof input.title === "string"
        ? input.title.trim()
        : current.title;
    if (!title) {
      throw new Error("Todo title is required");
    }
    const description =
      input.description !== undefined
        ? normaliseNullableString(input.description)
        : current.description;
    const dueDate =
      input.dueDate !== undefined
        ? normaliseNullableString(input.dueDate)
        : current.dueDate;
    const appId =
      input.appId !== undefined
        ? normaliseNullableString(input.appId)
        : current.appId;
    const projectId =
      input.projectId !== undefined
        ? normaliseNullableString(input.projectId)
        : current.projectId;
    const category =
      input.category !== undefined && input.category !== null
        ? normaliseCategory(input.category)
        : current.category;
    let parentId =
      input.parentId !== undefined
        ? (category === "rock" ? null : normaliseNullableString(input.parentId))
        : current.parentId;
    if (category === "rock") {
      parentId = null;
    }
    const starred =
      input.starred !== undefined
        ? Boolean(input.starred)
        : current.starred;
    const payload: TodoPayload = {
      title,
      description: description ?? undefined,
      dueDate: dueDate ?? undefined,
    };
    const encrypted = encryptTodoPayload(payload);
    const updatedAt = new Date().toISOString();
    const params = [
      appId,
      projectId,
      category,
      parentId,
      toBooleanInteger(starred),
      encrypted.iv,
      encrypted.authTag,
      encrypted.ciphertext,
      updatedAt,
      npub,
      id,
    ];
    this.updateStatement.run(...params);
    return {
      id: current.id,
      ownerNpub: npub,
      title,
      description: description ?? null,
      dueDate: dueDate ?? null,
      appId,
      projectId,
      category,
      parentId,
      starred,
      createdAt: current.createdAt,
      updatedAt,
    };
  }

  delete(ownerNpub: string, id: string): boolean {
    const npub = normaliseNpub(ownerNpub);
    if (!npub || !id) {
      return false;
    }
    const result = this.deleteStatement.run(npub, id);
    if (result.changes > 0) {
      this.db
        .prepare(
          `
            UPDATE todos
               SET parent_id = NULL
             WHERE owner_npub = ?1
               AND parent_id = ?2
          `,
        )
        .run(npub, id);
      return true;
    }
    return false;
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        owner_npub TEXT NOT NULL,
        app_id TEXT,
        project_id TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        category TEXT NOT NULL DEFAULT 'sand',
        parent_id TEXT,
        starred INTEGER NOT NULL DEFAULT 0,
        payload_iv TEXT NOT NULL,
        payload_tag TEXT NOT NULL,
        payload_ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // Run migrations before creating indexes so any referenced columns exist
    this.applyMigrations();
    this.ensureIndexes();
  }

  private ensureIndexes() {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_todos_owner ON todos(owner_npub, updated_at DESC);
      DROP INDEX IF EXISTS idx_todos_owner_starred;
      CREATE INDEX IF NOT EXISTS idx_todos_owner_category ON todos(owner_npub, category, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_todos_owner_parent ON todos(owner_npub, parent_id, updated_at DESC);
    `);
  }

  private applyMigrations() {
    const columns = this.db.query("PRAGMA table_info(todos)").all() as Array<{ name: string }>;
    const hasCategory = columns.some((column) => column.name === "category");
    if (!hasCategory) {
      this.db.exec("ALTER TABLE todos ADD COLUMN category TEXT NOT NULL DEFAULT 'sand';");
    }
    const hasParent = columns.some((column) => column.name === "parent_id");
    if (!hasParent) {
      this.db.exec("ALTER TABLE todos ADD COLUMN parent_id TEXT;");
    }
    const hasProject = columns.some((column) => column.name === "project_id");
    if (!hasProject) {
      this.db.exec("ALTER TABLE todos ADD COLUMN project_id TEXT;");
    }
    this.db.exec(`
      UPDATE todos
         SET category = CASE
           WHEN category IS NULL OR category NOT IN ('rock','pebble','sand') THEN
             CASE WHEN starred = 1 THEN 'rock' ELSE 'sand' END
           ELSE category
         END;

      UPDATE todos
         SET parent_id = NULL
       WHERE parent_id IS NOT NULL
         AND parent_id NOT IN (SELECT id FROM todos);
    `);
    const hasPriority = columns.some((column) => column.name === "priority");
    if (hasPriority) {
      this.db.exec(`
        UPDATE todos
           SET priority = 0
         WHERE priority IS NOT NULL
           AND priority <> 0;
      `);
    }
  }

  private prepareInsert() {
    return this.db.prepare(
      `
        INSERT INTO todos (
          id,
          owner_npub,
          app_id,
          project_id,
          category,
          parent_id,
          starred,
          payload_iv,
          payload_tag,
          payload_ciphertext,
          created_at,
          updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      `,
    );
  }

  private prepareUpdate() {
    return this.db.prepare(
      `
        UPDATE todos
           SET app_id = ?1,
               project_id = ?2,
               category = ?3,
               parent_id = ?4,
               starred = ?5,
               payload_iv = ?6,
               payload_tag = ?7,
               payload_ciphertext = ?8,
               updated_at = ?9
         WHERE owner_npub = ?10
           AND id = ?11
      `,
    );
  }

  private prepareDelete() {
    return this.db.prepare(
      `
        DELETE FROM todos
         WHERE owner_npub = ?1
           AND id = ?2
      `,
    );
  }

  private prepareSelectById() {
    return this.db.prepare(
      `
        SELECT
          id,
          owner_npub,
          app_id,
          project_id,
          category,
          parent_id,
          starred,
          payload_iv,
          payload_tag,
          payload_ciphertext,
          created_at,
          updated_at
        FROM todos
        WHERE owner_npub = ?1
          AND id = ?2
      `,
    );
  }

  private prepareSelectByOwner() {
    return this.db.prepare(
      `
        SELECT
          id,
          owner_npub,
          app_id,
          project_id,
          category,
          parent_id,
          starred,
          payload_iv,
          payload_tag,
          payload_ciphertext,
          created_at,
          updated_at
        FROM todos
        WHERE owner_npub = ?1
        ORDER BY updated_at DESC
      `,
    );
  }

  private prepareSelectStarred() {
    return this.db.prepare(
      `
        SELECT
          id,
          owner_npub,
          app_id,
          project_id,
          category,
          parent_id,
          starred,
          payload_iv,
          payload_tag,
          payload_ciphertext,
          created_at,
          updated_at
        FROM todos
        WHERE owner_npub = ?1
          AND starred = 1
        ORDER BY updated_at DESC
      `,
    );
  }
}
