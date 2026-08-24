import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import type { AgentRuntimeStatus } from "../types/agent-status";
import type { SessionOrigin } from "../agents/process-manager";
import {
  normaliseSessionMetadata,
  type SessionMetadata,
  type SessionMetadataInput,
} from "../sessions/session-metadata";
import { resolveLastSessionOutputAt } from "../sessions/session-output-timestamp";

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
  messageId?: string | null;
  turnId?: string | null;
  order?: number | null;
  speech?: StoredMessageSpeechAttachment | null;
}

export interface ReplaceMessageInput {
  role: string;
  content: string;
  createdAt: string;
  messageId?: string;
  turnId?: string;
  order?: number;
}

export interface StoredMessageSpeechAttachment {
  publicPath: string;
  relativePath: string;
  mimeType: string;
  voice: string | null;
  model: string | null;
  summary: string | null;
  createdAt: string;
}

export interface MessageSpeechAttachmentInput {
  sessionId: string;
  messageRole: string;
  messageCreatedAt: string;
  publicPath: string;
  relativePath: string;
  mimeType: string;
  voice?: string | null;
  model?: string | null;
  summary?: string | null;
}

export interface SessionRecordInput {
  id: string;
  agent: string;
  startedAt: string;
  name?: string;
  npub?: string;
  port?: number;
  pid?: number;
  pm2Name?: string;
  tmuxSession?: string;
  tmuxWindow?: string;
  logsDir?: string;
  workingDirectory?: string;
  command?: string[];
  runtimeStatus?: AgentRuntimeStatus | null;
  origin?: SessionOrigin | null;
  /** Model used for private chat sessions (agent='chat') */
  model?: string;
  /** Target file for writer-mode sessions */
  targetFile?: string;
  /** Explicit 1-based ordering for live session tabs */
  tabOrder?: number | null;
  /** Session metadata flags */
  metadata?: SessionMetadata | null;
}

export interface StoredSessionRecord {
  id: string;
  agent: string;
  startedAt: string;
  name: string | null;
  npub: string | null;
  port: number | null;
  pid: number | null;
  pm2Name: string | null;
  tmuxSession?: string | null;
  tmuxWindow?: string | null;
  logsDir: string | null;
  workingDirectory: string | null;
  command: string | null;
  runtimeStatus: AgentRuntimeStatus | null;
  origin: SessionOrigin | null;
  /** Model used for private chat sessions (agent='chat') */
  model: string | null;
  /** Target file for writer-mode sessions */
  targetFile: string | null;
  /** Explicit 1-based ordering for live session tabs */
  tabOrder: number | null;
  /** ISO timestamp of the newest persisted assistant or reasoning output. */
  lastUpdatedAt: string | null;
  /** Session metadata flags */
  metadata: SessionMetadata;
}

export const databaseFile = new URL("../../data/wingman.db", import.meta.url).pathname;

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

