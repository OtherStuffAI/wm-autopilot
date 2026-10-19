import type { ProcessManager } from "../agents/process-manager";
import type { ChatInterceptStateStore } from "./chat-intercept-state-store";
import type { DirectChatTurnStore } from "./direct-chat-turn-store";
import type { ChatInterceptStateRecord } from "./types";

export const ACCEPTED_TURN_INTERRUPTED = "accepted_turn_interrupted";

function hasInterruptedTurn(
  intercept: ChatInterceptStateRecord,
  turnStore: Pick<DirectChatTurnStore, "getPending">,
): boolean {
  return intercept.lastDecision === "failed"
    || turnStore.getPending(intercept.routingKey)?.lastErrorClass === ACCEPTED_TURN_INTERRUPTED;
}

/** Runs synchronously before session creation, activity publication or prompt submission.
 * A persisted pending transition joins concurrent human arrivals to the same cutoff. */
export function prepareFreshHumanSession(deps: {
  manager: Pick<ProcessManager, "getSession">;
  interceptStore: ChatInterceptStateStore;
  turnStore: DirectChatTurnStore;
  retireSessionWork?: (sessionId: string, triggerId: string, routingKey: string) => string[] | void;
}, intercept: ChatInterceptStateRecord, triggerId: string, idleConfirmed = false): void {
  const sourceId = intercept.sessionId ?? deps.turnStore.getPending(intercept.routingKey)?.sessionId;
  if (!sourceId) return;
  const session = deps.manager.getSession(sourceId);
  const interrupted = hasInterruptedTurn(intercept, deps.turnStore);
  if (session?.status === "starting") return;
  if (!interrupted && session?.status === "running" && (!idleConfirmed || session.agentRuntimeStatus === "running")) return;
  const boundaryId = intercept.state === "pending" && !interrupted && intercept.freshStartMessageId
    ? intercept.freshStartMessageId : triggerId;
  // Persist intent before touching separate stores, so recovery completes the
  // same vector of cutoffs after a crash rather than capturing wider cutoffs.
  if (boundaryId === triggerId && intercept.freshStartMessageId !== boundaryId) {
    deps.interceptStore.save({ ...intercept, freshStartMessageId: boundaryId,
      state: "pending", lastDecision: interrupted ? "failed" : "pending",
      pendingMessageCount: Math.max(1, intercept.pendingMessageCount), updatedAt: new Date().toISOString() });
  }
  // Each store captures its own durable exact row cutoff, with no await between
  // stores. A retry of this trigger never widens any already captured cutoff.
  const snapshot = deps.retireSessionWork?.(sourceId, boundaryId, intercept.routingKey);
  deps.turnStore.retireForFreshHumanTrigger(sourceId, boundaryId, intercept.routingKey, snapshot || undefined);
}

/** The old thread stays context; only messages at/after the fresh trigger are instructions. */
export function afterFreshHumanBoundary<T extends { messageId: string }>(history: T[], delta: T[], intercept: ChatInterceptStateRecord): T[] {
  if (!intercept.freshStartMessageId) return delta;
  const floor = history.findIndex(message => message.messageId === intercept.freshStartMessageId);
  if (floor < 0) throw new Error(`Fresh human trigger ${intercept.freshStartMessageId} is missing from thread history`);
  const eligible = new Set(history.slice(floor).map(message => message.messageId));
  return delta.filter(message => eligible.has(message.messageId));
}

export function assertCurrentHumanTurn(store: DirectChatTurnStore, turnId: string): void {
  if (store.get(turnId)?.lastErrorClass === "fresh_human_supersession") {
    throw new Error("Turn superseded by fresh human trigger");
  }
}

/** A live process can still be an inactive chat. Confirm through the adapter,
 * then recheck durable chat/runtime state after the await before clearing. */
export async function prepareFreshHumanIntake(
  deps: Parameters<typeof prepareFreshHumanSession>[0] & { manager: Pick<ProcessManager, "getSession" | "getAdapter"> },
  intercept: ChatInterceptStateRecord,
  triggerId: string,
): Promise<void> {
  const sourceId = intercept.sessionId ?? deps.turnStore.getPending(intercept.routingKey)?.sessionId;
  const session = sourceId ? deps.manager.getSession(sourceId) : null;
  if (hasInterruptedTurn(intercept, deps.turnStore)) {
    prepareFreshHumanSession(deps, intercept, triggerId);
    return;
  }
  if (session?.status !== "running") {
    prepareFreshHumanSession(deps, intercept, triggerId);
    return;
  }
  if (intercept.state !== "idle" || session.agentRuntimeStatus === "running") return;
  const adapter = deps.manager.getAdapter(session.id);
  if (!adapter) throw new Error(`Idle chat session ${session.id} has no adapter to confirm inactivity`);
  const ready = adapter.getPromptReadiness
    ? (await adapter.getPromptReadiness(750)).state === "ready"
    : await adapter.fetchStatus(750) === "stable";
  if (!ready) return;
  const latest = deps.interceptStore.getByRoutingKey(intercept.routingKey);
  if (!latest || latest.sessionId !== session.id || deps.manager.getAdapter(session.id) !== adapter) return;
  if (latest.state !== "idle" && !(latest.state === "pending" && latest.freshStartMessageId)) return;
  prepareFreshHumanSession(deps, latest, triggerId, true);
}

/** Concurrent human arrivals share the earliest intake's readiness/cutoff. */
export class FreshHumanIntakeCoordinator {
  private readonly pending = new Map<string, Promise<void>>();

  prepare(...args: Parameters<typeof prepareFreshHumanIntake>): Promise<void> {
    const routingKey = args[1].routingKey;
    const existing = this.pending.get(routingKey);
    if (existing) return existing;
    const work = prepareFreshHumanIntake(...args).finally(() => {
      if (this.pending.get(routingKey) === work) this.pending.delete(routingKey);
    });
    this.pending.set(routingKey, work);
    return work;
  }
}
