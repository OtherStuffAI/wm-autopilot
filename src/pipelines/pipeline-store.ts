import { Database, type SQLQueryBindings } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export type JsonObject = Record<string, unknown>;
export type PipelineScope = "shared" | "user";
export type StepKind = "code" | "agent" | "classifier" | "loop" | "block" | "parallel";
export type PipelineStatus = "queued" | "running" | "ok" | "needs_input" | "error" | "skipped" | "cancelled";

export interface PipelineRunRecord {
  id: string;
  definitionId: string;
  definitionPath: string | null;
  name: string;
  status: PipelineStatus;
  ownerNpub: string | null;
  ownerAlias: string | null;
  scope: PipelineScope;
  input: JsonObject;
  current: JsonObject;
  cursorIndex: number;
  activeStepId: string | null;
  result: JsonObject | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface PipelineRunSummary {
  id: string;
  definitionId: string;
  definitionPath: string | null;
  name: string;
  status: PipelineStatus;
  ownerNpub: string | null;
  ownerAlias: string | null;
  scope: PipelineScope;
  cursorIndex: number;
  activeStepId: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  inputBytes: number;
  currentBytes: number;
  resultBytes: number;
  hasInput: boolean;
  hasCurrent: boolean;
  hasResult: boolean;
}

export interface PipelineStepRecord {
  id: string;
  runId: string;
  stepIndex: number;
  name: string;
  kind: StepKind;
  status: PipelineStatus;
  input: JsonObject;
  result: JsonObject | null;
  error: string | null;
  wingmanSessionId: string | null;
  parentStepId: string | null;
  logicalKey: string | null;
  callbackToken: string | null;
  output: JsonObject | null;
  metadata: JsonObject | null;
  startedAt: string;
  completedAt: string | null;
}

export interface PipelineStepSummary {
  id: string;
  runId: string;
  stepIndex: number;
  name: string;
  kind: StepKind;
  status: PipelineStatus;
  error: string | null;
  wingmanSessionId: string | null;
  parentStepId: string | null;
  logicalKey: string | null;
  callbackToken: string | null;
  metadata: JsonObject | null;
  startedAt: string;
  completedAt: string | null;
  inputBytes: number;
  resultBytes: number;
  outputBytes: number;
  hasInput: boolean;
  hasResult: boolean;
  hasOutput: boolean;
}

export interface PipelinePayloadCompactionResult {
  matchedRuns: number;
  compactedSteps: number;
  compactedEvents: number;
}

const DEFAULT_DB_PATH = "data/pipelines.sqlite";

function now(): string {
  return new Date().toISOString();
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(encodeJson(value), "utf8");
}

function decodeJsonObject(value: unknown): JsonObject {
  if (typeof value !== "string" || value.length === 0) return {};
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
}

function decodeNullableJsonObject(value: unknown): JsonObject | null {
  if (value === null || value === undefined) return null;
  return decodeJsonObject(value);
}

function tryDecodeJsonObject(value: unknown): JsonObject {
  try {
    return decodeJsonObject(value);
  } catch {
    return {};
  }
}

export class PipelineStore {
  readonly path: string;
  private readonly db: Database;

