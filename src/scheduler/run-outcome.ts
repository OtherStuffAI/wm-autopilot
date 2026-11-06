import type { ScheduledJobRun } from "./scheduler-store";

/** Historical session success rows certified only launch. Never infer delivery from prose. */
export function describeSchedulerRun(run: Pick<ScheduledJobRun, "status" | "sessionId" | "pipelineRunId">) {
  if (run.status === "launched" || (run.status === "success" && run.sessionId)) {
    return {
      statusLabel: run.status === "success" ? "Launched (legacy)" : "Launched",
      statusDetail: "Session created and prompt queued. Runtime completion and delivery are unverified.",
      deliveryStatus: "unverified" as const,
    };
  }
  if (run.status === "success") return {
    statusLabel: "Runtime complete",
    statusDetail: run.pipelineRunId ? "Pipeline completed. External delivery is unverified." : "Cleanup completed.",
    deliveryStatus: run.pipelineRunId ? "unverified" as const : "not_applicable" as const,
  };
  return {
    statusLabel: run.status === "error" ? "Error" : "Starting",
    statusDetail: run.status === "error" ? "Execution failed; inspect the recorded error." : "Launch is in progress.",
    deliveryStatus: "unverified" as const,
  };
}
