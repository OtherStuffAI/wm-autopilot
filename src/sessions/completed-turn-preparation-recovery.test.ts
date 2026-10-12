import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { CompletedTurnStore } from "./completed-turn-store.ts";
import { parseCompletedTurnRequest } from "./completed-turn-contract.ts";
function fixture() {
  const db = new Database(":memory:");
  const store = new CompletedTurnStore(db);
  const request = parseCompletedTurnRequest({ conversationKey: "conversation", requestId: "request", projectId: "project", prompt: "Exact prompt\n", directory: "/project" });
  const row = store.enqueue("owner", request, "run", "step");
  store.claim(row.receiptId, "claim");
  store.uncertain(row.receiptId, "claim", "Completed-turn bound session unavailable");
  return { db, store, request, row };
}
test("explicit unavailable preparation recovery preserves immutable prompt, sequence and receipt", () => {
  const f = fixture();
  try {
    f.store.recoverMissingPreparation("owner", f.request);
    const recovered = f.store.request("owner", "request")!;
    expect(recovered).toMatchObject({ receiptId: f.row.receiptId, status: "queued", sequence: 1, prompt: "Exact prompt\n", requestJson: JSON.stringify(f.request) });
    f.store.recoverMissingPreparation("owner", f.request);
    expect(f.store.request("owner", "request")!.sequence).toBe(1);
    expect(() => f.store.recoverMissingPreparation("foreign", f.request)).toThrow();
    expect(() => f.store.recoverMissingPreparation("owner", { ...f.request, prompt: "Changed" })).toThrow();
  } finally { f.db.close(); }
});
test("missing preparation recovery refuses every uncertain launch/send boundary and active claim", () => {
  for (const update of ["status='sending'", "status='uncertain'", "sessionId='child'", "executionId='child'", "checkpoint=0", "nativeSessionId='native'", "claimToken='active'", "leaseUntil=1", "error='Response lost after launch'"]) {
    const f = fixture();
    try {
      f.db.exec(`UPDATE completed_turn_receipts SET ${update}`);
      expect(() => f.store.recoverMissingPreparation("owner", f.request)).toThrow();
    } finally { f.db.close(); }
  }
});