  constructor(path = process.env.WINGMEN_PIPELINES_DB || DEFAULT_DB_PATH) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  createRun(input: {
    definitionId: string;
    definitionPath?: string | null;
    name: string;
    ownerNpub?: string | null;
    ownerAlias?: string | null;
    scope: PipelineScope;
    input: JsonObject;
  }): PipelineRunRecord {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO pipeline_runs (
        id, definition_id, definition_path, name, status, owner_npub, owner_alias, scope,
        input_json, current_json, cursor_index, active_step_id, result_json, error, started_at, completed_at
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, NULL)`,
      [
        id,
        input.definitionId,
        input.definitionPath ?? null,
        input.name,
        input.ownerNpub ?? null,
        input.ownerAlias ?? null,
        input.scope,
        encodeJson(input.input),
        encodeJson(input.input),
        now(),
      ],
    );
    return this.getRun(id)!;
  }

  completeRun(id: string, status: PipelineStatus, result: JsonObject | null, error?: string | null): PipelineRunRecord {
    this.db.run(
      `UPDATE pipeline_runs SET status = ?, result_json = ?, error = ?, active_step_id = NULL, completed_at = ? WHERE id = ?`,
      [status, result ? encodeJson(result) : null, error ?? null, now(), id],
    );
    return this.getRun(id)!;
  }

  cancelRun(id: string, reason = "Pipeline run cancelled"): PipelineRunRecord | null {
    const run = this.getRun(id);
    if (!run || run.status !== "running") return run;
    const completedAt = now();
    const runningSteps = this.listSteps(id).filter((step) => step.status === "running" || step.status === "queued");
    this.db.transaction(() => {
      for (const step of runningSteps) {
        this.db.run(
          `UPDATE pipeline_steps SET status = 'cancelled', error = ?, completed_at = ? WHERE id = ? AND status IN ('running', 'queued')`,
          [reason, completedAt, step.id],
        );
      }
      this.db.run(
        `UPDATE pipeline_runs
         SET status = 'cancelled', result_json = ?, error = ?, active_step_id = NULL, completed_at = ?
         WHERE id = ? AND status = 'running'`,
        [encodeJson(run.current), reason, completedAt, id],
      );
    })();
    for (const step of runningSteps) {
      this.addEvent({
        runId: step.runId,
        stepId: step.id,
        level: "warn",
        type: "step_cancelled",
        message: reason,
        data: {},
      });
    }
    this.addEvent({
      runId: id,
      level: "warn",
      type: "run_cancelled",
      message: reason,
      data: { activeStepId: run.activeStepId },
    });
    return this.getRun(id);
  }

  reopenErroredRun(id: string): PipelineRunRecord | null {
    const run = this.getRun(id);
    if (!run || run.status !== "error") return run;
    this.db.run(
      `UPDATE pipeline_runs
       SET status = 'running', result_json = NULL, error = NULL, active_step_id = NULL, completed_at = NULL
       WHERE id = ? AND status = 'error'`,
      [id],
    );
    this.addEvent({
      runId: id,
      level: "warn",
      type: "run_reopened",
      message: "Manual resume from failed step",
      data: {
        cursorIndex: run.cursorIndex,
        previousError: run.error,
      },
    });
    return this.getRun(id);
  }

  createStep(input: {
    runId: string;
    stepIndex: number;
    name: string;
    kind: StepKind;
    input: JsonObject;
    status?: PipelineStatus;
    parentStepId?: string | null;
    logicalKey?: string | null;
    callbackToken?: string | null;
    metadata?: JsonObject | null;
  }): PipelineStepRecord {
    const id = crypto.randomUUID();
    const status = input.status ?? "running";
    this.db.run(
      `INSERT INTO pipeline_steps (
        id, run_id, step_index, name, kind, status, input_json, result_json, error,
        wingman_session_id, parent_step_id, logical_key, callback_token, output_json, metadata_json, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, ?, ?, NULL)`,
      [
        id,
        input.runId,
        input.stepIndex,
        input.name,
        input.kind,
        status,
        encodeJson(input.input),
        input.parentStepId ?? null,
        input.logicalKey ?? null,
        input.callbackToken ?? null,
        input.metadata ? encodeJson(input.metadata) : null,
        now(),
      ],
    );
    this.addEvent({
      runId: input.runId,
      stepId: id,
      level: "info",
      type: status === "queued" ? "step_queued" : "step_started",
      message: input.name,
      data: compactStepEventData({
        storage: "compact",
        phase: "started",
        inputBytes: jsonByteLength(input.input),
        metadata: input.metadata ?? null,
      }),
    });
    return this.getStep(id)!;
  }

  startStep(id: string): PipelineStepRecord {
    this.db.run(`UPDATE pipeline_steps SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`, [now(), id]);
    const step = this.getStep(id)!;
    this.addEvent({
      runId: step.runId,
      stepId: id,
      level: "info",
      type: "step_started",
      message: step.name,
      data: compactStepEventData({
        storage: "compact",
        phase: "started",
        inputBytes: jsonByteLength(step.input),
        metadata: step.metadata,
      }),
    });
    return step;
  }

  completeStep(input: {
    id: string;
    status: PipelineStatus;
    result: JsonObject | null;
    output?: JsonObject | null;
    error?: string | null;
    wingmanSessionId?: string | null;
  }): PipelineStepRecord {
    this.db.run(
      `UPDATE pipeline_steps
       SET status = ?, result_json = ?, output_json = COALESCE(?, output_json), error = ?, wingman_session_id = COALESCE(?, wingman_session_id), completed_at = ?
       WHERE id = ?`,
      [
        input.status,
        input.result ? encodeJson(input.result) : null,
        input.output ? encodeJson(input.output) : null,
        input.error ?? null,
        input.wingmanSessionId ?? null,
        now(),
        input.id,
      ],
    );
    const step = this.getStep(input.id)!;
    this.addEvent({
      runId: step.runId,
      stepId: input.id,
      level: input.status === "ok" ? "info" : "warn",
      type: "step_completed",
      message: input.status,
      data: compactStepEventData({
        storage: "compact",
        phase: "completed",
        inputBytes: jsonByteLength(step.input),
        resultBytes: input.result ? jsonByteLength(input.result) : 0,
        outputBytes: input.output ? jsonByteLength(input.output) : 0,
        status: input.status,
        metadata: step.metadata,
      }),
    });
    return step;
  }

  setStepSession(stepId: string, sessionId: string): void {
    this.db.run(`UPDATE pipeline_steps SET wingman_session_id = ? WHERE id = ?`, [sessionId, stepId]);
  }

  setStepCallbackToken(stepId: string, token: string): void {
    this.db.run(`UPDATE pipeline_steps SET callback_token = ? WHERE id = ?`, [token, stepId]);
  }

  updateRunProgress(runId: string, current: JsonObject, cursorIndex: number): void {
    this.db.run(
      `UPDATE pipeline_runs SET current_json = ?, cursor_index = ?, active_step_id = NULL WHERE id = ?`,
      [encodeJson(current), cursorIndex, runId],
    );
  }

  setRunActiveStep(runId: string, stepId: string | null): void {
    this.db.run(`UPDATE pipeline_runs SET active_step_id = ? WHERE id = ?`, [stepId, runId]);
  }

  getRun(id: string): PipelineRunRecord | null {
    const row = this.db.query(`SELECT * FROM pipeline_runs WHERE id = ?`).get(id) as Record<string, unknown> | null;
    return row ? mapRun(row) : null;
  }

  getRunSummary(id: string): PipelineRunSummary | null {
    const row = this.db.query(runSummarySelectSql(`WHERE id = ?`)).get(id) as Record<string, unknown> | null;
    return row ? mapRunSummary(row) : null;
  }

  getStep(id: string): PipelineStepRecord | null {
    const row = this.db.query(`SELECT * FROM pipeline_steps WHERE id = ?`).get(id) as Record<string, unknown> | null;
    return row ? mapStep(row) : null;
  }

  listRunSummaries(options: { ownerNpub?: string | null; includeShared?: boolean; limit?: number } = {}): PipelineRunSummary[] {
    const limit = options.limit ?? 100;
    let rows: Record<string, unknown>[];
    if (options.ownerNpub) {
      rows = this.db.query(
        runSummarySelectSql(`
          WHERE owner_npub = ? OR (? = 1 AND scope = 'shared')
          ORDER BY started_at DESC LIMIT ?
        `),
      ).all(options.ownerNpub, options.includeShared ? 1 : 0, limit) as Record<string, unknown>[];
    } else {
      rows = this.db.query(runSummarySelectSql(`ORDER BY started_at DESC LIMIT ?`)).all(limit) as Record<string, unknown>[];
    }
    return rows.map(mapRunSummary);
  }

  listRuns(options: { ownerNpub?: string | null; includeShared?: boolean; limit?: number } = {}): PipelineRunRecord[] {
    const limit = options.limit ?? 100;
    let rows: Record<string, unknown>[];
    if (options.ownerNpub) {
      rows = this.db.query(
        `SELECT * FROM pipeline_runs
         WHERE owner_npub = ? OR (? = 1 AND scope = 'shared')
         ORDER BY started_at DESC LIMIT ?`,
      ).all(options.ownerNpub, options.includeShared ? 1 : 0, limit) as Record<string, unknown>[];
    } else {
      rows = this.db.query(`SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
    }
    return rows.map(mapRun);
  }

