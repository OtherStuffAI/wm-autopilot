import type { Database } from "bun:sqlite";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import type { PipelineBlockSnapshots } from "./pipeline-block-snapshot";
import type { PipelineRunContext } from "./pipeline-composition-store";

type Sanitize = (value: unknown) => { value: unknown; redacted?: boolean };

/** Pinned execution data stays exact; only the outward copies use trusted invocation credentials. */
export function captureViewerPin(db: Database, runId: string, definition: PipelineDefinitionRecord, blockExpansions: PipelineBlockSnapshots, sanitize: Sanitize) {
  const run = db.query("SELECT input_json FROM pipeline_runs WHERE id = ?").get(runId) as { input_json: string } | null;
  if (!run) throw new Error("Missing run authority for viewer definition capture");
  return sanitizeViewerProjection(definition, blockExpansions, JSON.parse(run.input_json), sanitize);
}

/** Monotonic viewer-only refinement when execution discovers a new credential, inside capture's transaction. */
export function refineCapturedViewerPins(db: Database, runId: string, rootId: string, value: unknown, sanitize: Sanitize): void {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_run_snapshots'").get()) return;
  let current = runId;
  while (true) {
    const row = db.query("SELECT definition_json, context_json FROM pipeline_run_snapshots WHERE run_id = ?").get(current) as
      { definition_json: string; context_json: string } | null;
    if (row) {
      const context = JSON.parse(row.context_json) as PipelineRunContext;
      if (context.viewerRedacted && !context.viewerDefinition) throw new Error("Missing retained sanitized viewer definition provenance");
      const safe = sanitizeViewerProjection(context.viewerDefinition ?? JSON.parse(row.definition_json),
        context.viewerBlockExpansions ?? context.blockExpansions ?? {}, value, sanitize);
      const next = JSON.stringify({ ...context, ...safe, viewerRedacted: context.viewerRedacted || safe.viewerRedacted });
      if (next !== row.context_json) db.query("UPDATE pipeline_run_snapshots SET context_json = ? WHERE run_id = ?").run(next, current);
    }
    if (current === rootId) break;
    // Capture already verified this durable chain's owner/alias/step authority through payloads.root().
    const parent = db.query("SELECT parent_run_id FROM pipeline_child_runs WHERE child_run_id = ?").get(current) as { parent_run_id: string } | null;
    if (!parent) throw new Error("Missing validated viewer capture ancestry");
    current = parent.parent_run_id;
  }
}

function sanitizeViewerProjection(definition: PipelineDefinitionRecord, blockExpansions: PipelineBlockSnapshots, value: unknown, sanitize: Sanitize) {
  const sanitized = sanitize({ definition, blockExpansions, value });
  const safe = sanitized.value as { definition: PipelineDefinitionRecord; blockExpansions: PipelineBlockSnapshots };
  return { viewerDefinition: safe.definition, viewerBlockExpansions: safe.blockExpansions,
    viewerRedacted: JSON.stringify(definition) !== JSON.stringify(safe.definition) || JSON.stringify(blockExpansions) !== JSON.stringify(safe.blockExpansions) };
}
