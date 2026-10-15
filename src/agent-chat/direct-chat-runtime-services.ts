import { createFreshSessionWorkRetirement } from "./fresh-session-work-retirement";
import { getDirectChatTurnStore } from "./direct-chat-turn-store";
import { AgentDirectDeliveryReconciler } from "./direct-chat-delivery-reconciler";
import { AgentChatSessionRuntime } from "./session-runtime";
import { createArchivedDirectChatFinalReader } from "./direct-chat-archive-response";
import type { SessionDispatchStore } from "../session-dispatch/session-dispatch-store";
import type { PromptQueueStore } from "../storage/prompt-queue-store";
import type { SessionArchiveStore } from "../storage/session-archive-store";

export function createDirectChatRuntimeServices(deps: {
  delivery: ConstructorParameters<typeof AgentDirectDeliveryReconciler>[0];
  runtime: ConstructorParameters<typeof AgentChatSessionRuntime>[0];
  sessionDispatchStore: Pick<SessionDispatchStore, "rebindSession" | "retireForFreshHumanTrigger" | "captureFreshHumanCutoff">;
  promptQueueStore: Pick<PromptQueueStore, "rebindSession" | "retireForFreshHumanTrigger" | "captureFreshHumanCutoff">;
  archiveStore: Pick<SessionArchiveStore, "getArchivedSession" | "getArchivedMessages">;
}) {
  const deliveryReconciler = new AgentDirectDeliveryReconciler({ ...deps.delivery,
    readArchivedFinal: createArchivedDirectChatFinalReader(deps.archiveStore, deps.delivery.manager) });
  const sessionRuntime = new AgentChatSessionRuntime({ ...deps.runtime, directDeliveryReconciler: deliveryReconciler,
    retireSessionWork: createFreshSessionWorkRetirement({ turns: deps.delivery.store ?? getDirectChatTurnStore(),
      prompts: deps.promptQueueStore, callbacks: deps.sessionDispatchStore, publications: deps.runtime.turnBridge }),
    rebindSession: (sourceSessionId, targetSessionId) => {
      deps.sessionDispatchStore.rebindSession(sourceSessionId, targetSessionId);
      deps.promptQueueStore.rebindSession(sourceSessionId, targetSessionId);
    } });
  return { deliveryReconciler, sessionRuntime };
}
