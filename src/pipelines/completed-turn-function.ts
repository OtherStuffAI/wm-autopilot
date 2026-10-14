import { abandonCompletedTurn } from '../sessions/completed-turn-abandonment.ts';
import type { SessionApiContext } from "../server/session-api-routes.ts";
import { parseCompletedTurnRequest } from "../sessions/completed-turn-contract.ts";
import { createCompletedTurnRuntime } from "../sessions/completed-turn-runtime.ts";
import { executeCompletedTurn } from "../sessions/completed-turn-service.ts";
import { createIsolatedCompletedTurnRuntime, isolatedTurnConfiguration } from "../sessions/isolated-completed-turn-runtime.ts";
import type { JsonObject, PipelineStore } from "./pipeline-store.ts";
import { resolveActivityWebhook, type ActivityWebhookSpec } from "./activity-webhook-contract.ts";
import { bindActivityWebhook } from "./activity-webhook-binding.ts";

export const completedTurnFunctionName = "session.completedTurn";

export async function executeCompletedTurnFunction(input: {
  store: PipelineStore; sessionApiContext: SessionApiContext; runId: string; stepId: string;
  ownerNpub: string | null; request: JsonObject;
  activityWebhook?: ActivityWebhookSpec;
}): Promise<JsonObject> {
  const request = parseCompletedTurnRequest(input.request);
  // Reject inconsistent declared configuration before prepare/send; transport failures remain independent.
  resolveActivityWebhook(input.store, input.runId, input.activityWebhook);
  const runtime = request.executionProfile === "isolated-codex"
    ? createIsolatedCompletedTurnRuntime(input.store.isolatedTurns, isolatedTurnConfiguration())
    : createCompletedTurnRuntime(input.sessionApiContext,{projectTools:!!input.store.getStep(input.stepId)?.metadata?.agentTools});
  if(input.request.abandonUncertain===true){
    const receipt=await abandonCompletedTurn({owner:input.ownerNpub??'',request,store:input.store.completedTurns,runtime});
    input.store.addEvent({runId:input.runId,stepId:input.stepId,level:'info',type:'completed_turn_abandoned',message:'Dedicated builder stopped; saved history preserved',data:{receiptId:receipt.receiptId,status:receipt.status}});
    return {...receipt,invocationRunId:input.runId,invocationStepId:input.stepId};
  }
  if(input.request.abandonUncertain!==undefined && input.request.abandonUncertain!==false)throw Error('Invalid abandonment flag');
  if (input.request.recoverPreparation === true) {
    if (request.executionProfile) throw new Error("Trusted native preparation recovery required");
    const row = input.store.completedTurns.request(input.ownerNpub ?? "", request.requestId);
    const binding = input.store.completedTurns.binding(input.ownerNpub ?? "", request.conversationKey);
    if (!row || !binding?.sessionId) throw new Error("Preparation recovery binding unavailable");
    // The archived/live source must still match the owner, directory and dedicated binding.
    await runtime.authorize({ ...request, sessionId: binding.sessionId }, input.ownerNpub ?? "");
    input.store.completedTurns.recoverMissingPreparation(input.ownerNpub ?? "", request);
    input.store.addEvent({ runId: input.runId, stepId: input.stepId, level: "info", type: "completed_turn_preparation_recovered",
      message: "Explicitly recovered source lookup failure before native launch or send",
      data: { receiptId: row.receiptId, requestId: request.requestId, projectId: request.projectId } });
  } else if (input.request.recoverPreparation !== undefined && input.request.recoverPreparation !== false) {
    throw new Error("Invalid preparation recovery flag");
  }
  const receipt = await executeCompletedTurn({ store: input.store.completedTurns, storeKey: input.store.path,
    runtime, owner: input.ownerNpub ?? "", request, runId: input.runId, stepId: input.stepId,
    onTurn: (row) => {
      // Draining an older queued request must never borrow this invocation's destination/correlation.
      if (row.requestId !== request.requestId) return;
      const originalSpec = input.store.getStep(row.stepId)?.metadata?.activityWebhook as ActivityWebhookSpec | undefined;
      bindActivityWebhook({ store: input.store, spec: originalSpec, turnId: row.receiptId,
        runId: row.runId, stepId: row.stepId, sessionId: row.sessionId, receiptId: row.receiptId,
        checkpoint: row.checkpoint!, prompt: row.prompt });
    },
    onTurnError: () => {
      input.store.addEvent({ runId: input.runId, stepId: input.stepId, level: "warn", type: "activity_binding_failed",
        message: "Activity binding failed; native execution continues independently" });
    },
    onSession: (row, sessionId, executionId) => {
      if (sessionId) input.store.setStepSession(row.stepId, sessionId);
      input.store.addEvent({ runId: row.runId, stepId: row.stepId, level: "info", type: "completed_turn_status",
        message: "Native conversation prepared", data: { receiptId: row.receiptId, requestId: row.requestId,
          projectId: row.projectId, executionId, sessionId, status: "preparing", executionProfile: request.executionProfile ?? "codex-sdk" } });
    } });
  if (receipt.sessionId) input.store.setStepSession(input.stepId, receipt.sessionId);
  return { ...receipt, invocationRunId: input.runId, invocationStepId: input.stepId };
}
