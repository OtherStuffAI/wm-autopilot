export function formatSchedulerOutcome(payload: Record<string, unknown>): string {
  if (typeof payload.sessionId === "string") return `session ${payload.sessionId}`;
  if (typeof payload.pipelineRunId === "string") return `pipeline run ${payload.pipelineRunId}`;
  if (payload.cleanup !== undefined) return `cleanup ${JSON.stringify(payload.cleanup)}`;
  if (Object.keys(payload).length === 0) return "no work started";
  throw new Error("Unknown scheduler trigger outcome");
}
