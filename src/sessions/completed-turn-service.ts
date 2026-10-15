import type { CompletedTurnReceipt, CompletedTurnRequest } from "./completed-turn-contract.ts";
import { CompletedTurnStore, publicTurnReceipt, type TurnBinding, type TurnRecord } from "./completed-turn-store.ts";

export interface CompletedTurnRuntime {
  abandon?: (row: TurnRecord) => Promise<Record<string,unknown>>;
  authorize: (request: CompletedTurnRequest, owner: string) => Promise<void>;
  prepare: (binding: TurnBinding, request: CompletedTurnRequest, recovering: boolean) => Promise<string | { executionId: string; sessionId: string | null }>;
  ready: (sessionId: string) => Promise<void>;
  checkpoint: (sessionId: string) => Promise<{ nativeSessionId: string | null; count: number }>;
  send: (executionId: string, prompt: string) => Promise<{ reply: string; nativeSessionId: string; output?: Record<string, unknown> }>;
  recover: (row: TurnRecord) => Promise<{ reply: string; nativeSessionId: string; output?: Record<string, unknown> } | null>;
}

// Serializes calls in this host. Durable claims also fence separate clients and restarts.
const conversations = new Map<string, Promise<void>>();

export async function executeCompletedTurn(input: {
  store: CompletedTurnStore;
  storeKey: string;
  runtime: CompletedTurnRuntime;
  owner: string;
  request: CompletedTurnRequest;
  runId: string;
  stepId: string;
  onSession?: (row: TurnRecord, sessionId: string | null, executionId: string) => void;
  onTurn?: (row: TurnRecord) => void;
  onTurnError?: (error: unknown) => void;
}): Promise<CompletedTurnReceipt & { blockedBy?: string }> {
  const { store, runtime, owner, request } = input;
  function observeTurn(row: TurnRecord): void {
    try { input.onTurn?.(row); }
    catch (error) {
      try { input.onTurnError?.(error); } catch { /* Progress evidence must not affect native execution. */ }
    }
  }
  if (!owner) throw new Error("Completed turns require an authenticated pipeline owner");
  await runtime.authorize(request, owner);
  const target = store.enqueue(owner, request, input.runId, input.stepId);
  const lockKey = JSON.stringify([input.storeKey, owner, request.conversationKey]);
  const previous = conversations.get(lockKey) ?? Promise.resolve();
  let unlock!: () => void;
  const held = new Promise<void>((resolve) => { unlock = resolve; });
  const tail = previous.then(() => held);
  conversations.set(lockKey, tail);
  await previous;
  try {
    while (!["completed","abandoned"].includes(store.get(target.receiptId)!.status)) {
      const head = store.head(owner, request.conversationKey)!;
      const recovering = head.status !== "queued";
      const token = crypto.randomUUID();
      if (!store.claim(head.receiptId, token)) {
        return { ...publicTurnReceipt(store.get(target.receiptId)!), blockedBy: head.receiptId };
      }
      let leaseError: Error | null = null;
      const heartbeat = setInterval(() => {
        try { store.renew(head.receiptId, token); }
        catch (error) { leaseError = error instanceof Error ? error : new Error(String(error)); }
      }, 5_000);
      try {
        if (head.status === "sending" || head.status === "uncertain") {
          observeTurn(head);
          const evidence = await runtime.recover(head);
          if (!evidence) throw new Error("Native completed-turn outcome uncertain; no prompt was replayed");
          store.complete(head.receiptId, token, evidence.reply, evidence.nativeSessionId, evidence.output);
        } else {
          const binding = store.binding(owner, request.conversationKey)!;
          // Use the head's immutable launch configuration, even when draining an older request.
          const prepared = await runtime.prepare(binding, JSON.parse(head.requestJson) as CompletedTurnRequest, recovering && !head.executionId);
          const { executionId, sessionId } = typeof prepared === "string" ? { executionId: prepared, sessionId: prepared } : prepared;
          store.bind(head.receiptId, token, executionId, sessionId);
          input.onSession?.(head, sessionId, executionId);
          await runtime.ready(executionId);
          const checkpoint = await runtime.checkpoint(executionId);
          if (leaseError) throw leaseError;
          store.renew(head.receiptId, token);
          store.sending(head.receiptId, token, checkpoint.nativeSessionId, checkpoint.count);
          observeTurn(store.get(head.receiptId)!);
          const completed = await runtime.send(executionId, head.prompt);
          if (leaseError) throw leaseError;
          if (checkpoint.nativeSessionId && completed.nativeSessionId !== checkpoint.nativeSessionId) {
            throw new Error("Native conversation changed during completed turn; continuity lost");
          }
          store.complete(head.receiptId, token, completed.reply, completed.nativeSessionId, completed.output);
        }
      } catch (error) {
        // Persist uncertainty before returning. Neither acceptance nor elapsed time permits replay.
        store.uncertain(head.receiptId, token, error instanceof Error ? error.message : String(error));
        const result = publicTurnReceipt(store.get(target.receiptId)!);
        return head.receiptId === target.receiptId ? result : { ...result, blockedBy: head.receiptId };
      } finally {
        clearInterval(heartbeat);
      }
    }
    return publicTurnReceipt(store.get(target.receiptId)!);
  } finally {
    unlock();
    if (conversations.get(lockKey) === tail) conversations.delete(lockKey);
  }
}
