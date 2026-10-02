import type { Database } from "bun:sqlite";
import type { PipelineEvidenceStore } from "./pipeline-evidence-store";
import type { PipelineStepSummary } from "./pipeline-store";

/** Full retained inline objects and compacted previews have different provenance. */
export function archiveRetainedInlineEvidence(db: Database, evidence: PipelineEvidenceStore, step: PipelineStepSummary): void {
  const captured = evidence.list(step.runId, step.id);
  const compacted = step.metadata?.compactedDisplay as Record<string, unknown> | undefined;
  if (compacted) {
    for (const [field, kind] of [["in", "resolved_input"], ["out", "returned_output"]] as const) {
      if (captured.some(ref => ref.kind === kind) || !Array.isArray(compacted[field]) || !compacted[field].length) continue;
      const value = Object.fromEntries((compacted[field] as Array<{ name: string; value: unknown }>).map(row => [row.name, row.value]));
      evidence.ensureArchived({ runId: step.runId, stepId: step.id, kind, scope: "legacy_compacted_display_preview",
        value, availability: "preview_only", secrets: [step.callbackToken ?? ""] });
    }
    return;
  }
  const columns = [["input_json", "resolved_input", step.hasInput], ["output_json", "returned_output", step.hasOutput], ["result_json", "state_write", step.hasResult]] as const;
  for (const [column, kind, retained] of columns) {
    if (!retained || captured.some(ref => ref.kind === kind && ref.availability !== "preview_only" && ref.availability !== "not_captured")) continue;
    const row = db.query(`SELECT ${column} AS value FROM pipeline_steps WHERE id = ?`).get(step.id) as { value: string | null };
    if (row.value !== null) evidence.ensureArchived({ runId: step.runId, stepId: step.id, kind,
      scope: "retained_legacy_inline", value: JSON.parse(row.value), secrets: [step.callbackToken ?? ""] });
  }
}
