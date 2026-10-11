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
