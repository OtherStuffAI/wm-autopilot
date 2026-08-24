/**
 * Scheduler Store
 *
 * SQLite store for scheduled jobs and run history.
 * Follows the NightWatchStore pattern — shares the main wingman.db database.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { databaseFile } from "../storage/message-store";
import { reconcileHeartbeatReliabilityDefaults } from "./heartbeat-reliability-defaults";

// ============================================================
// Types
// ============================================================

export type TriggerType = "cron" | "file_watcher";
export type ScheduledTriggerType = TriggerType | "unsupported";
export type SchedulerActionType = "session" | "pipeline" | "cleanup";

export const RELAY_TRIGGER_UNSUPPORTED_REASON =
  'Nostr relay scheduler triggers are unsupported and cannot initiate work.';

export interface ScheduledJob {
  id: string;
  name: string;
  userNpub: string;
  botNpub: string;
  wrappedKeyCiphertext: string;
  wrappedKeyNonce: string;
  agent: string;
  model: string | null;
  workingDirectory: string;
  initialPrompt: string;
  nightwatchmanEnabled: boolean;
  triggerType: ScheduledTriggerType;
  persistedTriggerType: string;
  unsupportedReason: string | null;
  cronExpression: string;
  timezone: string;
  watchDirectory: string | null;
  filePattern: string;
  activeStartTime: string | null;
  activeEndTime: string | null;
  actionType: SchedulerActionType;
  pipelineDefinitionId: string | null;
  pipelineInputJson: string | null;
  pipelineAgent: string | null;
  wappActivityInstallationId: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledJobRun {
  id: string;
  jobId: string;
  sessionId: string | null;
  pipelineRunId: string | null;
  startedAt: string;
  status: "started" | "success" | "error";
  errorMessage: string | null;
}

export interface CreateJobInput {
  id?: string;
  name: string;
  userNpub: string;
  botNpub: string;
  wrappedKeyCiphertext: string;
  wrappedKeyNonce: string;
  agent: string;
  model?: string | null;
  workingDirectory: string;
  initialPrompt: string;
  nightwatchmanEnabled?: boolean;
  triggerType?: TriggerType;
  cronExpression?: string;
  timezone?: string;
  watchDirectory?: string;
  filePattern?: string;
  activeStartTime?: string;
  activeEndTime?: string;
  actionType?: SchedulerActionType;
  pipelineDefinitionId?: string | null;
  pipelineInputJson?: string | null;
  pipelineAgent?: string | null;
  wappActivityInstallationId?: string | null;
}

export interface UpdateJobInput {
  name?: string;
  botNpub?: string;
  agent?: string;
  model?: string | null;
  workingDirectory?: string;
  initialPrompt?: string;
  nightwatchmanEnabled?: boolean;
  triggerType?: TriggerType;
  cronExpression?: string;
  timezone?: string;
  watchDirectory?: string;
  filePattern?: string;
  activeStartTime?: string | null;
  activeEndTime?: string | null;
  actionType?: SchedulerActionType;
  pipelineDefinitionId?: string | null;
  pipelineInputJson?: string | null;
  pipelineAgent?: string | null;
  wappActivityInstallationId?: string | null;
  enabled?: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
}

// ============================================================
// Raw row type (integers, not booleans)
// ============================================================

interface RawJobRow {
  id: string;
  name: string;
  userNpub: string;
  botNpub: string;
  wrappedKeyCiphertext: string;
  wrappedKeyNonce: string;
  agent: string;
  model: string | null;
  workingDirectory: string;
  initialPrompt: string;
  nightwatchmanEnabled: number;
  triggerType: string;
  cronExpression: string;
  timezone: string;
  watchDirectory: string | null;
  filePattern: string;
  activeStartTime: string | null;
  activeEndTime: string | null;
  actionType: string;
  pipelineDefinitionId: string | null;
  pipelineInputJson: string | null;
  pipelineAgent: string | null;
  wappActivityInstallationId: string | null;
  enabled: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToJob(row: RawJobRow): ScheduledJob {
  const persistedTriggerType = row.triggerType || "cron";
  const triggerType: ScheduledTriggerType = persistedTriggerType === "cron" || persistedTriggerType === "file_watcher"
    ? persistedTriggerType
    : "unsupported";
  const unsupportedReason = triggerType === "unsupported"
    ? persistedTriggerType === "nostr"
      ? RELAY_TRIGGER_UNSUPPORTED_REASON
      : `Scheduler trigger type "${persistedTriggerType}" is unsupported and cannot initiate work.`
    : null;
  return {
    ...row,
    nightwatchmanEnabled: Boolean(row.nightwatchmanEnabled),
    triggerType,
    persistedTriggerType,
    unsupportedReason,
    actionType: (row.actionType || "session") as SchedulerActionType,
    filePattern: row.filePattern || "*",
    enabled: Boolean(row.enabled) && triggerType !== "unsupported",
  };
}

// ============================================================
// Store Implementation
// ============================================================

const DEFAULT_DB_PATH = databaseFile;

const JOB_SELECT_COLS = `
  id, name,
  user_npub AS userNpub,
  bot_npub AS botNpub,
  wrapped_key_ciphertext AS wrappedKeyCiphertext,
  wrapped_key_nonce AS wrappedKeyNonce,
  agent, model, working_directory AS workingDirectory,
  initial_prompt AS initialPrompt,
  nightwatchman_enabled AS nightwatchmanEnabled,
  trigger_type AS triggerType,
  cron_expression AS cronExpression,
  timezone,
  watch_directory AS watchDirectory,
  file_pattern AS filePattern,
  active_start_time AS activeStartTime,
  active_end_time AS activeEndTime,
  action_type AS actionType,
  pipeline_definition_id AS pipelineDefinitionId,
  pipeline_input_json AS pipelineInputJson,
  pipeline_agent AS pipelineAgent,
  wapp_activity_installation_id AS wappActivityInstallationId,
  enabled,
  last_run_at AS lastRunAt,
  next_run_at AS nextRunAt,
  created_at AS createdAt,
  updated_at AS updatedAt`;

class SchedulerStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initialise();
  }

  // ----------------------------------------------------------
  // Job CRUD
  // ----------------------------------------------------------

  createJob(input: CreateJobInput): ScheduledJob {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();

    this.db
      .query(
        `INSERT INTO scheduled_jobs (
           id, name, user_npub, bot_npub,
           wrapped_key_ciphertext, wrapped_key_nonce,
           agent, model, working_directory, initial_prompt,
           nightwatchman_enabled, trigger_type, cron_expression, timezone,
           watch_directory, file_pattern,
           active_start_time, active_end_time,
           action_type, pipeline_definition_id, pipeline_input_json,
           pipeline_agent, wapp_activity_installation_id, enabled, last_run_at, next_run_at,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, 1, NULL, NULL, ?24, ?25)`,
      )
      .run(
        id,
        input.name,
        input.userNpub,
        input.botNpub,
        input.wrappedKeyCiphertext,
        input.wrappedKeyNonce,
        input.agent,
        input.model ?? null,
        input.workingDirectory,
        input.initialPrompt,
        0,
        input.triggerType ?? "cron",
        input.cronExpression ?? "",
        input.timezone ?? "UTC",
        input.watchDirectory ?? null,
        input.filePattern ?? "*",
        input.activeStartTime ?? null,
        input.activeEndTime ?? null,
        input.actionType ?? "session",
        input.pipelineDefinitionId ?? null,
        input.pipelineInputJson ?? null,
        input.pipelineAgent ?? null,
        input.wappActivityInstallationId ?? null,
        now,
        now,
      );

    return this.getJob(id)!;
  }

  getJob(id: string): ScheduledJob | null {
    const row = this.db
      .query<RawJobRow, [string]>(
        `SELECT ${JOB_SELECT_COLS} FROM scheduled_jobs WHERE id = ?1`,
      )
      .get(id);
    return row ? rowToJob(row) : null;
  }

  listJobs(userNpub?: string): ScheduledJob[] {
    if (userNpub) {
      const rows = this.db
        .query<RawJobRow, [string]>(
          `SELECT ${JOB_SELECT_COLS} FROM scheduled_jobs WHERE user_npub = ?1 ORDER BY created_at DESC`,
        )
        .all(userNpub);
      return rows.map(rowToJob);
    }

    const rows = this.db
      .query<RawJobRow, []>(
        `SELECT ${JOB_SELECT_COLS} FROM scheduled_jobs ORDER BY created_at DESC`,
      )
      .all();
    return rows.map(rowToJob);
  }

  listEnabledJobs(): ScheduledJob[] {
    const rows = this.db
      .query<RawJobRow, []>(
        `SELECT ${JOB_SELECT_COLS} FROM scheduled_jobs WHERE enabled = 1 ORDER BY created_at DESC`,
      )
      .all();
    return rows.map(rowToJob).filter((job) => job.triggerType !== "unsupported");
  }

  updateJob(id: string, input: UpdateJobInput): ScheduledJob | null {
    const sets: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      sets.push(`name = ?${paramIndex++}`);
      values.push(input.name);
    }
    if (input.botNpub !== undefined) {
      sets.push(`bot_npub = ?${paramIndex++}`);
      values.push(input.botNpub);
    }
    if (input.agent !== undefined) {
      sets.push(`agent = ?${paramIndex++}`);
      values.push(input.agent);
    }
    if (input.model !== undefined) {
      sets.push(`model = ?${paramIndex++}`);
      values.push(input.model);
    }
    if (input.workingDirectory !== undefined) {
      sets.push(`working_directory = ?${paramIndex++}`);
      values.push(input.workingDirectory);
    }
    if (input.initialPrompt !== undefined) {
      sets.push(`initial_prompt = ?${paramIndex++}`);
      values.push(input.initialPrompt);
    }
    if (input.nightwatchmanEnabled !== undefined) {
      sets.push(`nightwatchman_enabled = ?${paramIndex++}`);
      values.push(0);
    }
    if (input.triggerType !== undefined) {
      sets.push(`trigger_type = ?${paramIndex++}`);
      values.push(input.triggerType);
    }
    if (input.cronExpression !== undefined) {
      sets.push(`cron_expression = ?${paramIndex++}`);
      values.push(input.cronExpression);
    }
    if (input.timezone !== undefined) {
      sets.push(`timezone = ?${paramIndex++}`);
      values.push(input.timezone);
    }
    if (input.watchDirectory !== undefined) {
      sets.push(`watch_directory = ?${paramIndex++}`);
      values.push(input.watchDirectory);
    }
    if (input.filePattern !== undefined) {
      sets.push(`file_pattern = ?${paramIndex++}`);
      values.push(input.filePattern);
    }
    if (input.activeStartTime !== undefined) {
      sets.push(`active_start_time = ?${paramIndex++}`);
      values.push(input.activeStartTime);
    }
    if (input.activeEndTime !== undefined) {
      sets.push(`active_end_time = ?${paramIndex++}`);
      values.push(input.activeEndTime);
    }
    if (input.actionType !== undefined) {
      sets.push(`action_type = ?${paramIndex++}`);
      values.push(input.actionType);
    }
    if (input.pipelineDefinitionId !== undefined) {
      sets.push(`pipeline_definition_id = ?${paramIndex++}`);
      values.push(input.pipelineDefinitionId);
    }
    if (input.pipelineInputJson !== undefined) {
      sets.push(`pipeline_input_json = ?${paramIndex++}`);
      values.push(input.pipelineInputJson);
    }
    if (input.pipelineAgent !== undefined) {
      sets.push(`pipeline_agent = ?${paramIndex++}`);
      values.push(input.pipelineAgent);
    }
    if (input.wappActivityInstallationId !== undefined) {
      sets.push(`wapp_activity_installation_id = ?${paramIndex++}`);
      values.push(input.wappActivityInstallationId);
    }
    if (input.enabled !== undefined) {
      sets.push(`enabled = ?${paramIndex++}`);
      values.push(input.enabled ? 1 : 0);
    }
    if (input.lastRunAt !== undefined) {
      sets.push(`last_run_at = ?${paramIndex++}`);
      values.push(input.lastRunAt);
    }
    if (input.nextRunAt !== undefined) {
      sets.push(`next_run_at = ?${paramIndex++}`);
      values.push(input.nextRunAt);
    }

    if (sets.length === 0) return this.getJob(id);

    const now = new Date().toISOString();
    sets.push(`updated_at = ?${paramIndex++}`);
    values.push(now);

    values.push(id);

    this.db
      .query(`UPDATE scheduled_jobs SET ${sets.join(", ")} WHERE id = ?${paramIndex}`)
      .run(...(values as [string, ...string[]]));

    return this.getJob(id);
  }

  deleteJob(id: string): boolean {
    // Delete runs first (FK cascade)
    this.db.query("DELETE FROM scheduled_job_runs WHERE job_id = ?1").run(id);
    const result = this.db.query("DELETE FROM scheduled_jobs WHERE id = ?1").run(id);
    return result.changes > 0;
  }

  // ----------------------------------------------------------
  // Run History
  // ----------------------------------------------------------

  recordRun(jobId: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO scheduled_job_runs (id, job_id, session_id, pipeline_run_id, started_at, status, error_message)
         VALUES (?1, ?2, NULL, NULL, ?3, 'started', NULL)`,
      )
      .run(id, jobId, now);
    return id;
  }

  linkPipelineRun(runId: string, pipelineRunId: string): void {
    this.db
      .query(
        `UPDATE scheduled_job_runs
         SET pipeline_run_id = ?2
         WHERE id = ?1`,
      )
      .run(runId, pipelineRunId);
  }

  completeRun(
    runId: string,
    status: "success" | "error",
    sessionId?: string,
    errorMessage?: string,
    pipelineRunId?: string,
  ): void {
    this.db
      .query(
        `UPDATE scheduled_job_runs
         SET status = ?2, session_id = ?3, error_message = ?4, pipeline_run_id = COALESCE(?5, pipeline_run_id)
         WHERE id = ?1`,
      )
      .run(runId, status, sessionId ?? null, errorMessage ?? null, pipelineRunId ?? null);
  }

  getJobRuns(jobId: string, limit = 20): ScheduledJobRun[] {
    return this.db
      .query<ScheduledJobRun, [string, number]>(
        `SELECT
           id,
           job_id AS jobId,
           session_id AS sessionId,
           pipeline_run_id AS pipelineRunId,
           started_at AS startedAt,
           status,
           error_message AS errorMessage
         FROM scheduled_job_runs
         WHERE job_id = ?1
         ORDER BY started_at DESC
         LIMIT ?2`,
      )
      .all(jobId, limit);
  }

  // ----------------------------------------------------------
  // Initialization
  // ----------------------------------------------------------

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        user_npub TEXT NOT NULL,
        bot_npub TEXT NOT NULL,
        wrapped_key_ciphertext TEXT NOT NULL,
        wrapped_key_nonce TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT,
        working_directory TEXT NOT NULL,
        initial_prompt TEXT NOT NULL,
        nightwatchman_enabled INTEGER NOT NULL DEFAULT 0,
        action_type TEXT NOT NULL DEFAULT 'session',
        pipeline_definition_id TEXT,
        pipeline_input_json TEXT,
        pipeline_agent TEXT,
        cron_expression TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_user
        ON scheduled_jobs(user_npub);
      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_enabled
        ON scheduled_jobs(enabled);

      CREATE TABLE IF NOT EXISTS scheduled_job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        session_id TEXT,
        pipeline_run_id TEXT,
        started_at TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job
        ON scheduled_job_runs(job_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_started
        ON scheduled_job_runs(started_at DESC);
    `);

    // Migration: add trigger_type columns for file watcher support
    const migrations = [
      "ALTER TABLE scheduled_jobs ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'cron'",
      "ALTER TABLE scheduled_jobs ADD COLUMN watch_directory TEXT",
      "ALTER TABLE scheduled_jobs ADD COLUMN file_pattern TEXT DEFAULT '*'",
      "ALTER TABLE scheduled_jobs ADD COLUMN active_start_time TEXT",
      "ALTER TABLE scheduled_jobs ADD COLUMN active_end_time TEXT",
      "ALTER TABLE scheduled_jobs ADD COLUMN action_type TEXT NOT NULL DEFAULT 'session'",
      "ALTER TABLE scheduled_jobs ADD COLUMN pipeline_definition_id TEXT",
      "ALTER TABLE scheduled_jobs ADD COLUMN pipeline_input_json TEXT",
      "ALTER TABLE scheduled_jobs ADD COLUMN pipeline_agent TEXT",
      "ALTER TABLE scheduled_job_runs ADD COLUMN pipeline_run_id TEXT",
      "ALTER TABLE scheduled_jobs ADD COLUMN wapp_activity_installation_id TEXT",
      "ALTER TABLE scheduled_jobs ADD COLUMN model TEXT",
    ];
    for (const sql of migrations) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
    this.db.exec("UPDATE scheduled_jobs SET nightwatchman_enabled = 0 WHERE nightwatchman_enabled <> 0");
    reconcileHeartbeatReliabilityDefaults(this);
  }
}

export { SchedulerStore };