  listSteps(runId: string): PipelineStepRecord[] {
    const rows = this.db
      .query(`SELECT * FROM pipeline_steps WHERE run_id = ? ORDER BY step_index ASC`)
      .all(runId) as Record<string, unknown>[];
    return rows.map(mapStep);
  }

  listChildSteps(parentStepId: string): PipelineStepRecord[] {
    const rows = this.db
      .query(`SELECT * FROM pipeline_steps WHERE parent_step_id = ? ORDER BY step_index ASC`)
      .all(parentStepId) as Record<string, unknown>[];
    return rows.map(mapStep);
  }

  listRunningRuns(): PipelineRunRecord[] {
    const rows = this.db
      .query(`SELECT * FROM pipeline_runs WHERE status = 'running' ORDER BY started_at ASC`)
      .all() as Record<string, unknown>[];
    return rows.map(mapRun);
  }

  listStepSummaries(runId: string): PipelineStepSummary[] {
    const rows = this.db
      .query(`
        SELECT
          id, run_id, step_index, name, kind, status, error, wingman_session_id,
          parent_step_id, logical_key, callback_token, metadata_json, started_at, completed_at,
          length(coalesce(input_json, '')) AS input_bytes,
          length(coalesce(result_json, '')) AS result_bytes,
          length(coalesce(output_json, '')) AS output_bytes
        FROM pipeline_steps
        WHERE run_id = ?
        ORDER BY step_index ASC
      `)
      .all(runId) as Record<string, unknown>[];
    return rows.map(mapStepSummary);
  }

