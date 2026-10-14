import { resolveActivityWebhook, type ActivityWebhookSpec } from "./activity-webhook-contract.ts";
import type { PipelineStore } from "./pipeline-store.ts";
import type { ActivityTurnBinding } from "./activity-webhook-store.ts";

/** Progress configuration/disk failures are observable but never change execution outcomes. */
export function bindActivityWebhook(input: {
  store: PipelineStore; spec?: ActivityWebhookSpec;
  turnId: string; runId: string; stepId: string; sessionId: string | null;
  receiptId: string | null; checkpoint: number; prompt: string;
}): ActivityTurnBinding | null {
  if (input.spec === undefined) return null;
  try {
    const destination = resolveActivityWebhook(input.store, input.runId, input.spec)!;
    const binding: ActivityTurnBinding = { turnId: input.turnId, runId: input.runId, stepId: input.stepId,
      sessionId: input.sessionId, receiptId: input.receiptId, checkpoint: input.checkpoint, prompt: input.prompt, destination };
    input.store.activityWebhooks.bind(binding);
    return binding;
  } catch (error) {
    try {
      input.store.addEvent({ runId: input.runId, stepId: input.stepId, type: "activity_configuration_failed", level: "warn",
        message: error instanceof Error ? error.message : "Activity configuration failed" });
    } catch { /* Even evidence storage failure must not abort the agent. */ }
    return null;
  }
}
