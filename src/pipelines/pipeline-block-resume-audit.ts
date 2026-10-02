import type { Database } from "bun:sqlite";
import type { DeclarativeStep } from "./declarative";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import type { PipelineBlockSnapshots } from "./pipeline-block-snapshot";

/** Read-only activation inventory. Missing structures are never reconstructed. */
export function auditLegacyBlockResumes(db: Database) {
  const hasSnapshots = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_run_snapshots'").get());
  const rows = db.query(hasSnapshots ? `SELECT r.id, r.status, r.cursor_index, s.definition_json, s.context_json FROM pipeline_runs r
    LEFT JOIN pipeline_run_snapshots s ON s.run_id = r.id WHERE r.status IN ('queued', 'running', 'needs_input')` : `SELECT id, status, cursor_index FROM pipeline_runs WHERE status IN ('queued', 'running', 'needs_input')`).all() as Array<Record<string, unknown>>;
  return rows.flatMap(row => {
    if (!row.definition_json) return [{ runId: String(row.id), status: String(row.status), cursorIndex: Number(row.cursor_index),
      missingSnapshot: true, missingBlockKeys: [] as string[], completedBlockKeys: [] as string[] }];
    const definition = JSON.parse(String(row.definition_json)) as PipelineDefinitionRecord;
    const context = JSON.parse(String(row.context_json)) as { blockExpansions?: PipelineBlockSnapshots };
    const missingBlockKeys: string[] = [];
    function visit(steps: DeclarativeStep[], prefix = "") {
      for (const step of steps) {
        const key = `${prefix}${step.id ?? step.name}`;
        if (step.type === "block") {
          const expansion = context.blockExpansions?.[key];
          if (!expansion) missingBlockKeys.push(key);
          else visit(expansion.steps, `${key}/`);
        } else if (step.type === "loop") visit(step.steps ?? [], `${key}/`);
        else if (step.type === "parallel") visit([step.step], `${key}/`);
      }
    }
    visit(definition.spec.steps);
    if (!missingBlockKeys.length) return [];
    const completed = db.query("SELECT logical_key FROM pipeline_steps WHERE run_id = ? AND kind = 'block' AND status = 'ok' AND result_json IS NOT NULL").all(String(row.id)) as Array<{ logical_key: string | null }>;
    return [{ runId: String(row.id), status: String(row.status), cursorIndex: Number(row.cursor_index), missingSnapshot: false,
      missingBlockKeys, completedBlockKeys: completed.map(step => step.logical_key).filter((key): key is string => Boolean(key)) }];
  });
}
