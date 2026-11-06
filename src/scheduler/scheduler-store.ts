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
import type { ScheduledJob, ScheduledJobRun, CreateJobInput, UpdateJobInput } from "./scheduler-types";
import { JOB_SELECT_COLS, rowToJob, type RawJobRow } from "./scheduler-row";
import { initialiseSchedulerSchema } from "./scheduler-schema";
import { reconcileHeartbeatReliabilityDefaults } from "./heartbeat-reliability-defaults";

// ============================================================
// Types
// ============================================================

export type { TriggerType, ScheduledTriggerType, SchedulerActionType, ScheduledJob, ScheduledJobRun, CreateJobInput, UpdateJobInput } from "./scheduler-types";
export { RELAY_TRIGGER_UNSUPPORTED_REASON } from "./scheduler-types";
// ============================================================
// Raw row type (integers, not booleans)
// ============================================================

// ============================================================
// Store Implementation
// ============================================================

const DEFAULT_DB_PATH = databaseFile;


class SchedulerStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    initialiseSchedulerSchema(this.db);
    reconcileHeartbeatReliabilityDefaults(this);
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
           id, name, user_npub, agent_id, bot_npub,
           wrapped_key_ciphertext, wrapped_key_nonce,
           agent, model, working_directory, initial_prompt,
           nightwatchman_enabled, trigger_type, cron_expression, timezone,
           watch_directory, file_pattern,
           active_start_time, active_end_time,
           action_type, pipeline_definition_id, pipeline_input_json,
           pipeline_agent, wapp_activity_installation_id, enabled, last_run_at, next_run_at,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, NULL, NULL, ?26, ?27)`,
      )
      .run(
        id,
        input.name,
        input.userNpub,
        input.agentId ?? null,
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
        input.enabled === false ? 0 : 1,
        now,
        now,
      );

    if (input.flightdeckContext) this.updateJob(id, { flightdeckContext: input.flightdeckContext });
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

  listJobsForAgent(agentId: string): ScheduledJob[] {
    return this.db.query<RawJobRow, [string]>(
      `SELECT ${JOB_SELECT_COLS} FROM scheduled_jobs WHERE agent_id = ?1 ORDER BY created_at DESC`,
    ).all(agentId).map(rowToJob);
  }

  bindLegacyJobsToAgent(agentId: string, botNpub: string, userNpub: string): number {
    const result = this.db.run(
      `UPDATE scheduled_jobs SET agent_id = ?1, updated_at = ?4
       WHERE agent_id IS NULL AND bot_npub = ?2 AND user_npub = ?3`,
      [agentId, botNpub, userNpub, new Date().toISOString()],
    );
    return result.changes;
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

    if (input.flightdeckContext !== undefined) {
      sets.push(`flightdeck_context_json = ?${paramIndex++}`);
      values.push(input.flightdeckContext === null ? null : JSON.stringify(input.flightdeckContext));
    }
    if (input.name !== undefined) {
      sets.push(`name = ?${paramIndex++}`);
      values.push(input.name);
    }
    if (input.agentId !== undefined) {
      sets.push(`agent_id = ?${paramIndex++}`);
      values.push(input.agentId);
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

  linkSessionRun(runId: string, sessionId: string): void {
    this.db.query("UPDATE scheduled_job_runs SET session_id = ?2 WHERE id = ?1").run(runId, sessionId);
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
    status: "launched" | "success" | "error",
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


}

export { SchedulerStore };
