import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database, type SQLQueryBindings } from "bun:sqlite";

import type { SessionOrigin } from "../agents/process-manager";
import {
  normaliseSessionMetadata,
  type SessionMetadata,
  type SessionMetadataInput,
} from "../sessions/session-metadata";
import { resolveLastSessionOutputAt } from "../sessions/session-output-timestamp";

export interface ArchivedSession {
  id: string;
  agent: string;
  name: string | null;
  npub: string | null;
  workingDirectory: string | null;
  startedAt: string;
  archivedAt: string;
  messageCount: number;
  /** ISO timestamp of the newest archived assistant or reasoning output. */
  lastUpdatedAt: string | null;
  origin: SessionOrigin | null;
  metadata: SessionMetadata;
}

export interface ArchivedMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface ArchiveSessionInput {
  id: string;
  agent: string;
  name: string | null;
  npub: string | null;
  workingDirectory: string | null;
  startedAt: string;
  origin: SessionOrigin | null;
  metadata: SessionMetadata;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    createdAt: string;
  }>;
}

export interface ArchiveListOptions {
  limit?: number;
  offset?: number;
  filter?: string;
  since?: string;
  category?: ArchiveSessionCategory;
}

export type ArchiveSessionCategory = "my" | "auto";

const DEFAULT_DB_PATH = new URL("../../data/session-archive.db", import.meta.url).pathname;

const parseStoredOrigin = (value: string | null): SessionOrigin | null => {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const type = typeof parsed.type === "string" ? parsed.type.trim() : "";
    const id =
      typeof parsed.id === "string"
        ? parsed.id.trim()
        : typeof parsed.id === "number"
          ? String(parsed.id)
          : "";
    if (!type || !id) {
      return null;
    }
    const origin: SessionOrigin = { type, id };
    const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
    const label = typeof parsed.label === "string" ? parsed.label.trim() : "";
    if (url) {
      origin.url = url;
    }
    if (label) {
      origin.label = label;
    }
    return origin;
  } catch {
    return null;
  }
};

const parseStoredMetadata = (
  agentFlag: unknown,
  billingMode: unknown,
  metadataJson?: string | null,
): SessionMetadata => {
  let parsedMetadata: SessionMetadataInput = null;
  if (metadataJson) {
    try {
      parsedMetadata = JSON.parse(metadataJson) as SessionMetadataInput;
    } catch {
      parsedMetadata = null;
    }
  }
  return normaliseSessionMetadata({
    ...(parsedMetadata ?? {}),
    AGENT: agentFlag === 1 || agentFlag === true || agentFlag === "1" || agentFlag === "true",
    billingMode: billingMode === "credits" ? "credits" : "subscription",
  });
};

const wildcardToSqlLike = (pattern: string): string => {
  // Convert wildcard pattern to SQL LIKE pattern
  // * -> % (match any characters)
  // ? -> _ (match single character)
  return pattern
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "%")
    .replace(/\?/g, "_");
};

const AUTO_ORIGIN_TYPES = [
  "scheduler",
  "nostr",
  "mg-task",
  "file-watcher",
  "agent-session",
  "cli",
  "delegate-bot",
  "agent-work",
  "agent-chat",
];

const buildAutoSessionCondition = (alias = "s"): string => {
  const prefix = alias ? `${alias}.` : "";
  const originTypes = AUTO_ORIGIN_TYPES.map((type) => `'${type}'`).join(", ");
  return `(
    COALESCE(${prefix}agent_flag, 0) = 1
    OR lower(COALESCE(json_extract(${prefix}origin, '$.type'), '')) IN (${originTypes})
    OR lower(COALESCE(json_extract(${prefix}metadata_json, '$.role'), '')) IN ('agent-work', 'agent-chat')
    OR lower(COALESCE(json_extract(${prefix}metadata_json, '$.bindingType'), '')) IN ('task', 'flow_run')
    OR lower(COALESCE(json_extract(${prefix}metadata_json, '$.routedBy'), '')) = 'agent-chat'
    OR (
      trim(COALESCE(json_extract(${prefix}metadata_json, '$.createdByNpub'), '')) != ''
      AND trim(COALESCE(json_extract(${prefix}metadata_json, '$.createdByNpub'), '')) != trim(COALESCE(json_extract(${prefix}metadata_json, '$.ownerNpub'), ${prefix}npub, ''))
    )
  )`;
};

const appendArchiveCategoryWhere = (
  whereParts: string[],
  category: ArchiveListOptions["category"],
  alias = "s",
): void => {
  if (category !== "my" && category !== "auto") {
    return;
  }
  const autoCondition = buildAutoSessionCondition(alias);
  whereParts.push(category === "auto" ? autoCondition : `NOT ${autoCondition}`);
};

