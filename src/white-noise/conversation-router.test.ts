import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "./conversation-store";
import { ConversationRouter } from "./conversation-router";
import { recoverCompletionRecords } from "./codex-completion-recovery";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(f => f()));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wn-route-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const binding = { account: "account", group: "group", sender: "pete", session: "session" };
  const path = join(dir, "state.db"), store = new ConversationStore(path, binding);
  cleanups.push(() => store.close());
  const inbound = { account: "account", group: "group", sender: "pete", id: "11".repeat(32), text: "Hello" };
  return { store, inbound, binding, path };
}
test("authorized binding and durable inbound dedup reject other senders/conversations", () => {
  const s = setup();
  expect(s.store.receive({ ...s.inbound, sender: "other" })).toBe(false);
  expect(s.store.receive({ ...s.inbound, group: "other" })).toBe(false);
  expect(s.store.receive(s.inbound)).toBe(true);
  expect(s.store.receive(s.inbound)).toBe(false);
  expect(() => s.store.receive({ ...s.inbound, text: "changed" })).toThrow("inbound_id_conflict");
  const reopened = new ConversationStore(s.path, s.binding);
  cleanups.push(() => reopened.close());
  expect(reopened.receive(s.inbound)).toBe(false);
  expect(() => new ConversationStore(s.path, { ...s.binding, session: "other" })).toThrow("conversation_binding_mismatch");
});
test("submission is not completion; failed delivery retries stored output without rerunning agent", async () => {
  const s = setup(); s.store.receive(s.inbound);
  let finish!: (text: string) => void, sends = 0, turns = 0;
  const runtime = { completedTurn: async () => { turns++; return await new Promise<string>(resolve => { finish = resolve; }); },
    recoverCompletedTurn: async () => null, sendFinal: async () => { sends++; throw new Error("network"); } };
  const router = new ConversationRouter(s.store, runtime);
  const draining = router.drain();
  await Promise.resolve();
  expect(s.store.pending()[0]!.state).toBe("accepted"); expect(sends).toBe(0);
  finish("Final answer");
  await expect(draining).rejects.toThrow("network");
  expect(s.store.pending()[0]!.reply).toBe("Final answer");
  const reopened = new ConversationStore(s.path, s.binding); cleanups.push(() => reopened.close());
  const sent: unknown[] = [];
  await new ConversationRouter(reopened, { ...runtime, sendFinal: async input => { sent.push(input); } }).drain();
  expect(turns).toBe(1); expect(sent).toEqual([{ id: `wn:${s.inbound.id}`, text: "Final answer", replyTo: s.inbound.id }]);
  expect(reopened.pending()).toEqual([]);
});
test("accepted input recovers only completed correlated output and never silently resubmits", async () => {
  const s = setup(); s.store.receive(s.inbound); s.store.accept(s.inbound.id);
  let submitted = 0;
  const runtime = { completedTurn: async () => { submitted++; return "wrong"; }, recoverCompletedTurn: async () => null, sendFinal: async () => {} };
  await expect(new ConversationRouter(s.store, runtime).drain()).rejects.toThrow("accepted_input_requires_completion_recovery");
  expect(submitted).toBe(0);
  await new ConversationRouter(s.store, { ...runtime, recoverCompletedTurn: async () => "Recovered final" }).drain();
  expect(submitted).toBe(0); expect(s.store.pending()).toEqual([]);
});
test("native recovery ignores commentary and final text until explicit correlated completion", async () => {
  const prompt = "[White Noise input 1]\nHello";
  const records = [
    { type: "event_msg", payload: { type: "user_message", message: prompt } },
    { type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "Thinking" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Answer" } },
  ];
  async function* source(values: typeof records) { yield* values; }
  expect(await recoverCompletionRecords(source(records), prompt)).toBeNull();
  expect(await recoverCompletionRecords(source([...records, { type: "event_msg", payload: { type: "task_complete", last_agent_message: "Answer" } } as any]), prompt)).toBe("Answer");
  expect(await recoverCompletionRecords(source(records), "other")).toBeNull();
});