  compactCompletedRunPayloads(options: {
    ownerNpub?: string | null;
    includeShared?: boolean;
    definitionId?: string | null;
    runName?: string | null;
    includeErrored?: boolean;
    olderThan?: string | null;
    limit?: number;
    dryRun?: boolean;
  } = {}): PipelinePayloadCompactionResult {
    const filters = [
      "status IN ('ok', 'cancelled', 'skipped', 'needs_input')",
      `EXISTS (
        SELECT 1 FROM pipeline_steps
        WHERE pipeline_steps.run_id = pipeline_runs.id
          AND (
            pipeline_steps.input_json <> '{}'
            OR pipeline_steps.result_json IS NOT NULL
            OR pipeline_steps.output_json IS NOT NULL
          )
      )`,
    ];
    const args: SQLQueryBindings[] = [];
    if (options.includeErrored) {
      filters[0] = "status IN ('ok', 'cancelled', 'skipped', 'needs_input', 'error')";
    }
    if (options.ownerNpub) {
      filters.push("(owner_npub = ? OR (? = 1 AND scope = 'shared'))");
      args.push(options.ownerNpub, options.includeShared ? 1 : 0);
    }
    if (options.definitionId) {
      filters.push("definition_id = ?");
      args.push(options.definitionId);
    }
    if (options.runName) {
      filters.push("name = ?");
      args.push(options.runName);
    }
    if (options.olderThan) {
      filters.push("completed_at IS NOT NULL AND completed_at < ?");
      args.push(options.olderThan);
    }
    const limit = normalisePositiveInteger(options.limit);
    const limitSql = limit === null ? "" : ` LIMIT ${limit}`;
    const targetSql = `
      SELECT id FROM pipeline_runs
      WHERE ${filters.join(" AND ")}
      ORDER BY completed_at ASC, started_at ASC
      ${limitSql}
    `;

    const rows = this.db.query(targetSql).all(...args) as Array<{ id: string }>;
    if (rows.length === 0 || options.dryRun) {
      return {
        matchedRuns: rows.length,
        compactedSteps: this.countCompactableSteps(rows.map((row) => row.id)),
        compactedEvents: this.countCompactableEvents(rows.map((row) => row.id)),
      };
    }

    return this.db.transaction((runIds: string[]) => {
      const placeholders = runIds.map(() => "?").join(", ");
      const compactedSteps = Number((this.db.query(
        `SELECT count(*) AS count FROM pipeline_steps
         WHERE run_id IN (${placeholders})
           AND (input_json <> '{}' OR result_json IS NOT NULL OR output_json IS NOT NULL)`,
      ).get(...runIds) as { count?: number } | null)?.count ?? 0);
      const compactedEvents = Number((this.db.query(
        `SELECT count(*) AS count FROM pipeline_events
         WHERE run_id IN (${placeholders}) AND type IN ('step_started', 'step_queued', 'step_completed') AND data_json <> '{}'`,
      ).get(...runIds) as { count?: number } | null)?.count ?? 0);

      const stepRows = this.db.query(
        `SELECT id, input_json, result_json, output_json, metadata_json
         FROM pipeline_steps
         WHERE run_id IN (${placeholders})
           AND (input_json <> '{}' OR result_json IS NOT NULL OR output_json IS NOT NULL)`,
      ).all(...runIds) as Array<Record<string, unknown>>;
      for (const row of stepRows) {
        const metadata = tryDecodeJsonObject(row.metadata_json);
        this.db.run(
          `UPDATE pipeline_steps SET metadata_json = ? WHERE id = ?`,
          [
            encodeJson({
              ...metadata,
              compactedDisplay: buildCompactedDisplaySnapshot({
                input: tryDecodeJsonObject(row.input_json),
                result: row.result_json === null || row.result_json === undefined ? null : tryDecodeJsonObject(row.result_json),
                output: row.output_json === null || row.output_json === undefined ? null : tryDecodeJsonObject(row.output_json),
              }),
            }),
            String(row.id),
          ],
        );
      }

      this.db.run(
        `UPDATE pipeline_steps
         SET input_json = '{}', result_json = NULL, output_json = NULL
         WHERE run_id IN (${placeholders})`,
        runIds,
      );
      this.db.run(
        `UPDATE pipeline_events
         SET data_json = '{}'
         WHERE run_id IN (${placeholders}) AND type IN ('step_started', 'step_queued', 'step_completed')`,
        runIds,
      );
      return {
        matchedRuns: runIds.length,
        compactedSteps,
        compactedEvents,
      };
    })(rows.map((row) => row.id));
  }