export class SessionArchiveStore {
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
      CREATE TABLE IF NOT EXISTS archived_sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        name TEXT,
        npub TEXT,
        working_directory TEXT,
        started_at TEXT NOT NULL,
        archived_at TEXT NOT NULL,
        last_output_at TEXT,
        origin TEXT,
        agent_flag INTEGER NOT NULL DEFAULT 0,
        billing_mode TEXT NOT NULL DEFAULT 'subscription',
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS archived_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES archived_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_archived_sessions_date ON archived_sessions(archived_at DESC);
      CREATE INDEX IF NOT EXISTS idx_archived_messages_session ON archived_messages(session_id, created_at);
    `);
    const sessionColumns = this.db.query("PRAGMA table_info(archived_sessions)").all() as { name: string }[];
    const hasAgentFlag = sessionColumns.some((column) => column.name === "agent_flag");
    if (!hasAgentFlag) {
      this.db.exec("ALTER TABLE archived_sessions ADD COLUMN agent_flag INTEGER NOT NULL DEFAULT 0");
    }
    const hasBillingMode = sessionColumns.some((column) => column.name === "billing_mode");
    if (!hasBillingMode) {
      this.db.exec("ALTER TABLE archived_sessions ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'subscription'");
    }
    const hasMetadataJson = sessionColumns.some((column) => column.name === "metadata_json");
    if (!hasMetadataJson) {
      this.db.exec("ALTER TABLE archived_sessions ADD COLUMN metadata_json TEXT");
    }
    const hasLastOutputAt = sessionColumns.some((column) => column.name === "last_output_at");
    if (!hasLastOutputAt) {
      this.db.exec("ALTER TABLE archived_sessions ADD COLUMN last_output_at TEXT");
    }
    this.db.exec(`
      UPDATE archived_sessions
      SET last_output_at = (
        SELECT archived_messages.created_at
        FROM archived_messages
        WHERE archived_messages.session_id = archived_sessions.id
          AND lower(archived_messages.role) IN ('assistant', 'agent', 'agent-working')
          AND datetime(archived_messages.created_at) IS NOT NULL
        ORDER BY julianday(archived_messages.created_at) DESC, archived_messages.rowid DESC
        LIMIT 1
      )
      WHERE last_output_at IS NULL
    `);
  }

  archiveSession(input: ArchiveSessionInput): void {
    const archivedAt = new Date().toISOString();
    const lastUpdatedAt = resolveLastSessionOutputAt(input.messages);

    const tx = this.db.transaction(() => {
      // Insert archived session
      this.db.run(
        `INSERT OR REPLACE INTO archived_sessions
         (id, agent, name, npub, working_directory, started_at, archived_at, last_output_at, origin, agent_flag, billing_mode, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
        [
          input.id,
          input.agent,
          input.name,
          input.npub,
          input.workingDirectory,
          input.startedAt,
          archivedAt,
          lastUpdatedAt,
          input.origin ? JSON.stringify(input.origin) : null,
          input.metadata.AGENT ? 1 : 0,
          input.metadata.billingMode === "credits" ? "credits" : "subscription",
          JSON.stringify(input.metadata),
        ]
      );

      // Clear any existing messages for this session (in case of re-archive)
      this.db.run(`DELETE FROM archived_messages WHERE session_id = ?1`, [input.id]);

