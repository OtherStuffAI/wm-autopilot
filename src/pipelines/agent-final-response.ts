import type { SessionApiContext } from "../server/session-api-routes.ts";
import type { JsonObject, PipelineStore } from "./pipeline-store.ts";

/** Run after authoritative final sync. Keep callback output and full natural-language answer independently. */
export function retainAgentFinalResponse(ctx: SessionApiContext, sessionId: string, result: JsonObject, evidence?: { store: PipelineStore; runId: string; stepId: string }): JsonObject {
  const messages = ctx.messageStore.listSessionMessages(sessionId);
  const lastUser = messages.findLastIndex(message => message.role === "user");
  const final = lastUser < 0 ? null : messages.slice(lastUser + 1).filter(message => message.role === "agent" || message.role === "assistant").at(-1);
  if (!final) {
    evidence?.store.addEvent({ runId: evidence.runId, stepId: evidence.stepId, level: "warn", type: "agent_final_response_unavailable",
      message: "Full final transcript response is unavailable after completion sync", data: { sessionId } });
    return result;
  }
  return { ...result, finalResponse: final.content };
}
