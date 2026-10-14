import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletedTurnStore } from "./completed-turn-store.ts";
import { executeCompletedTurn, type CompletedTurnRuntime } from "./completed-turn-service.ts";
import { parseCompletedTurnRequest } from "./completed-turn-contract.ts";
import { NativeTurnRecovery } from "./completed-turn-recovery.ts";

let directory: string;
let db: Database;
let store: CompletedTurnStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "completed-turn-"));
  db = new Database(join(directory, "turns.sqlite"));
  db.exec("PRAGMA journal_mode=WAL");
  store = new CompletedTurnStore(db);
});
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
const request = (id = "one", prompt = "  exact\nprompt  ") => parseCompletedTurnRequest({
  conversationKey: "conversation", requestId: id, projectId: "project", directory: "/project", prompt,
});
function fakeRuntime() {
  const prompts: string[] = [];
  let launches = 0;
  const runtime: CompletedTurnRuntime = {
    authorize: async () => {},
    prepare: async (binding) => { if (!binding.sessionId) launches++; return binding.sessionId ?? "session"; },
    ready: async () => {}, checkpoint: async () => ({ nativeSessionId: "native", count: prompts.length }),
    send: async (_id, prompt) => { prompts.push(prompt); return { reply: `reply ${prompts.length}`, nativeSessionId: "native" }; },
    recover: async () => null,
  };
  return { runtime, prompts, launches: () => launches };
}
function execute(runtime: CompletedTurnRuntime, id = "one", prompt?: string) {
  return executeCompletedTurn({ store, storeKey: directory, runtime, owner: "owner", request: request(id, prompt), runId: `run-${id}`, stepId: `step-${id}` });
}

test("simultaneous first requests launch once, preserve exact prompts and await FIFO completion", async () => {
  const fake = fakeRuntime();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = fake.runtime.send;
  fake.runtime.send = async (id, prompt) => { if (!fake.prompts.length) await gate; return send(id, prompt); };
  const first = execute(fake.runtime);
  const second = execute(fake.runtime, "two", "second");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(store.head("owner", "conversation")?.status).toBe("sending");
  expect(fake.prompts).toEqual([]);
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toMatchObject({ status: "completed", sessionId: "session", nativeSessionId: "native", sequence: 1, requestId: "one", projectId: "project", runId: "run-one" });
  expect(b).toMatchObject({ status: "completed", sessionId: "session", nativeSessionId: "native", sequence: 2 });
  expect(fake.launches()).toBe(1);
  expect(fake.prompts).toEqual(["  exact\nprompt  ", "second"]);
});

test("identical parallel and reopened retries return durable receipt without replay", async () => {
  const fake = fakeRuntime();
  const [a, b] = await Promise.all([execute(fake.runtime), execute(fake.runtime)]);
  expect(a).toEqual(b);
  const reopened = new Database(join(directory, "turns.sqlite"));
  try {
    const retry = await executeCompletedTurn({ store: new CompletedTurnStore(reopened), storeKey: directory,
      runtime: fake.runtime, owner: "owner", request: request(), runId: "new-run", stepId: "new-step" });
    expect(retry).toEqual(a);
    expect(fake.prompts).toHaveLength(1);
  } finally { reopened.close(); }
  await expect(execute(fake.runtime, "one", "changed")).rejects.toThrow("idempotency conflict");
  await expect(executeCompletedTurn({ store, storeKey: directory, runtime: fake.runtime, owner: "owner",
    request: { ...request("two"), directory: "/other" }, runId: "r", stepId: "s" })).rejects.toThrow("binding conflict");
});

test("busy pre-send retry retains head and cannot let newer prompt overtake", async () => {
  const fake = fakeRuntime();
  let busy = true;
  fake.runtime.ready = async () => { if (busy) throw new Error("busy"); };
  expect(await execute(fake.runtime)).toMatchObject({ status: "preparing", error: "busy" });
  expect(await execute(fake.runtime, "two")).toMatchObject({ status: "queued", blockedBy: expect.any(String) });
  expect(fake.prompts).toHaveLength(0);
  busy = false;
  expect(await execute(fake.runtime, "two")).toMatchObject({ status: "completed", sequence: 2 });
  expect(fake.prompts).toHaveLength(2);
  expect(fake.launches()).toBe(1);
});

test("uncertain send fences successors and recovers native completion without redelivery", async () => {
  const fake = fakeRuntime();
  fake.runtime.send = async (_id, prompt) => { fake.prompts.push(prompt); throw new Error("lost response"); };
  const first = await execute(fake.runtime);
  expect(first).toMatchObject({ status: "uncertain", reply: null, error: "lost response" });
  const second = await execute(fake.runtime, "two", "later");
  expect(second).toMatchObject({ status: "queued", blockedBy: first.receiptId });
  expect(fake.prompts).toHaveLength(1);
  fake.runtime.recover = async (row) => {
    expect(row).toMatchObject({ checkpoint: 0, prompt: "  exact\nprompt  ", nativeSessionId: "native" });
    return { reply: "recovered", nativeSessionId: "native" };
  };
  expect(await execute(fake.runtime)).toMatchObject({ status: "completed", reply: "recovered", receiptId: first.receiptId });
  expect(fake.prompts).toHaveLength(1);
});

