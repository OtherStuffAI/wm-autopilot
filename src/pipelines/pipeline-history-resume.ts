import type { PipelineRunRecord, PipelineStore } from "./pipeline-store";

export const MISSING_PIPELINE_HISTORY_REASON = "Historical pipeline definition snapshot was not captured. Operator review is required before new execution.";

export function blockMissingPipelineHistory(store: PipelineStore, run: PipelineRunRecord): PipelineRunRecord {
  store.addEvent({ runId: run.id, level: "error", type: "historical_resume_blocked", message: MISSING_PIPELINE_HISTORY_REASON });
  return store.completeRun(run.id, "error", run.current, MISSING_PIPELINE_HISTORY_REASON);
}