      // Insert archived messages
      const insertMsg = this.db.prepare(
        `INSERT INTO archived_messages (id, session_id, role, content, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      );
      for (const msg of input.messages) {
        insertMsg.run(msg.id, input.id, msg.role, msg.content, msg.createdAt);
      }
    });

    tx();
    console.log(`[archive] Archived session ${input.id} with ${input.messages.length} messages`);
  }

  listArchivedSessions(options: ArchiveListOptions = {}): ArchivedSession[] {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 200);
    const offset = Math.max(0, options.offset ?? 0);
    const filter = options.filter?.trim() ?? "";
    const since = typeof options.since === "string" && !Number.isNaN(Date.parse(options.since))
      ? options.since
      : "";
    const category = options.category === "my" || options.category === "auto" ? options.category : undefined;

    const baseQuery = `
      SELECT
        s.id,
        s.agent,
        s.name,
        s.npub,
        s.working_directory as workingDirectory,
        s.started_at as startedAt,
        s.archived_at as archivedAt,
        s.last_output_at as lastUpdatedAt,
        s.origin,
        s.agent_flag as agentFlag,
        s.billing_mode as billingMode,
        s.metadata_json as metadataJson,
        (SELECT COUNT(1) FROM archived_messages m WHERE m.session_id = s.id) as messageCount
      FROM archived_sessions s
    `;

    const whereParts: string[] = [];
    const params: SQLQueryBindings[] = [];

    if (filter) {
      const likePattern = wildcardToSqlLike(filter);
      const safeLikePattern = `%${likePattern}%`;
      params.push(safeLikePattern);
      const index = params.length;
      whereParts.push(
        `(s.name LIKE ?${index} ESCAPE '\\' OR s.working_directory LIKE ?${index} ESCAPE '\\' OR s.agent LIKE ?${index} ESCAPE '\\' OR s.metadata_json LIKE ?${index} ESCAPE '\\')`,
      );
    }

    if (since) {
      params.push(since);
      const index = params.length;
      whereParts.push(`(s.archived_at >= ?${index} OR s.started_at >= ?${index})`);
    }
    appendArchiveCategoryWhere(whereParts, category, "s");

    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
    params.push(limit, offset);
    const limitIndex = params.length - 1;
    const offsetIndex = params.length;

    const query = this.db.prepare(`
      ${baseQuery}
      ${whereClause}
      ORDER BY s.archived_at DESC
      LIMIT ?${limitIndex} OFFSET ?${offsetIndex}
    `);
    
    const rows = query.all(...params) as Array<
      Omit<ArchivedSession, "origin" | "metadata"> & {
        origin: string | null;
        agentFlag: number | null;
        billingMode: string | null;
        metadataJson: string | null;
      }
    >;

    return rows.map((row) => ({
      ...row,
      origin: parseStoredOrigin(row.origin),
      metadata: parseStoredMetadata(row.agentFlag, row.billingMode, row.metadataJson),
    }));
  }

  getArchivedSession(sessionId: string): ArchivedSession | null {
    const row = this.db.query(`
      SELECT
        s.id,
        s.agent,
        s.name,
        s.npub,
        s.working_directory as workingDirectory,
        s.started_at as startedAt,
        s.archived_at as archivedAt,
        s.last_output_at as lastUpdatedAt,
        s.origin,
        s.agent_flag as agentFlag,
        s.billing_mode as billingMode,
        s.metadata_json as metadataJson,
        (SELECT COUNT(1) FROM archived_messages m WHERE m.session_id = s.id) as messageCount
      FROM archived_sessions s
      WHERE s.id = ?1
    `).get(sessionId) as (Omit<ArchivedSession, "origin" | "metadata"> & {
      origin: string | null;
      agentFlag: number | null;
      billingMode: string | null;
      metadataJson: string | null;
    }) | null;

    if (!row) return null;

    return {
      ...row,
      origin: parseStoredOrigin(row.origin),
      metadata: parseStoredMetadata(row.agentFlag, row.billingMode, row.metadataJson),
    };
  }

  getArchivedMessages(sessionId: string): ArchivedMessage[] {
    return this.db.query(`
      SELECT id, session_id as sessionId, role, content, created_at as createdAt
      FROM archived_messages
      WHERE session_id = ?1
      ORDER BY datetime(created_at), rowid
    `).all(sessionId) as ArchivedMessage[];
  }

  updateArchivedSessionMetadata(
    sessionId: string,
    metadataPatch: SessionMetadataInput,
  ): ArchivedSession | null {
    const existing = this.getArchivedSession(sessionId);
    if (!existing) return null;

    const metadata = normaliseSessionMetadata({
      ...existing.metadata,
      ...(metadataPatch ?? {}),
    });
    this.db.run(
      `UPDATE archived_sessions
       SET agent_flag = ?2, billing_mode = ?3, metadata_json = ?4
       WHERE id = ?1`,
      [
        sessionId,
        metadata.AGENT ? 1 : 0,
        metadata.billingMode === "credits" ? "credits" : "subscription",
        JSON.stringify(metadata),
      ],
    );
    return this.getArchivedSession(sessionId);
  }

  deleteArchivedSession(sessionId: string): boolean {
    const result = this.db.run(
      `DELETE FROM archived_sessions WHERE id = ?1`,
      [sessionId]
    );
    return result.changes > 0;
  }

  getArchiveCount(options: Pick<ArchiveListOptions, "filter" | "since" | "category"> = {}): number {
    const filter = options.filter?.trim() ?? "";
    const since = typeof options.since === "string" && !Number.isNaN(Date.parse(options.since))
      ? options.since
      : "";
    const category = options.category === "my" || options.category === "auto" ? options.category : undefined;
    const whereParts: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (filter) {
      const likePattern = wildcardToSqlLike(filter);
      const safeLikePattern = `%${likePattern}%`;
      params.push(safeLikePattern);
      const index = params.length;
      whereParts.push(
        `(s.name LIKE ?${index} ESCAPE '\\' OR s.working_directory LIKE ?${index} ESCAPE '\\' OR s.agent LIKE ?${index} ESCAPE '\\' OR s.metadata_json LIKE ?${index} ESCAPE '\\')`,
      );
    }
    if (since) {
      params.push(since);
      const index = params.length;
      whereParts.push(`(s.archived_at >= ?${index} OR s.started_at >= ?${index})`);
    }
    appendArchiveCategoryWhere(whereParts, category, "s");
    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
    const row = this.db.query(`SELECT COUNT(1) as count FROM archived_sessions s ${whereClause}`).get(...params) as { count: number };
    return row?.count ?? 0;
  }
}

export const sessionArchiveStore = new SessionArchiveStore();
