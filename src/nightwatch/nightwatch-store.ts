/**
 * Night Watch Store
 *
 * SQLite store for Night Watchman session state, report cards, and global config.
 * Follows the CaproverStore pattern — shares the main wingman.db database.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "../storage/message-store";
import {
  getNextNightWatchPromptAt,
  normalizeNightWatchIntervalMinutes,
  normalizeNightWatchPrompt,
} from "./nightwatch-constants";

// ============================================================
// Types
// ============================================================

export interface NightWatchSessionState {
  sessionId: string;
  enabled: boolean;
  cycleCount: number;
  maxCycles: number;
  model: string;
  prompt: string;
  intervalMinutes: number;
  promptAt: string | null;
  updatedAt: string;
}

export interface NightWatchReport {
  id: string;
  sessionId: string;
  sessionName: string | null;
  workingDirectory: string | null;
  status: "raw" | "monitor" | "humanInput" | "continue" | "complete" | "error";
  summary: string;
  reasoning: string | null;
  inputMode: string | null;
  inputRaw: string | null;
  cycleCount: number;
  createdAt: string;
}

// ============================================================
// Store Implementation
// ============================================================

const DEFAULT_DB_PATH = databaseFile;

class NightWatchStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  // ----------------------------------------------------------
  // Session Methods
  // ----------------------------------------------------------

  getSessionState(sessionId: string): NightWatchSessionState | null {
    const row = this.db
      .query<NightWatchSessionState, [string]>(
        `SELECT
           session_id AS sessionId,
           enabled,
           cycle_count AS cycleCount,
           max_cycles AS maxCycles,
           model,
           prompt_text AS prompt,
           interval_minutes AS intervalMinutes,
           prompt_at AS promptAt,
           updated_at AS updatedAt
         FROM nightwatch_sessions
         WHERE session_id = ?1`,
      )
      .get(sessionId);
    if (!row) return null;
    return {
      ...row,
      enabled: Boolean(row.enabled),
      prompt: normalizeNightWatchPrompt(row.prompt),
      intervalMinutes: normalizeNightWatchIntervalMinutes(row.intervalMinutes),
    };
  }

  isEnabled(sessionId: string): boolean {
    const row = this.db
      .query<{ enabled: number }, [string]>(
        `SELECT enabled FROM nightwatch_sessions WHERE session_id = ?1`,
      )
      .get(sessionId);
    return Boolean(row?.enabled);
  }

  enableSession(
    sessionId: string,
    opts?: { model?: string; maxCycles?: number; prompt?: string; intervalMinutes?: number },
  ): NightWatchSessionState {
    const now = new Date().toISOString();
    const defaultModel = this.getConfig("default_model") ?? "google/gemini-3-flash-preview";
    const defaultMaxCycles = Number(this.getConfig("default_max_cycles") ?? "21");
    const model = opts?.model ?? defaultModel;
    const maxCycles = opts?.maxCycles ?? defaultMaxCycles;
    const prompt = normalizeNightWatchPrompt(opts?.prompt);
    const intervalMinutes = normalizeNightWatchIntervalMinutes(opts?.intervalMinutes);
    const promptAt = getNextNightWatchPromptAt(intervalMinutes);

    this.db
      .query(
        `INSERT INTO nightwatch_sessions (session_id, enabled, cycle_count, max_cycles, model, prompt_text, interval_minutes, prompt_at, updated_at)
         VALUES (?1, 1, 0, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(session_id) DO UPDATE SET
           enabled = 1,
           cycle_count = 0,
           max_cycles = excluded.max_cycles,
           model = excluded.model,
           prompt_text = excluded.prompt_text,
           interval_minutes = excluded.interval_minutes,
           prompt_at = excluded.prompt_at,
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, maxCycles, model, prompt, intervalMinutes, promptAt, now);

    return this.getSessionState(sessionId)!;
  }

  disableSession(sessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE nightwatch_sessions
         SET enabled = 0, prompt_at = NULL, updated_at = ?2
         WHERE session_id = ?1`,
      )
      .run(sessionId, now);
  }

  scheduleNextPrompt(sessionId: string, baseMs = Date.now()): void {
    const now = new Date().toISOString();
    const sessionState = this.getSessionState(sessionId);
    if (!sessionState?.enabled) return;
    const promptAt = getNextNightWatchPromptAt(sessionState.intervalMinutes, baseMs);
    this.db
      .query(
        `UPDATE nightwatch_sessions
         SET prompt_at = ?2, updated_at = ?3
         WHERE session_id = ?1 AND enabled = 1`,
      )
      .run(sessionId, promptAt, now);
  }

  postponePrompt(sessionId: string, promptAt: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE nightwatch_sessions
         SET prompt_at = ?2, updated_at = ?3
         WHERE session_id = ?1 AND enabled = 1`,
      )
      .run(sessionId, promptAt, now);
  }

  recordPromptSent(sessionId: string, continueTimer = true, baseMs = Date.now()): number {
    const sessionState = this.getSessionState(sessionId);
    const intervalMinutes = sessionState?.intervalMinutes;
    const now = new Date().toISOString();
    const promptAt =
      continueTimer && intervalMinutes != null
        ? getNextNightWatchPromptAt(intervalMinutes, baseMs)
        : null;
    this.db
      .query(
        `UPDATE nightwatch_sessions
         SET enabled = ?2,
             cycle_count = cycle_count + 1,
             prompt_at = ?3,
             updated_at = ?4
         WHERE session_id = ?1`,
      )
      .run(sessionId, continueTimer ? 1 : 0, promptAt, now);
    const row = this.db
      .query<{ cycleCount: number }, [string]>(
        `SELECT cycle_count AS cycleCount FROM nightwatch_sessions WHERE session_id = ?1`,
      )
      .get(sessionId);
    return row?.cycleCount ?? 0;
  }

  // ----------------------------------------------------------
  // Report Methods
  // ----------------------------------------------------------

  addReport(input: {
    sessionId: string;
    sessionName?: string | null;
    workingDirectory?: string | null;
    status: NightWatchReport["status"];
    summary: string;
    reasoning?: string | null;
    inputMode?: string | null;
    inputRaw?: string | null;
    cycleCount: number;
  }): NightWatchReport {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO nightwatch_reports (id, session_id, session_name, working_directory, status, summary, reasoning, input_mode, input_raw, cycle_count, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .run(
        id,
        input.sessionId,
        input.sessionName ?? null,
        input.workingDirectory ?? null,
        input.status,
        input.summary,
        input.reasoning ?? null,
        input.inputMode ?? null,
        input.inputRaw ?? null,
        input.cycleCount,
        now,
      );

    return {
      id,
      sessionId: input.sessionId,
      sessionName: input.sessionName ?? null,
      workingDirectory: input.workingDirectory ?? null,
      status: input.status,
      summary: input.summary,
      reasoning: input.reasoning ?? null,
      inputMode: input.inputMode ?? null,
      inputRaw: input.inputRaw ?? null,
      cycleCount: input.cycleCount,
      createdAt: now,
    };
  }

  listReports(limit = 50): NightWatchReport[] {
    return this.db
      .query<NightWatchReport, [number]>(
        `SELECT
           id,
           session_id AS sessionId,
           session_name AS sessionName,
           working_directory AS workingDirectory,
           status,
           summary,
           reasoning,
           input_mode AS inputMode,
           input_raw AS inputRaw,
           cycle_count AS cycleCount,
           created_at AS createdAt
         FROM nightwatch_reports
         ORDER BY created_at DESC
         LIMIT ?1`,
      )
      .all(limit);
  }

  deleteReport(id: string): boolean {
    const result = this.db
      .query("DELETE FROM nightwatch_reports WHERE id = ?1")
      .run(id);
    return result.changes > 0;
  }

  // ----------------------------------------------------------
  // Config Methods
  // ----------------------------------------------------------

  getConfig(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>(
        `SELECT value FROM nightwatch_config WHERE key = ?1`,
      )
      .get(key);
    return row?.value ?? null;
  }

  setConfig(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO nightwatch_config (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getAllConfig(): Record<string, string> {
    const rows = this.db
      .query<{ key: string; value: string }, []>(
        `SELECT key, value FROM nightwatch_config`,
      )
      .all();
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  // ----------------------------------------------------------
  // Initialization
  // ----------------------------------------------------------

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nightwatch_sessions (
        session_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        cycle_count INTEGER NOT NULL DEFAULT 0,
        max_cycles INTEGER NOT NULL DEFAULT 21,
        model TEXT NOT NULL DEFAULT 'google/gemini-3-flash-preview',
        prompt_text TEXT NOT NULL DEFAULT 'Any progress?',
        interval_minutes INTEGER NOT NULL DEFAULT 5,
        prompt_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nightwatch_reports (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        session_name TEXT,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        cycle_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_nightwatch_reports_session
        ON nightwatch_reports(session_id);
      CREATE INDEX IF NOT EXISTS idx_nightwatch_reports_created
        ON nightwatch_reports(created_at DESC);

      CREATE TABLE IF NOT EXISTS nightwatch_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Migration: add working_directory column if missing
    try {
      this.db.exec(`ALTER TABLE nightwatch_reports ADD COLUMN working_directory TEXT`);
    } catch {
      // Column already exists — ignore
    }

    // Migration: add reasoning column if missing
    try {
      this.db.exec(`ALTER TABLE nightwatch_reports ADD COLUMN reasoning TEXT`);
    } catch {
      // Column already exists — ignore
    }

    // Migration: add input_mode column if missing
    try {
      this.db.exec(`ALTER TABLE nightwatch_reports ADD COLUMN input_mode TEXT`);
    } catch {
      // Column already exists — ignore
    }

    // Migration: add input_raw column if missing
    try {
      this.db.exec(`ALTER TABLE nightwatch_reports ADD COLUMN input_raw TEXT`);
    } catch {
      // Column already exists — ignore
    }

    // Migration: add prompt_at column if missing
    try {
      this.db.exec(`ALTER TABLE nightwatch_sessions ADD COLUMN prompt_at TEXT`);
    } catch {
      // Column already exists — ignore
    }

    try {
      this.db.exec(`ALTER TABLE nightwatch_sessions ADD COLUMN prompt_text TEXT NOT NULL DEFAULT 'Any progress?'`);
    } catch {
      // Column already exists — ignore
    }

    try {
      this.db.exec(`ALTER TABLE nightwatch_sessions ADD COLUMN interval_minutes INTEGER NOT NULL DEFAULT 5`);
    } catch {
      // Column already exists — ignore
    }

    // Historical task/session records are retained for audit compatibility.
    // Relay-driven task execution was removed by WM-SEC-001 remediation.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_sessions (
        session_id TEXT PRIMARY KEY,
        task_id INTEGER NOT NULL,
        team_slug TEXT NOT NULL,
        task_url TEXT NOT NULL,
        mg_base_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
      );
    `);
  }

}

export { NightWatchStore };