test("durable active lease denies second executor; expired lease fences stale mutation", () => {
  const row = store.enqueue("owner", request(), "r", "s");
  expect(store.claim(row.receiptId, "first", 100)).toBe(true);
  const secondDb = new Database(join(directory, "turns.sqlite"));
  const secondStore = new CompletedTurnStore(secondDb);
  expect(secondStore.claim(row.receiptId, "second", 100)).toBe(false);
  store.bind(row.receiptId, "first", "session");
  store.sending(row.receiptId, "first", "native", 0);
  expect(secondStore.claim(row.receiptId, "second", 30100)).toBe(true);
  expect(() => store.complete(row.receiptId, "first", "old", "native")).toThrow("claim changed");
  store.complete(row.receiptId, "second", "recovered", "native");
  expect(store.get(row.receiptId)?.reply).toBe("recovered");
  secondDb.close();
});

test("stale sending survives database reopen and is never automatically resent", async () => {
  const row = store.enqueue("owner", request(), "r", "s");
  store.claim(row.receiptId, "dead-host", 1);
  store.bind(row.receiptId, "dead-host", "session");
  store.sending(row.receiptId, "dead-host", "native", 0);
  const fake = fakeRuntime();
  expect(await execute(fake.runtime)).toMatchObject({ status: "uncertain", receiptId: row.receiptId });
  expect(fake.launches()).toBe(0);
  expect(fake.prompts).toHaveLength(0);
});

test("ownership authorization fails before any binding or receipt mutation", async () => {
  const fake = fakeRuntime();
  fake.runtime.authorize = async () => { throw new Error("ownership denied"); };
  await expect(execute(fake.runtime)).rejects.toThrow("ownership denied");
  expect(store.binding("owner", "conversation")).toBeNull();
  expect(fake.launches()).toBe(0);
});

test("contract refuses unsupported profiles and preserves prompt whitespace", () => {
  expect(request().prompt).toBe("  exact\nprompt  ");
  expect(() => parseCompletedTurnRequest({ ...request(), executionProfile: "builder" })).toThrow("gated");
  expect(() => parseCompletedTurnRequest({ ...request(), directory: "relative" })).toThrow("absolute");
});

test("stale supplied session cannot replace a durable current binding", () => {
  const first = store.enqueue("owner", request(), "r", "s");
  store.claim(first.receiptId, "token");
  store.bind(first.receiptId, "token", "current");
  expect(() => store.enqueue("owner", { ...request("two"), sessionId: "stale" }, "r2", "s2")).toThrow("stale session binding");
  expect(store.binding("owner", "conversation")?.sessionId).toBe("current");
});

test("uncertain launch recovery cannot silently create another session", async () => {
  const first = store.enqueue("owner", request(), "r", "s");
  store.claim(first.receiptId, "dead-host", 1);
  const fake = fakeRuntime();
  fake.runtime.prepare = async (binding, _request, recovering) => {
    expect(binding.sessionId).toBeNull();
    expect(recovering).toBe(true);
    throw new Error("launch outcome uncertain");
  };
  expect(await execute(fake.runtime)).toMatchObject({ status: "preparing", error: "launch outcome uncertain" });
  expect(fake.prompts).toHaveLength(0);
  expect(fake.launches()).toBe(0);
});

test("provider conversation change is fenced rather than claiming native continuity", async () => {
  const fake = fakeRuntime();
  fake.runtime.send = async () => ({ reply: "new conversation", nativeSessionId: "replacement" });
  expect(await execute(fake.runtime)).toMatchObject({ status: "uncertain", reply: null, error: expect.stringContaining("continuity lost") });
});

function event(type: string, payload: Record<string, unknown>) { return { type, payload }; }
test("native recovery distinguishes repeated exact prompts using checkpoint and task_complete", () => {
  const recovery = new NativeTurnRecovery(1, "same");
  for (const record of [
    event("event_msg", { type: "user_message", message: "same" }),
    event("event_msg", { type: "agent_message", phase: "final_answer", message: "old" }),
    event("event_msg", { type: "task_complete", last_agent_message: "old" }),
    event("event_msg", { type: "user_message", message: "same" }),
    event("event_msg", { type: "agent_message", phase: "commentary", message: "private" }),
    event("event_msg", { type: "agent_message", phase: "final_answer", message: "new" }),
  ]) recovery.visit(record);
  expect(recovery.reply).toBeNull();
  recovery.visit(event("event_msg", { type: "task_complete", last_agent_message: "new" }));
  expect(recovery.reply).toBe("new");
});

