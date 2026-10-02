import type { JsonObject } from "./pipeline-store";

/** Store explicit domain verdicts in summaries, independent of large lazy payloads. */
export function pipelineControlFlow(output: JsonObject | null | undefined): JsonObject | null {
  if (!output) return null;
  const nested = output.current as JsonObject | undefined;
  const candidate = (output.retrieval ?? nested?.retrieval ?? output) as JsonObject;
  if (typeof candidate.verdict !== "string" || typeof candidate.reason !== "string") return null;
  return { verdict: candidate.verdict, reason: candidate.reason, attempt: candidate.attempt ?? null,
    continuationReason: candidate.verdict === "running" ? candidate.reason || null : null,
    exitReason: candidate.verdict !== "running" ? candidate.reason || null : null };
}