  private countCompactableSteps(runIds: string[]): number {
    if (runIds.length === 0) return 0;
    const placeholders = runIds.map(() => "?").join(", ");
    return Number((this.db.query(
      `SELECT count(*) AS count FROM pipeline_steps
       WHERE run_id IN (${placeholders})
         AND (input_json <> '{}' OR result_json IS NOT NULL OR output_json IS NOT NULL)`,
    ).get(...runIds) as { count?: number } | null)?.count ?? 0);
  }

  private countCompactableEvents(runIds: string[]): number {
    if (runIds.length === 0) return 0;
    const placeholders = runIds.map(() => "?").join(", ");
    return Number((this.db.query(
      `SELECT count(*) AS count FROM pipeline_events
       WHERE run_id IN (${placeholders}) AND type IN ('step_started', 'step_queued', 'step_completed') AND data_json <> '{}'`,
    ).get(...runIds) as { count?: number } | null)?.count ?? 0);
  }

  listEventsForStep(stepId: string): Array<Record<string, unknown>> {
    return this.db.query(`SELECT * FROM pipeline_events WHERE step_id = ? ORDER BY ts ASC`).all(stepId) as Array<Record<string, unknown>>;
  }

  listCallbacksForStep(stepId: string): Array<Record<string, unknown>> {
    return this.db.query(`SELECT * FROM pipeline_callbacks WHERE step_id = ? ORDER BY received_at ASC`).all(stepId) as Array<Record<string, unknown>>;
  }

