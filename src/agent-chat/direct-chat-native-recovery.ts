import type { ProcessManager, SessionSnapshot } from "../agents/process-manager";
import type { SessionDispatchStore } from "../session-dispatch/session-dispatch-store";
import type { PromptQueueStore } from "../storage/prompt-queue-store";
import type { StoredSessionRecord } from "../storage/message-store";
import type { SessionArchiveStore } from "../storage/session-archive-store";
import { resolveSessionOwnerNpub } from "../sessions/session-ownership";
import type { DirectChatTurnRecord, DirectChatTurnStore } from "./direct-chat-turn-store";
import type { ChatInterceptStateStore } from "./chat-intercept-state-store";
import { queueDirectChatStatus } from "./direct-chat-status";

/** Repeated native-resume events repair durable bindings without replaying work. */
export function rebindNativeDirectChatRecovery(target: SessionSnapshot, deps: {
  manager: Pick<ProcessManager, "getSession">;
  archiveStore: Pick<SessionArchiveStore, "getArchivedSession">;
  getStoredSession?: (id: string) => StoredSessionRecord | null;
  dispatchStore: Pick<SessionDispatchStore, "rebindSession">;
  promptQueueStore: Pick<PromptQueueStore, "rebindSession">;
  turnStore: DirectChatTurnStore;
  interceptStore: Pick<ChatInterceptStateStore, "listAll" | "save">;
}): void {
  const sourceId = target.metadata?.resumedFromWingmanSessionId;
  if (!sourceId || sourceId === target.id) return;
  const liveSource = deps.manager.getSession(sourceId);
  // A second view/runtime is not a replacement while the original is live.
  if (liveSource?.status === "running" || liveSource?.status === "starting") return;
  const source = liveSource ?? deps.archiveStore.getArchivedSession(sourceId) ?? deps.getStoredSession?.(sourceId);
  if (!source) throw new Error(`Native recovery source ${sourceId} is unavailable.`);
  const owner = resolveSessionOwnerNpub(source.npub, source.metadata);
  if (!owner || owner !== resolveSessionOwnerNpub(target.npub, target.metadata)) {
    throw new Error("Native recovery cannot transfer work across owners.");
  }
  if (!source.metadata?.nativeAgentSession?.sessionId
    || source.metadata.nativeAgentSession.sessionId !== target.metadata?.nativeAgentSession?.sessionId) {
    throw new Error("Native recovery session identity does not match its source.");
  }
  deps.dispatchStore.rebindSession(sourceId, target.id);
  deps.promptQueueStore.rebindSession(sourceId, target.id);
  for (const intercept of deps.interceptStore.listAll()) {
    if (intercept.sessionId !== sourceId) continue;
    const pending = deps.turnStore.getPending(intercept.routingKey);
    const turn: DirectChatTurnRecord | null = pending?.sessionId === sourceId ? pending
      : deps.turnStore.getInterruptedSessionTurn(sourceId, intercept.routingKey);
    if (turn?.sessionId === sourceId && !turn.publicationPayload) {
      const rebound = deps.turnStore.rebindAcceptedSession(turn.turnId, sourceId, target.id);
      if (rebound) queueDirectChatStatus(deps.turnStore, rebound, "recovery", new Date().toISOString());
    }
    deps.interceptStore.save({ ...intercept, sessionId: target.id, updatedAt: new Date().toISOString() });
  }
}