const parseStoredMetadata = (agentFlag: unknown, billingMode: unknown, metadataJson?: string | null): SessionMetadata => {
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

export class MessageStore {
  private readonly db: Database;

  private readonly insertSession: ReturnType<MessageStore["prepareInsertSession"]>;
  private readonly deleteSession: ReturnType<MessageStore["prepareDeleteSession"]>;
  private readonly listSessionsStmt: ReturnType<MessageStore["prepareListSessions"]>;
  private readonly clearMessages: ReturnType<MessageStore["prepareClearMessages"]>;
  private readonly insertMessage: ReturnType<MessageStore["prepareInsertMessage"]>;
  private readonly listMessages: ReturnType<MessageStore["prepareListMessages"]>;
  private readonly countMessages: ReturnType<MessageStore["prepareCountMessages"]>;
  private readonly updateLastOutputAt: ReturnType<MessageStore["prepareUpdateLastOutputAt"]>;
  private readonly upsertMessageSpeechAttachment: ReturnType<MessageStore["prepareUpsertMessageSpeechAttachment"]>;
  private readonly getMessageSpeechAttachmentStmt: ReturnType<MessageStore["prepareGetMessageSpeechAttachment"]>;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
    this.ensureMetadataColumn();
    this.insertSession = this.prepareInsertSession();
    this.deleteSession = this.prepareDeleteSession();
    this.listSessionsStmt = this.prepareListSessions();
    this.clearMessages = this.prepareClearMessages();
    this.insertMessage = this.prepareInsertMessage();
    this.listMessages = this.prepareListMessages();
    this.countMessages = this.prepareCountMessages();
    this.updateLastOutputAt = this.prepareUpdateLastOutputAt();
    this.upsertMessageSpeechAttachment = this.prepareUpsertMessageSpeechAttachment();
    this.getMessageSpeechAttachmentStmt = this.prepareGetMessageSpeechAttachment();
  }

  recordSession(session: SessionRecordInput) {
    this.insertSession.run(
      session.id,
      session.agent,
      session.startedAt,
      session.name ?? null,
      session.npub ?? null,
      typeof session.port === "number" ? session.port : null,
      typeof session.pid === "number" ? session.pid : null,
      session.pm2Name ?? null,
      session.tmuxSession ?? null,
      session.tmuxWindow ?? null,
      session.logsDir ?? null,
      session.workingDirectory ?? null,
      Array.isArray(session.command) ? JSON.stringify(session.command) : null,
      session.runtimeStatus ?? null,
      session.origin ? JSON.stringify(session.origin) : null,
      session.model ?? null,
      session.targetFile ?? null,
      typeof session.tabOrder === "number" && Number.isFinite(session.tabOrder) ? Math.max(1, Math.floor(session.tabOrder)) : null,
      session.metadata?.AGENT ? 1 : 0,
      session.metadata?.billingMode === "credits" ? "credits" : "subscription",
      session.metadata ? JSON.stringify(session.metadata) : null,
    );
  }

  removeSession(sessionId: string) {
    this.deleteSession.run(sessionId);
  }

  markSessionsRuntimeStatus(sessionIds: string[], runtimeStatus: AgentRuntimeStatus | null) {
    const ids = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) return 0;
    const update = this.db.prepare("UPDATE sessions SET runtime_status = ?1 WHERE id = ?2");
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        update.run(runtimeStatus, id);
      }
    });
    tx();
    return ids.length;
  }

  replaceMessages(sessionId: string, messages: ReplaceMessageInput[]) {
    const lastUpdatedAt = resolveLastSessionOutputAt(messages);
    const tx = this.db.transaction(() => {
      const usesStableIdentity = messages.length > 0 && messages.every((message) => Boolean(message.messageId?.trim()));
      if (!usesStableIdentity) this.clearMessages.run(sessionId);
      for (const message of messages) {
        const role = message.role?.trim() ?? "";
        const content = message.content?.trim() ?? "";
        if (!content) {
          // Skip blank payloads.
          continue;
        }
        const createdAt = message.createdAt ?? new Date().toISOString();
        this.insertMessage.run(
          randomUUID(), sessionId, role || "assistant", content, createdAt,
          message.messageId?.trim() || null, message.turnId?.trim() || null,
          typeof message.order === "number" && Number.isFinite(message.order) ? message.order : null,
        );
      }
      if (usesStableIdentity) {
        const identities = messages.map((message) => message.messageId!.trim());
        const placeholders = identities.map((_, index) => `?${index + 2}`).join(", ");
        this.db.prepare(
          `DELETE FROM messages WHERE session_id = ?1 AND (message_id IS NULL OR message_id NOT IN (${placeholders}))`,
        ).run(sessionId, ...identities);
      }
      this.updateLastOutputAt.run(lastUpdatedAt, sessionId);
    });
    tx();
  }

  listSessionMessages(sessionId: string): StoredMessage[] {
    const rows = this.listMessages.all(sessionId) as Array<StoredMessage & {
      orderValue: number | null;
      speechPublicPath: string | null;
      speechRelativePath: string | null;
      speechMimeType: string | null;
      speechVoice: string | null;
      speechModel: string | null;
      speechSummary: string | null;
      speechCreatedAt: string | null;
    }>;
    return rows.map((row) => {
      const {
        speechPublicPath,
        speechRelativePath,
        speechMimeType,
        speechVoice,
        speechModel,
        speechSummary,
        speechCreatedAt,
        orderValue,
        ...message
      } = row;
      return {
        ...message,
        order: orderValue,
        speech: speechPublicPath && speechRelativePath && speechMimeType && speechCreatedAt
          ? {
              publicPath: speechPublicPath,
              relativePath: speechRelativePath,
              mimeType: speechMimeType,
              voice: speechVoice,
              model: speechModel,
              summary: speechSummary,
              createdAt: speechCreatedAt,
            }
          : null,
      };
    });
  }

  saveMessageSpeechAttachment(input: MessageSpeechAttachmentInput): StoredMessageSpeechAttachment {
    const createdAt = new Date().toISOString();
    this.upsertMessageSpeechAttachment.run(
      input.sessionId,
      input.messageRole,
      input.messageCreatedAt,
      input.publicPath,
      input.relativePath,
      input.mimeType,
      input.voice ?? null,
      input.model ?? null,
      input.summary ?? null,
      createdAt,
    );
    return {
      publicPath: input.publicPath,
      relativePath: input.relativePath,
      mimeType: input.mimeType,
      voice: input.voice ?? null,
      model: input.model ?? null,
      summary: input.summary ?? null,
      createdAt,
    };
  }

  getMessageSpeechAttachment(
    sessionId: string,
    messageRole: string,
    messageCreatedAt: string,
  ): StoredMessageSpeechAttachment | null {
    const row = this.getMessageSpeechAttachmentStmt.get(sessionId, messageRole, messageCreatedAt) as StoredMessageSpeechAttachment | null;
    return row ?? null;
  }

  hasMessages(sessionId: string): boolean {
    const row = this.countMessages.get(sessionId) as { count: number } | undefined;
    return Boolean(row?.count && row.count > 0);
  }

  getSession(sessionId: string): StoredSessionRecord | null {
    const row = this.db.query(`
      SELECT
        id,
        agent,
        started_at as startedAt,
        name,
        npub,
        port,
        pid,
        pm2_name as pm2Name,
        tmux_session as tmuxSession,
        tmux_window as tmuxWindow,
        logs_dir as logsDir,
        working_directory as workingDirectory,
        command,
        runtime_status as runtimeStatus,
        origin,
        model,
        target_file as targetFile,
        tab_order as tabOrder,
        last_output_at as lastUpdatedAt,
        agent_flag as agentFlag,
        billing_mode as billingMode,
        metadata_json as metadataJson
      FROM sessions
      WHERE id = ?1
    `).get(sessionId) as (Omit<StoredSessionRecord, "origin" | "metadata"> & {
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

  listSessions(): StoredSessionRecord[] {
    const rows = this.listSessionsStmt.all() as Array<
      Omit<StoredSessionRecord, "origin" | "metadata"> & {
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

  /**
   * Returns sessions that have port and pid stored, started within the given hours.
   * These are candidates for auto-rehydration after a restart.
   */
  listRehydrationCandidates(maxAgeHours: number = 24): StoredSessionRecord[] {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
    const stmt = this.db.prepare(`
      SELECT
        id,
        agent,
        started_at as startedAt,
        name,
        npub,
        port,
        pid,
        pm2_name as pm2Name,
        tmux_session as tmuxSession,
        tmux_window as tmuxWindow,
        logs_dir as logsDir,
        working_directory as workingDirectory,
        command,
        runtime_status as runtimeStatus,
        origin,
        model,
        target_file as targetFile,
        tab_order as tabOrder,
        last_output_at as lastUpdatedAt,
        agent_flag as agentFlag,
        billing_mode as billingMode,
        metadata_json as metadataJson
      FROM sessions
      WHERE port IS NOT NULL
        AND (pid IS NOT NULL OR (tmux_session IS NOT NULL AND tmux_window IS NOT NULL))
        AND started_at >= ?1
      ORDER BY started_at DESC
    `);
    const rows = stmt.all(cutoff) as Array<
      Omit<StoredSessionRecord, "origin" | "metadata"> & {
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

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        started_at TEXT NOT NULL,
        name TEXT,
        port INTEGER,
        pid INTEGER,
        pm2_name TEXT,
        tmux_session TEXT,
        tmux_window TEXT,
        logs_dir TEXT,
        working_directory TEXT,
        command TEXT,
        runtime_status TEXT,
        origin TEXT,
        agent_flag INTEGER NOT NULL DEFAULT 0,
        billing_mode TEXT NOT NULL DEFAULT 'subscription'
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        message_id TEXT,
        turn_id TEXT,
        message_order INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS message_speech_attachments (
        session_id TEXT NOT NULL,
        message_role TEXT NOT NULL,
        message_created_at TEXT NOT NULL,
        public_path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        voice TEXT,
        model TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, message_role, message_created_at),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_message_speech_session
        ON message_speech_attachments(session_id, message_created_at);
    `);

    const sessionColumns = this.db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
    const ensureColumn = (name: string, definition: string) => {
      const exists = sessionColumns.some((column) => column.name === name);
      if (!exists) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
      }
    };

    ensureColumn("name", "TEXT");
    ensureColumn("port", "INTEGER");
    ensureColumn("pid", "INTEGER");
    ensureColumn("pm2_name", "TEXT");
    ensureColumn("tmux_session", "TEXT");
    ensureColumn("tmux_window", "TEXT");
    ensureColumn("logs_dir", "TEXT");
    ensureColumn("working_directory", "TEXT");
    ensureColumn("command", "TEXT");
    ensureColumn("npub", "TEXT");
    ensureColumn("runtime_status", "TEXT");
    ensureColumn("origin", "TEXT");
    ensureColumn("model", "TEXT");
    ensureColumn("target_file", "TEXT");
    ensureColumn("tab_order", "INTEGER");
    ensureColumn("last_output_at", "TEXT");
    ensureColumn("agent_flag", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("billing_mode", "TEXT NOT NULL DEFAULT 'subscription'");
    ensureColumn("metadata_json", "TEXT");

    const messageColumns = this.db.query("PRAGMA table_info(messages)").all() as { name: string }[];
    const ensureMessageColumn = (name: string, definition: string) => {
      if (!messageColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);
      }
    };
    ensureMessageColumn("message_id", "TEXT");
    ensureMessageColumn("turn_id", "TEXT");
    ensureMessageColumn("message_order", "INTEGER");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_stable_identity ON messages(session_id, message_id) WHERE message_id IS NOT NULL");

    this.db.exec(`
      UPDATE sessions
      SET last_output_at = (
        SELECT messages.created_at
        FROM messages
        WHERE messages.session_id = sessions.id
          AND lower(messages.role) IN ('assistant', 'agent', 'agent-working')
          AND datetime(messages.created_at) IS NOT NULL
        ORDER BY julianday(messages.created_at) DESC, messages.rowid DESC
        LIMIT 1
      )
      WHERE last_output_at IS NULL
    `);
  }

  private ensureMetadataColumn() {
    const sessionColumns = this.db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
    const hasMetadataColumn = sessionColumns.some((column) => column.name === "metadata_json");
    if (!hasMetadataColumn) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN metadata_json TEXT");
    }
  }

  private prepareInsertSession() {
    return this.db.prepare(
      `INSERT INTO sessions (id, agent, started_at, name, npub, port, pid, pm2_name, tmux_session, tmux_window, logs_dir, working_directory, command, runtime_status, origin, model, target_file, tab_order, agent_flag, billing_mode, metadata_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
       ON CONFLICT(id) DO UPDATE SET
         agent = excluded.agent,
         started_at = excluded.started_at,
         name = excluded.name,
         npub = excluded.npub,
         port = excluded.port,
         pid = excluded.pid,
         pm2_name = excluded.pm2_name,
         tmux_session = excluded.tmux_session,
         tmux_window = excluded.tmux_window,
         logs_dir = excluded.logs_dir,
         working_directory = excluded.working_directory,
         command = excluded.command,
         runtime_status = excluded.runtime_status,
         origin = excluded.origin,
         model = excluded.model,
         target_file = excluded.target_file,
         tab_order = COALESCE(excluded.tab_order, sessions.tab_order),
         agent_flag = excluded.agent_flag,
         billing_mode = excluded.billing_mode,
         metadata_json = excluded.metadata_json`,
    );
  }

  private prepareDeleteSession() {
    return this.db.prepare(`DELETE FROM sessions WHERE id = ?1`);
  }

  private prepareListSessions() {
    return this.db.prepare(
      `SELECT
         id,
         agent,
         started_at as startedAt,
         name,
         npub,
         port,
         pid,
         pm2_name as pm2Name,
         tmux_session as tmuxSession,
         tmux_window as tmuxWindow,
         logs_dir as logsDir,
         working_directory as workingDirectory,
         command,
         runtime_status as runtimeStatus,
         origin,
         model,
         target_file as targetFile,
         tab_order as tabOrder,
         last_output_at as lastUpdatedAt,
         agent_flag as agentFlag,
         billing_mode as billingMode,
         metadata_json as metadataJson
       FROM sessions`,
    );
  }

  private prepareClearMessages() {
    return this.db.prepare(`DELETE FROM messages WHERE session_id = ?1`);
  }

  private prepareInsertMessage() {
    return this.db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at, message_id, turn_id, message_order)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(session_id, message_id) WHERE message_id IS NOT NULL DO UPDATE SET
         role = excluded.role,
         content = excluded.content,
         created_at = excluded.created_at,
         turn_id = excluded.turn_id,
         message_order = excluded.message_order`,
    );
  }

  private prepareListMessages() {
    return this.db.prepare(
      `SELECT
         messages.id,
         messages.session_id as sessionId,
         messages.role,
         messages.content,
         messages.created_at as createdAt,
         messages.message_id as messageId,
         messages.turn_id as turnId,
         messages.message_order as orderValue,
         speech.public_path as speechPublicPath,
         speech.relative_path as speechRelativePath,
         speech.mime_type as speechMimeType,
         speech.voice as speechVoice,
         speech.model as speechModel,
         speech.summary as speechSummary,
         speech.created_at as speechCreatedAt
       FROM messages
       LEFT JOIN message_speech_attachments speech
         ON speech.session_id = messages.session_id
        AND speech.message_role = messages.role
        AND speech.message_created_at = messages.created_at
       WHERE messages.session_id = ?1
       ORDER BY COALESCE(messages.message_order, 9223372036854775807), datetime(messages.created_at), messages.rowid`,
    );
  }

  private prepareCountMessages() {
    return this.db.prepare(
      `SELECT COUNT(1) as count
       FROM messages
       WHERE session_id = ?1`,
    );
  }

  private prepareUpdateLastOutputAt() {
    return this.db.prepare(
      `UPDATE sessions
       SET last_output_at = ?1
       WHERE id = ?2`,
    );
  }

  private prepareUpsertMessageSpeechAttachment() {
    return this.db.prepare(
      `INSERT INTO message_speech_attachments (
         session_id,
         message_role,
         message_created_at,
         public_path,
         relative_path,
         mime_type,
         voice,
         model,
         summary,
         created_at
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(session_id, message_role, message_created_at) DO UPDATE SET
         public_path = excluded.public_path,
         relative_path = excluded.relative_path,
         mime_type = excluded.mime_type,
         voice = excluded.voice,
         model = excluded.model,
         summary = excluded.summary,
         created_at = excluded.created_at`,
    );
  }

  private prepareGetMessageSpeechAttachment() {
    return this.db.prepare(
      `SELECT
         public_path as publicPath,
         relative_path as relativePath,
         mime_type as mimeType,
         voice,
         model,
         summary,
         created_at as createdAt
       FROM message_speech_attachments
       WHERE session_id = ?1
         AND message_role = ?2
         AND message_created_at = ?3`,
    );
  }
}

export const messageStore = new MessageStore(databaseFile);
