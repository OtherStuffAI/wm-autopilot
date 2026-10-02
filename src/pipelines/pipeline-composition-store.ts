import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { PipelineDefinitionRecord } from "./pipeline-loader";

import { snapshotPipelineBlocks, type PipelineBlockSnapshots } from "./pipeline-block-snapshot";

export interface PipelineRunContext {
  blockExpansions?: PipelineBlockSnapshots;
  viewerDefinition?: PipelineDefinitionRecord;
  viewerBlockExpansions?: PipelineBlockSnapshots;
  functionHashes?: Record<string, string>;
  initiatingAgentProfileId?: string | null;
  initiatingAgentNpub?: string | null;
}
export interface ChildRunLink {
  parentRunId: string;
  parentStepId: string;
  childRunId: string;
  deadline: number;
}

/** Durable composition state lives beside the runner's cursor and step records. */
export class PipelineCompositionStore {
  constructor(private readonly db: Database, private readonly sanitize: (value: unknown) => { value: unknown }) {
    db.run(`CREATE TABLE IF NOT EXISTS pipeline_run_snapshots (
      run_id TEXT PRIMARY KEY REFERENCES pipeline_runs(id) ON DELETE CASCADE,
      definition_json TEXT NOT NULL, definition_hash TEXT NOT NULL, context_json TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS pipeline_child_runs (
      parent_step_id TEXT PRIMARY KEY REFERENCES pipeline_steps(id) ON DELETE CASCADE,
      parent_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
      child_run_id TEXT NOT NULL UNIQUE REFERENCES pipeline_runs(id) ON DELETE CASCADE,
      deadline INTEGER NOT NULL
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_child_parent ON pipeline_child_runs(parent_run_id)`);
  }

  transaction<T>(action: () => T): T {
    return this.db.transaction(action)();
  }

  pin(runId: string, definition: PipelineDefinitionRecord, context: PipelineRunContext): void {
    if (this.db.query("SELECT 1 FROM pipeline_run_snapshots WHERE run_id = ?").get(runId)) return;
    const json = JSON.stringify(definition);
    const blockExpansions = context.blockExpansions ?? snapshotPipelineBlocks(definition.spec.steps);
    const hash = createHash("sha256").update(JSON.stringify({ spec: definition.spec, blockExpansions })).digest("hex");
    this.db.query(`INSERT OR IGNORE INTO pipeline_run_snapshots VALUES (?, ?, ?, ?)`)
      .run(runId, json, hash, JSON.stringify({ ...context, blockExpansions, viewerDefinition: this.sanitize(definition).value, viewerBlockExpansions: this.sanitize(blockExpansions).value }));
  }

  snapshot(runId: string): { definition: PipelineDefinitionRecord; hash: string; context: PipelineRunContext } | null {
    const row = this.db.query(`SELECT * FROM pipeline_run_snapshots WHERE run_id = ?`).get(runId) as
      { definition_json: string; definition_hash: string; context_json: string } | null;
    return row ? { definition: JSON.parse(row.definition_json), hash: row.definition_hash, context: JSON.parse(row.context_json) } : null;
  }

  link(input: ChildRunLink): void {
    this.db.query(`INSERT INTO pipeline_child_runs VALUES (?, ?, ?, ?)`)
      .run(input.parentStepId, input.parentRunId, input.childRunId, input.deadline);
  }

  child(parentStepId: string): ChildRunLink | null {
    return this.map(this.db.query(`SELECT * FROM pipeline_child_runs WHERE parent_step_id = ?`).get(parentStepId));
  }

  parent(childRunId: string): ChildRunLink | null {
    return this.map(this.db.query(`SELECT * FROM pipeline_child_runs WHERE child_run_id = ?`).get(childRunId));
  }

  children(parentRunId: string): ChildRunLink[] {
    return this.db.query(`SELECT * FROM pipeline_child_runs WHERE parent_run_id = ?`).all(parentRunId)
      .map(row => this.map(row)!);
  }

  tree(runId: string): string[] {
    return [runId, ...this.children(runId).flatMap(link => this.tree(link.childRunId))];
  }

  private map(value: unknown): ChildRunLink | null {
    const row = value as Record<string, unknown> | null;
    return row ? { parentRunId: String(row.parent_run_id), parentStepId: String(row.parent_step_id),
      childRunId: String(row.child_run_id), deadline: Number(row.deadline) } : null;
  }
}
