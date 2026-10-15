import type { PromptQueueStore } from "../storage/prompt-queue-store";
import type { SessionDispatchStore } from "../session-dispatch/session-dispatch-store";
import type { DirectChatTurnStore } from "./direct-chat-turn-store";
import type { FlightDeckSessionTurnBridge } from "./flightdeck-session-turn-bridge";

/** Capture all stores before retiring any. The saved exact-item vector is also
 * the recovery contract if the process exits between database commits. */
export function createFreshSessionWorkRetirement(deps: {
  turns: DirectChatTurnStore;
  prompts: Pick<PromptQueueStore, "captureFreshHumanCutoff" | "retireForFreshHumanTrigger">;
  callbacks: Pick<SessionDispatchStore, "captureFreshHumanCutoff" | "retireForFreshHumanTrigger">;
  publications?: Pick<FlightDeckSessionTurnBridge, "captureFreshHumanCutoff" | "retireForFreshHumanTrigger">;
}): (sessionId: string, triggerId: string, routingKey: string) => string[] {
  return (sessionId, triggerId, routingKey) => {
    const snapshot = deps.turns.freshSessionSnapshot(sessionId, triggerId, () => ({
      prompts: deps.prompts.captureFreshHumanCutoff(sessionId),
      callbacks: deps.callbacks.captureFreshHumanCutoff(sessionId),
      publications: deps.publications?.captureFreshHumanCutoff(sessionId) ?? [],
      direct: deps.turns.captureFreshHumanCutoff(sessionId, routingKey),
    }));
    deps.prompts.retireForFreshHumanTrigger(sessionId, triggerId, snapshot.prompts);
    deps.callbacks.retireForFreshHumanTrigger(sessionId, triggerId, snapshot.callbacks);
    deps.publications?.retireForFreshHumanTrigger(sessionId, triggerId, snapshot.publications);
    return snapshot.direct;
  };
}