  addCallback(input: { stepId: string; accepted: boolean; payload: JsonObject; error?: string | null }): void {
    this.db.run(
      `INSERT INTO pipeline_callbacks (id, step_id, received_at, accepted, payload_json, error) VALUES (?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), input.stepId, now(), input.accepted ? 1 : 0, encodeJson(input.payload), input.error ?? null],
    );
  }

  addEvent(input: {
    runId?: string | null;
    stepId?: string | null;
    level: "debug" | "info" | "warn" | "error";
    type: string;
    message?: string;
    data?: JsonObject;
  }): void {
    this.db.run(
      `INSERT INTO pipeline_events (id, run_id, step_id, ts, level, type, message, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        input.runId ?? null,
        input.stepId ?? null,
        now(),
        input.level,
        input.type,
        input.message ?? null,
        encodeJson(input.data ?? {}),
      ],
    );
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL,
        definition_path TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_npub TEXT,
        owner_alias TEXT,
        scope TEXT NOT NULL,
        input_json TEXT NOT NULL,
        current_json TEXT NOT NULL DEFAULT '{}',
        cursor_index INTEGER NOT NULL DEFAULT 0,
        active_step_id TEXT,
        result_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        wingman_session_id TEXT,
        parent_step_id TEXT,
        logical_key TEXT,
        callback_token TEXT,
        output_json TEXT,
        metadata_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);
    this.ensureColumn("pipeline_runs", "current_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("pipeline_runs", "cursor_index", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("pipeline_runs", "active_step_id", "TEXT");
    this.db.run(`UPDATE pipeline_runs SET current_json = input_json WHERE status = 'running' AND cursor_index = 0 AND current_json = '{}'`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started ON pipeline_runs(started_at DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_runs_owner_started ON pipeline_runs(owner_npub, started_at DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_runs_scope_started ON pipeline_runs(scope, started_at DESC)`);
    this.ensureColumn("pipeline_steps", "parent_step_id", "TEXT");
    this.ensureColumn("pipeline_steps", "logical_key", "TEXT");
    this.ensureColumn("pipeline_steps", "output_json", "TEXT");
    this.ensureColumn("pipeline_steps", "metadata_json", "TEXT");
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_steps_run_order ON pipeline_steps(run_id, step_index)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_steps_parent_order ON pipeline_steps(parent_step_id, step_index)`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_events (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        step_id TEXT,
        ts TEXT NOT NULL,
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT,
        data_json TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_events_step_ts ON pipeline_events(step_id, ts)`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_callbacks (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL REFERENCES pipeline_steps(id) ON DELETE CASCADE,
        received_at TEXT NOT NULL,
        accepted INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        error TEXT
      )
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (!rows.some((row) => row.name === column)) {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

function mapRun(row: Record<string, unknown>): PipelineRunRecord {
  return {
    id: String(row.id),
    definitionId: String(row.definition_id),
    definitionPath: row.definition_path === null || row.definition_path === undefined ? null : String(row.definition_path),
    name: String(row.name),
    status: row.status as PipelineStatus,
    ownerNpub: row.owner_npub === null || row.owner_npub === undefined ? null : String(row.owner_npub),
    ownerAlias: row.owner_alias === null || row.owner_alias === undefined ? null : String(row.owner_alias),
    scope: row.scope as PipelineScope,
    input: decodeJsonObject(row.input_json),
    current: decodeJsonObject(row.current_json ?? row.input_json),
    cursorIndex: Number(row.cursor_index ?? 0),
    activeStepId: row.active_step_id === null || row.active_step_id === undefined ? null : String(row.active_step_id),
    result: decodeNullableJsonObject(row.result_json),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
  };
}

function runSummarySelectSql(suffix: string): string {
  return `
    SELECT
      id, definition_id, definition_path, name, status, owner_npub, owner_alias, scope,
      cursor_index, active_step_id, error, started_at, completed_at,
      length(coalesce(input_json, '')) AS input_bytes,
      length(coalesce(current_json, '')) AS current_bytes,
      length(coalesce(result_json, '')) AS result_bytes
    FROM pipeline_runs
    ${suffix}
  `;
}

function mapRunSummary(row: Record<string, unknown>): PipelineRunSummary {
  const inputBytes = Number(row.input_bytes ?? 0);
  const currentBytes = Number(row.current_bytes ?? 0);
  const resultBytes = Number(row.result_bytes ?? 0);
  return {
    id: String(row.id),
    definitionId: String(row.definition_id),
    definitionPath: row.definition_path === null || row.definition_path === undefined ? null : String(row.definition_path),
    name: String(row.name),
    status: row.status as PipelineStatus,
    ownerNpub: row.owner_npub === null || row.owner_npub === undefined ? null : String(row.owner_npub),
    ownerAlias: row.owner_alias === null || row.owner_alias === undefined ? null : String(row.owner_alias),
    scope: row.scope as PipelineScope,
    cursorIndex: Number(row.cursor_index ?? 0),
    activeStepId: row.active_step_id === null || row.active_step_id === undefined ? null : String(row.active_step_id),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
    inputBytes,
    currentBytes,
    resultBytes,
    hasInput: inputBytes > 0,
    hasCurrent: currentBytes > 0,
    hasResult: resultBytes > 0,
  };
}

function mapStep(row: Record<string, unknown>): PipelineStepRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepIndex: Number(row.step_index),
    name: String(row.name),
    kind: row.kind as StepKind,
    status: row.status as PipelineStatus,
    input: decodeJsonObject(row.input_json),
    result: decodeNullableJsonObject(row.result_json),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    wingmanSessionId: row.wingman_session_id === null || row.wingman_session_id === undefined ? null : String(row.wingman_session_id),
    parentStepId: row.parent_step_id === null || row.parent_step_id === undefined ? null : String(row.parent_step_id),
    logicalKey: row.logical_key === null || row.logical_key === undefined ? null : String(row.logical_key),
    callbackToken: row.callback_token === null || row.callback_token === undefined ? null : String(row.callback_token),
    output: decodeNullableJsonObject(row.output_json),
    metadata: decodeNullableJsonObject(row.metadata_json),
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
  };
}

function mapStepSummary(row: Record<string, unknown>): PipelineStepSummary {
  const inputBytes = Number(row.input_bytes ?? 0);
  const resultBytes = Number(row.result_bytes ?? 0);
  const outputBytes = Number(row.output_bytes ?? 0);
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepIndex: Number(row.step_index),
    name: String(row.name),
    kind: row.kind as StepKind,
    status: row.status as PipelineStatus,
    error: row.error === null || row.error === undefined ? null : String(row.error),
    wingmanSessionId: row.wingman_session_id === null || row.wingman_session_id === undefined ? null : String(row.wingman_session_id),
    parentStepId: row.parent_step_id === null || row.parent_step_id === undefined ? null : String(row.parent_step_id),
    logicalKey: row.logical_key === null || row.logical_key === undefined ? null : String(row.logical_key),
    callbackToken: row.callback_token === null || row.callback_token === undefined ? null : String(row.callback_token),
    metadata: decodeNullableJsonObject(row.metadata_json),
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
    inputBytes,
    resultBytes,
    outputBytes,
    hasInput: inputBytes > 0,
    hasResult: resultBytes > 0,
    hasOutput: outputBytes > 0,
  };
}

function compactStepEventData(input: {
  storage: "compact";
  phase: "started" | "completed";
  inputBytes?: number;
  resultBytes?: number;
  outputBytes?: number;
  status?: PipelineStatus;
  metadata?: JsonObject | null;
}): JsonObject {
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  return compactObject({
    storage: input.storage,
    phase: input.phase,
    status: input.status,
    inputBytes: input.inputBytes,
    resultBytes: input.resultBytes,
    outputBytes: input.outputBytes,
    hasInput: typeof input.inputBytes === "number" ? input.inputBytes > 2 : undefined,
    hasResult: typeof input.resultBytes === "number" ? input.resultBytes > 0 : undefined,
    hasOutput: typeof input.outputBytes === "number" ? input.outputBytes > 0 : undefined,
    assign: metadata.assign,
    logicalKey: metadata.logicalKey,
  });
}

function compactObject(input: Record<string, unknown>): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    output[key] = value;
  }
  return output;
}

function normalisePositiveInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function buildCompactedDisplaySnapshot(input: {
  input: JsonObject;
  result: JsonObject | null;
  output: JsonObject | null;
}): JsonObject {
  return {
    in: buildCompactedDisplayRows(input.input),
    out: buildCompactedDisplayRows(input.output ?? input.result ?? {}),
  };
}

function buildCompactedDisplayRows(value: unknown): Array<{ name: string; value: unknown }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined && child !== null)
    .slice(0, 8)
    .map(([name, child]) => ({
      name,
      value: compactDisplayValue(child),
      inspectValue: child,
    }));
}

function compactDisplayValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 497)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return {
      type: "array",
      count: value.length,
      preview: value.slice(0, 5).map(compactDisplayValue),
    };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      type: "object",
      fields: entries.length,
      preview: Object.fromEntries(entries.slice(0, 5).map(([key, child]) => [key, compactDisplayValue(child)])),
    };
  }
  return String(value);
}