test("native recovery rejects intervening prompt, failed completion and mismatch", () => {
  const changed = new NativeTurnRecovery(0, "exact");
  expect(() => changed.visit(event("event_msg", { type: "user_message", message: "other" }))).toThrow("checkpoint");
  const failed = new NativeTurnRecovery(0, "exact");
  failed.visit(event("event_msg", { type: "user_message", message: "exact" }));
  failed.visit(event("event_msg", { type: "agent_message", phase: "final_answer", message: "reply" }));
  expect(() => failed.visit(event("event_msg", { type: "task_complete", error: "failed" }))).toThrow("failed");
  expect(() => failed.visit(event("event_msg", { type: "task_complete", last_agent_message: "different" }))).toThrow("mismatch");
});

test("pre-send failure with an established binding retries without ambiguous launch recovery or duplicate execution",async()=>{
 const f=fakeRuntime();let readiness=0;const recoveringFlags:boolean[]=[];
 const prepare=f.runtime.prepare;f.runtime.prepare=async(binding,request,recovering)=>{recoveringFlags.push(recovering);return prepare(binding,request,recovering)};
 f.runtime.ready=async()=>{if(readiness++===0)throw Error("Completed-turn session has unrelated queued prompts")};
 const first=await execute(f.runtime);expect(first.status).toBe("preparing");expect(f.prompts).toEqual([]);
 const recovered=await execute(f.runtime);expect(recovered.status).toBe("completed");expect(recoveringFlags).toEqual([false,false]);expect(f.launches()).toBe(1);expect(f.prompts).toHaveLength(1);
 expect((await execute(f.runtime)).receiptId).toBe(recovered.receiptId);expect(f.prompts).toHaveLength(1);
});

test("scoped abandonment stops an uncertain writer, fences late completion and retires conversation without deleting history",async()=>{
 const {abandonCompletedTurn}=await import('./completed-turn-abandonment.ts');
 const f=fakeRuntime();f.runtime.send=async()=>{throw Error('lost native response')};
 const uncertain=await execute(f.runtime);expect(uncertain.status).toBe('uncertain');
 let stops=0;f.runtime.abandon=async(row)=>{stops++;return {writerStopped:true,abandonedReceiptId:row.receiptId}};
 const input={owner:'owner',request:request(),store,runtime:f.runtime};
 await expect(abandonCompletedTurn({...input,owner:'foreign'})).rejects.toThrow('binding denied');
 const abandoned=await abandonCompletedTurn(input);expect(abandoned.status).toBe('abandoned');expect(stops).toBe(1);
 expect((await abandonCompletedTurn(input)).receiptId).toBe(abandoned.receiptId);expect(stops).toBe(1);
 expect(()=>store.complete(uncertain.receiptId,'old-token','late','native')).toThrow('claim changed');
 await expect(execute(f.runtime,'successor')).rejects.toThrow('fresh generation');
 expect(store.request('owner','one')?.prompt).toBe('  exact\nprompt  ');
});
test("explicit abandonment revokes an active send claim before stop; failed stop cannot authorize a new writer",async()=>{
 const {abandonCompletedTurn}=await import('./completed-turn-abandonment.ts');const f=fakeRuntime();
 const row=store.enqueue('owner',request(),'run','step');store.claim(row.receiptId,'old');store.bind(row.receiptId,'old','session');store.sending(row.receiptId,'old','native',0);store.uncertain(row.receiptId,'old','active send failed');
 store.claim(row.receiptId,'active');
 let release!:()=>void;f.runtime.abandon=async()=>{await new Promise<void>(resolve=>{release=resolve});throw Error('writer still active')};
 const work=abandonCompletedTurn({owner:'owner',request:request(),store,runtime:f.runtime});await new Promise(resolve=>setTimeout(resolve,0));
 expect(store.get(row.receiptId)?.status).toBe('abandoning');expect(()=>store.complete(row.receiptId,'active','late','native')).toThrow('claim changed');
 expect(()=>store.enqueue('owner',request('new'),'new-run','new-step')).toThrow('fresh generation');
 release();await expect(work).rejects.toThrow('writer still active');expect(store.get(row.receiptId)?.status).toBe('abandoning');expect(store.get(row.receiptId)?.output).toBeNull();
});

test("progress observer and evidence failures cannot interrupt native send or full final receipt", async () => {
  const fake = fakeRuntime();
  const final = "Complete answer\n\n" + "answer details ".repeat(3000);
  fake.runtime.send = async (_id, prompt) => { fake.prompts.push(prompt); return { reply: final, nativeSessionId: "native" }; };
  let failures = 0;
  const receipt = await executeCompletedTurn({ store, storeKey: directory, runtime: fake.runtime, owner: "owner", request: request(), runId: "run", stepId: "step",
    onTurn: () => { throw new Error("Progress disk unavailable"); },
    onTurnError: () => { failures++; throw new Error("Evidence disk unavailable"); },
  });
  expect(receipt).toMatchObject({ status: "completed", reply: final });
  expect(failures).toBe(1);
  expect(fake.prompts).toHaveLength(1);
});
