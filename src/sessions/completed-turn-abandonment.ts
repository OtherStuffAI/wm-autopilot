import type { CompletedTurnRuntime } from "./completed-turn-service.ts";
import { publicTurnReceipt, type CompletedTurnStore } from "./completed-turn-store.ts";
import type { CompletedTurnRequest } from "./completed-turn-contract.ts";
/** Authenticated owner and exact immutable request, never caller-selected sessions.
 * A durable claim prevents racing an active execution or another stop attempt. */
export async function abandonCompletedTurn(input: {
  owner: string;
  request: CompletedTurnRequest;
  store: CompletedTurnStore;
  runtime: CompletedTurnRuntime;
}) {
  const { owner, request, store, runtime } = input;
  if (!owner || request.executionProfile || !runtime.abandon) throw Error("Dedicated native abandonment required");
  const row = store.request(owner, request.requestId);
  if (!row || row.requestJson !== JSON.stringify(request)) throw Error("Abandonment request binding denied");
  await runtime.authorize({ ...request, sessionId: row.sessionId }, owner);
  if (row.status === "completed" || row.status === "abandoned") return publicTurnReceipt(row);
  if (store.head(owner, request.conversationKey)?.receiptId !== row.receiptId || !row.sessionId)
    throw Error("Failed head turn required for abandonment");
  const token = crypto.randomUUID();
  if (!store.claimAbandonment(row.receiptId, token))
    throw Error("Completed-turn delivery remains active; abandonment refused");
  let leaseError: unknown;
  const heartbeat = setInterval(() => {
    try {
      store.renew(row.receiptId, token);
    } catch (error) {
      leaseError = error;
    }
  }, 5000);
  try {
    const evidence = await runtime.abandon(row);
    if (leaseError) throw leaseError;
    store.renew(row.receiptId, token);
    store.abandon(row.receiptId, token, evidence);
    return publicTurnReceipt(store.get(row.receiptId)!);
  } catch (error) {
    store.uncertain(row.receiptId, token, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
