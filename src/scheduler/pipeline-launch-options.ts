import type { JsonObject } from "../pipelines/pipeline-store";
import type { ScheduledJob } from "./scheduler-store";

/** The saved trigger identity takes precedence over pipeline input bindings. */
export function scheduledPipelineLaunchOptions(job: ScheduledJob, defaultInput: JsonObject, input: JsonObject) {
  if (!job.botNpub) throw new Error("Scheduled pipeline has no Run as identity selected");
  const merged: JsonObject = { ...defaultInput };
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return {
    input: merged,
    initiatingAgentNpub: job.botNpub,
    // Resolve the profile from this exact npub; a stale profile id could follow a key rotation.
  };
}
