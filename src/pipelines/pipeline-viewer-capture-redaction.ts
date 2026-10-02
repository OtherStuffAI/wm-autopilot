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
  // Immutable previews may predate discovery. Keep archive truth; refuse the whole
  // composition's outward projection durably rather than rewriting old references.
  const previews = db.query(`WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT child_run_id FROM pipeline_child_runs JOIN family ON parent_run_id = family.id)
    SELECT preview_json FROM pipeline_evidence JOIN family ON run_id = family.id WHERE preview_json IS NOT NULL
    UNION ALL SELECT metadata_json AS preview_json FROM pipeline_steps JOIN family ON run_id = family.id WHERE metadata_json IS NOT NULL`).iterate(rootId) as Iterable<{ preview_json: string }>;
  let unsafe = false;
  for (const row of previews) {
    if (unsafe) continue; // Exhaust SQLite's cursor before later transactional writes.
    const preview = JSON.parse(row.preview_json);
    const safe = sanitize({ preview, value }).value as { preview: unknown };
    if (JSON.stringify(preview) !== JSON.stringify(safe.preview)) unsafe = true;
  }
  if (unsafe && !db.query("SELECT 1 FROM pipeline_run_snapshots WHERE run_id = ?").get(rootId)) {
    throw new Error("Missing durable viewer refusal provenance for unsafe prior evidence");
  }
  let current = runId;
  while (true) {
    const row = db.query("SELECT definition_json, context_json FROM pipeline_run_snapshots WHERE run_id = ?").get(current) as
      { definition_json: string; context_json: string } | null;
    if (row) {
      const context = JSON.parse(row.context_json) as PipelineRunContext;
      if (context.viewerRedacted && !context.viewerDefinition) throw new Error("Missing retained sanitized viewer definition provenance");
      const safe = sanitizeViewerProjection(context.viewerDefinition ?? JSON.parse(row.definition_json),
        context.viewerBlockExpansions ?? context.blockExpansions ?? {}, value, sanitize);
      const next = JSON.stringify({ ...context, ...safe, ...(unsafe ? { viewerEvidenceUnsafe: true } : {}), viewerRedacted: context.viewerRedacted || safe.viewerRedacted });
      if (next !== row.context_json) db.query("UPDATE pipeline_run_snapshots SET context_json = ? WHERE run_id = ?").run(next, current);
    }
    if (current === rootId) break;
    // Capture already verified this durable chain's owner/alias/step authority through payloads.root().
    const parent = db.query("SELECT parent_run_id FROM pipeline_child_runs WHERE child_run_id = ?").get(current) as { parent_run_id: string } | null;
    if (!parent) throw new Error("Missing validated viewer capture ancestry");
    current = parent.parent_run_id;
  }
}

/** Viewer-only guard; execution/archive consumers retain exact immutable evidence. */
export function assertViewerEvidenceSafe(db: Database, runId: string): void {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_run_snapshots'").get()) return;
  const rows = db.query(`WITH RECURSIVE ancestors(id) AS (SELECT ? UNION SELECT parent_run_id FROM pipeline_child_runs JOIN ancestors ON child_run_id = ancestors.id)
    SELECT context_json FROM pipeline_run_snapshots JOIN ancestors ON run_id = ancestors.id`).all(runId) as Array<{ context_json: string }>;
  if (rows.some(row => (JSON.parse(row.context_json) as PipelineRunContext).viewerEvidenceUnsafe)) {
    throw new Error("pipeline-viewer-evidence-redaction-review-required");
  }
}

function sanitizeViewerProjection(definition: PipelineDefinitionRecord, blockExpansions: PipelineBlockSnapshots, value: unknown, sanitize: Sanitize) {
  const sanitized = sanitize({ definition, blockExpansions, value });
  const safe = sanitized.value as { definition: PipelineDefinitionRecord; blockExpansions: PipelineBlockSnapshots };
  return { viewerDefinition: safe.definition, viewerBlockExpansions: safe.blockExpansions,
    viewerRedacted: JSON.stringify(definition) !== JSON.stringify(safe.definition) || JSON.stringify(blockExpansions) !== JSON.stringify(safe.blockExpansions) };
}
