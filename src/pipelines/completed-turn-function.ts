import type { SessionApiContext } from "../server/session-api-routes.ts";
import { parseCompletedTurnRequest } from "../sessions/completed-turn-contract.ts";
import { createCompletedTurnRuntime } from "../sessions/completed-turn-runtime.ts";
import { executeCompletedTurn } from "../sessions/completed-turn-service.ts";
import { createIsolatedCompletedTurnRuntime, isolatedTurnConfiguration } from "../sessions/isolated-completed-turn-runtime.ts";
import type { JsonObject, PipelineStore } from "./pipeline-store.ts";

export const completedTurnFunctionName = "session.completedTurn";

export async function executeCompletedTurnFunction(input: {
  store: PipelineStore; sessionApiContext: SessionApiContext; runId: string; stepId: string;
  ownerNpub: string | null; request: JsonObject;
}): Promise<JsonObject> {
  const request = parseCompletedTurnRequest(input.request);
  const runtime = request.executionProfile === "isolated-codex"
    ? createIsolatedCompletedTurnRuntime(input.store.isolatedTurns, isolatedTurnConfiguration())
    : createCompletedTurnRuntime(input.sessionApiContext);
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
    onSession: (row, sessionId, executionId) => {
      if (sessionId) input.store.setStepSession(row.stepId, sessionId);
      input.store.addEvent({ runId: row.runId, stepId: row.stepId, level: "info", type: "completed_turn_status",
        message: "Native conversation prepared", data: { receiptId: row.receiptId, requestId: row.requestId,
          projectId: row.projectId, executionId, sessionId, status: "preparing", executionProfile: request.executionProfile ?? "codex-sdk" } });
    } });
  if (receipt.sessionId) input.store.setStepSession(input.stepId, receipt.sessionId);
  return { ...receipt, invocationRunId: input.runId, invocationStepId: input.stepId };
}
