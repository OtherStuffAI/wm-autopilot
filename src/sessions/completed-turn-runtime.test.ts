import { inputRecords, messageRecords, toolRecords, completeRecord, type TranscriptFormat } from "../agents/__tests__/native-turn-fixtures.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionSnapshot } from "../agents/process-manager.ts";
import type { SessionApiContext } from "../server/session-api-routes.ts";
import { createCompletedTurnRuntime, completedTurnBindingId } from "./completed-turn-runtime.ts";
import { parseCompletedTurnRequest } from "./completed-turn-contract.ts";
import { PipelineStore } from "../pipelines/pipeline-store.ts";
import { runDeclarativePipeline, resumeDeclarativePipeline } from "../pipelines/pipeline-runner.ts";
import type { PipelineDefinitionRecord } from "../pipelines/pipeline-loader.ts";
import { ResultWebhookService } from "../pipelines/result-webhook-service.ts";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, nip19 } from "nostr-tools";
import { handlePipelineHttp } from "../server/pipeline-http.ts";
import { resolveNip98AuthContext } from "../auth/nip98-auth.ts";
import { Nip98ReplayCache, verifyNip98Request } from "../auth/nip98-verifier.ts";
import { AccessActions } from "../auth/access-control.ts";
import type { PipelineApiContext } from "../pipelines/pipeline-api-routes.ts";
import { createHash } from "node:crypto";
import { ActivityWebhookMonitor } from "../pipelines/activity-webhook-monitor.ts";
import { ActivityWebhookDelivery } from "../pipelines/activity-webhook-delivery.ts";

let directory: string;
let previousCodexHome: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "completed-runtime-"));
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  mkdirSync(join(directory, "sessions"));
});
afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(directory, { recursive: true, force: true });
});

function fixture(format: TranscriptFormat = "legacy") {
  const sessions = new Map<string, SessionSnapshot>();
  const archives = new Map<string, SessionSnapshot>();
  const prompts: string[] = [];
  const launches: Array<{ nativeId: string | undefined }> = [];
  let gate: Promise<void> | null = null;
  let fail = false;
  let reply = "safe final";
  let onStarted: ((session: SessionSnapshot, file: string) => Promise<void>) | null = null;
  const adapter = {
    getPromptReadiness: async () => ({ state: "ready", reason: "test", retryAfterMs: 1, observedAt: Date.now() }),
    sendCompletedMessage: async (prompt: string) => {
      prompts.push(prompt);
      if (gate) await gate;
      const id = [...sessions.keys()].at(-1)!;
      const session = sessions.get(id)!;
      const nativeId = session.metadata?.nativeAgentSession?.sessionId ?? "native-conversation";
      session.metadata!.nativeAgentSession = { agent: "codex", sessionId: nativeId, workingDirectory: directory, capturedAt: new Date().toISOString(), source: "adapter" };
      const file = join(directory, "sessions", `rollout-${nativeId}.jsonl`);
      if (prompts.length === 1) writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: nativeId, cwd: directory } }) + "\n");
      const turnId = `turn-${prompts.length}`;
      appendFileSync(file, inputRecords(format, prompt, turnId).map(row => JSON.stringify(row)).join("\n") + "\n");
      if (onStarted) await onStarted(session, file);
      appendFileSync(file, [...messageRecords(format, reply, turnId, "final_answer"), completeRecord(reply, format === "legacy" ? undefined : turnId)]
        .map((row) => JSON.stringify(row)).join("\n") + "\n");
      if (fail) throw new Error("Response lost after completion");
      return reply;
    },
  };
  const ctx = {
    agentHost: "localhost", isAgentType: (agent: string) => agent === "codex",
    manager: {
      getSession: (id: string) => sessions.get(id),
      getAdapter: (id: string) => sessions.get(id)?.status === "running" ? adapter : null,
      createSession: async (_agent: string, cwd: string, name: string, _origin: unknown, _target: unknown, owner: string, metadata: SessionSnapshot["metadata"]) => {
        launches.push({ nativeId: metadata?.nativeAgentSession?.sessionId });
        const id = `session-${launches.length}`;
        const session = { id, agent: "codex", status: "running", workingDirectory: cwd, npub: owner, metadata, name, startedAt: new Date().toISOString(), port: 0 } as SessionSnapshot;
        sessions.set(id, session);
        return session;
      },
    },
    sessionArchiveStore: { getArchivedSession: (id: string) => archives.get(id) },
    messageStore: { getSession: (id: string) => sessions.get(id), listSessions: () => [...sessions.values()], recordSession: () => {} },
    syncSessionMessages: async () => {}, promptQueueStore: { getQueueCount: () => 0, getSessionQueue: () => [] },
  } as unknown as SessionApiContext;
  const request = (id = "one") => parseCompletedTurnRequest({ conversationKey: "conversation", projectId: "project", requestId: id, prompt: `  ${id}\nexact  `, directory });
  return { ctx, sessions, archives, launches, prompts, request, setGate: (value: Promise<void> | null) => { gate = value; }, setFail: (value: boolean) => { fail = value; }, setStarted: (value: typeof onStarted) => { onStarted = value; }, setReply: (value: string) => { reply = value; } };
}
function definition(): PipelineDefinitionRecord {
  return { id: "native", slug: "native", name: "native", scope: "shared", ownerAlias: null, path: null,
    spec: { name: "native", steps: [{ name: "Conversation turn", type: "code", function: "session.completedTurn",
      display: { in: [{ label: "Prompt", path: "prompt", format: "text" }], out: [{ label: "Reply", path: "reply", format: "text" }] } }] } };
}

test("pipeline glue reuses native conversation and native-resumes stopped owned session", async () => {
  const f = fixture();
  const store = new PipelineStore(join(directory, "runs.sqlite"));
  const run = (id: string) => runDeclarativePipeline({ store, definition: definition(), registry: {},
    input: { ...f.request(id) }, ownerNpub: "npub1owner", ownerAlias: null, sessionApiContext: f.ctx, callbackOrigin: "https://example.com" });
  const first = await run("one");
  const second = await run("two");
  expect(first.result).toMatchObject({ status: "completed", sessionId: "session-1", nativeSessionId: "native-conversation", invocationRunId: first.id });
  expect(second.result).toMatchObject({ status: "completed", sessionId: "session-1", nativeSessionId: "native-conversation" });
  f.sessions.get("session-1")!.status = "stopped";
  const third = await run("three");
  expect(third.result).toMatchObject({ status: "completed", sessionId: "session-2", nativeSessionId: "native-conversation" });
  expect(f.launches).toEqual([{ nativeId: undefined }, { nativeId: "native-conversation" }]);
  expect(f.prompts).toEqual(["  one\nexact  ", "  two\nexact  ", "  three\nexact  "]);
  expect(store.listSteps(third.id)[0]?.wingmanSessionId).toBe("session-2");
});

test.each(["legacy", "modern", "mixed"] as const)("%s pipeline recovers exact completion without replay", async format => {
  const f = fixture(format);
  f.setFail(true);
  const store = new PipelineStore(join(directory, "runs.sqlite"));
  const input = { store, definition: definition(), registry: {}, input: { ...f.request() },
    ownerNpub: "npub1owner", ownerAlias: null, sessionApiContext: f.ctx, callbackOrigin: "https://example.com" };
  const first = await runDeclarativePipeline(input);
  expect(first).toMatchObject({ status: "error", result: { status: "uncertain", requestId: "one", reply: null } });
  const recovered = await runDeclarativePipeline(input);
  expect(recovered).toMatchObject({ status: "ok", result: { status: "completed", reply: "safe final", runId: first.id, invocationRunId: recovered.id } });
  expect(f.prompts).toHaveLength(1);
});

test("live step correlation precedes completion; signed webhook carries receipt without raw native activity", async () => {
  const f = fixture();
  let release!: () => void;
  f.setGate(new Promise<void>((resolve) => { release = resolve; }));
  const store = new PipelineStore(join(directory, "runs.sqlite"));
  const signingKey = generateSecretKey(); // New synthetic test identity; no existing credential access.
  const owner = nip19.npubEncode(getPublicKey(signingKey));
  const run = store.publicCalls.create({ owner, definitionId: "native", key: "one", fingerprint: "one", webhookUrl: "https://receiver.example/result" },
    () => store.createRun({ definitionId: "native", name: "native", scope: "shared", ownerNpub: owner, input: { ...f.request() } }));
  store.composition.pin(run.id, definition(), {});
  const execution = resumeDeclarativePipeline({ store, definition: definition(), registry: {}, input: { ...f.request() },
    ownerNpub: owner, ownerAlias: null, sessionApiContext: f.ctx, callbackOrigin: "https://example.com" }, run.id);
  const deliveries: Array<{ body: string; headers: Record<string, string> }> = [];
  const webhooks = new ResultWebhookService(store, getPublicKey(signingKey), (event) => finalizeEvent(event, signingKey),
    async (_url, body, headers) => { deliveries.push({ body, headers }); return 204; });
  await Bun.sleep(10);
  expect(store.listSteps(run.id)[0]?.wingmanSessionId).toBe("session-1");
  expect(store.getRun(run.id)?.completedAt).toBeNull();
  const step = store.listSteps(run.id)[0]!;
  const replayCache = new Nip98ReplayCache();
  const api: PipelineApiContext = { store, defaultAgent: "codex", sharedInstanceAccess: true, AccessActions,
    sessionApiContext: f.ctx, ensureApiAccess: async (_action, _request, _url, auth) =>
      auth.npub ? null : Response.json({ error: "Authentication required" }, { status: 401 }) };
  async function readProgress(key?: Uint8Array) {
    const url = `https://example.com/api/pipelines/runs/${run.id}/steps/${step.id}`;
    const event = key ? finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "",
      tags: [["u", url], ["method", "GET"], ["nonce", crypto.randomUUID()]] }, key) : null;
    const request = new Request(url, { headers: event ? { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}` } : {} });
    return (await handlePipelineHttp(request, new URL(url), { npub: null, actorNpub: null, session: null }, api,
      (req, requestUrl, auth) => resolveNip98AuthContext(req, requestUrl, auth, {
        verifyNip98AuthHeader: (request, requestUrl) => verifyNip98Request({ request, requestUrl, configuredBaseUrl: "https://example.com", replayCache }),
      })))!;
  }
  expect((await readProgress()).status).toBe(401);
  expect((await readProgress(generateSecretKey())).status).toBe(404);
  const progress = await readProgress(signingKey);
  expect(progress.status).toBe(200);
  const progressPayload = await progress.json();
  const status = progressPayload.events.find((event: { type: string }) => event.type === "completed_turn_status");
  const safeStatus = JSON.parse(status.data_json);
  expect(safeStatus).toMatchObject({ requestId: "one", projectId: "project", sessionId: "session-1", status: "preparing" });
  expect(safeStatus).not.toHaveProperty("prompt");
  expect(safeStatus).not.toHaveProperty("continuity");
  expect(safeStatus).not.toHaveProperty("nativeSessionId");
  await webhooks.tick();
  expect(deliveries).toHaveLength(0);
  release(); await execution; await webhooks.tick();
  expect(deliveries).toHaveLength(1);
  const sent = deliveries[0]!;
  const payload = JSON.parse(sent.body);
  expect(payload).toMatchObject({ runId: run.id, terminal: true, status: "ok", result: {
    requestId: "one", projectId: "project", runId: run.id, sessionId: "session-1", nativeSessionId: "native-conversation", status: "completed", reply: "safe final" } });
  const event = JSON.parse(Buffer.from(sent.headers.Authorization!.slice(6), "base64").toString());
  expect(verifyEvent(event)).toBe(true);
  expect(event.tags).toContainEqual(["payload", createHash("sha256").update(sent.body).digest("hex")]);
  expect(event.tags).toContainEqual(["run", run.id]);
  expect(event.tags).toContainEqual(["delivery", payload.deliveryId]);
  expect(payload.result).not.toHaveProperty("prompt");
  expect(payload.result).not.toHaveProperty("checkpoint");
});

test("native runtime denies ownership, wrong binding, transport and missing native resume", async () => {
  const f = fixture();
  const runtime = createCompletedTurnRuntime(f.ctx);
  const binding = { owner: "npub1owner", conversationKey: "conversation", config: "", sessionId: null, executionId: null };
  const id = await runtime.prepare(binding, f.request(), false);
  await expect(runtime.authorize({ ...f.request(), sessionId: id }, "npub1other")).rejects.toThrow("ownership denied");
  await expect(runtime.authorize({ ...f.request(), conversationKey: "other", sessionId: id }, "npub1owner")).rejects.toThrow("matching dedicated");
  expect(f.sessions.get(id)!.metadata?.bindingId).toBe(completedTurnBindingId("npub1owner", "conversation"));
  f.sessions.get(id)!.status = "stopped";
  await expect(runtime.prepare({ ...binding, sessionId: id }, f.request(), true)).rejects.toThrow("native agent session id");
  expect(f.launches).toHaveLength(1);
});


test("uncertain native resume recovers the persisted child without launching another process", async () => {
  const f = fixture();
  const runtime = createCompletedTurnRuntime(f.ctx);
  const binding = { owner: "npub1owner", conversationKey: "conversation", config: "", sessionId: null, executionId: null };
  const firstId = await runtime.prepare(binding, f.request(), false);
  await runtime.send(firstId, f.request().prompt);
  f.sessions.get(firstId)!.status = "stopped";
  const stoppedBinding = { ...binding, sessionId: firstId, executionId: firstId };
  await expect(runtime.prepare(stoppedBinding, f.request("two"), true)).rejects.toThrow("resume launch outcome uncertain");
  expect(f.launches).toHaveLength(1);
  // Simulate native resume launch persisted, followed by loss of generic receipt binding.
  const childId = await runtime.prepare(stoppedBinding, f.request("two"), false);
  expect(await runtime.prepare(stoppedBinding, f.request("two"), true)).toBe(childId);
  expect(f.launches).toHaveLength(2);
  f.sessions.get(childId)!.status = "stopped";
  await expect(runtime.prepare(stoppedBinding, f.request("two"), true)).rejects.toThrow("requires operator recovery");
  expect(f.launches).toHaveLength(2);
});


test("completed-turn resume resolves archived bound sessions with unchanged ownership and native reference", async () => {
  const f = fixture();
  const store = new PipelineStore(join(directory, "archived-runs.sqlite"));
  const run = (id: string) => runDeclarativePipeline({ store, definition: definition(), registry: {},
    input: { ...f.request(id) }, ownerNpub: "npub1owner", ownerAlias: null, sessionApiContext: f.ctx, callbackOrigin: "https://example.com" });
  const first = await run("one");
  expect(first.result).toMatchObject({ status: "completed", nativeSessionId: "native-conversation" });
  f.archives.set("session-1", { ...f.sessions.get("session-1")!, status: "stopped" });
  f.sessions.delete("session-1");
  const resumed = await run("two");
  expect(resumed.result).toMatchObject({ status: "completed", sessionId: "session-2", nativeSessionId: "native-conversation", sequence: 2 });
  expect(f.launches).toEqual([{ nativeId: undefined }, { nativeId: "native-conversation" }]);
  expect(f.prompts).toEqual(["  one\nexact  ", "  two\nexact  "]);
});

test("archive lookup never permits foreign owner, directory or binding", async () => {
  for (const changed of [{ npub: "foreign", metadata: { ownerNpub: "foreign" } },
    { workingDirectory: "/foreign" }, { metadata: { role: "completed-turn", agentTransport: "codex-sdk", bindingId: "foreign" } }]) {
    const f = fixture();
    const runtime = createCompletedTurnRuntime(f.ctx);
    const binding = { owner: "npub1owner", conversationKey: "conversation", config: "", sessionId: null, executionId: null };
    const id = await runtime.prepare(binding, f.request(), false);
    await runtime.send(id, f.request().prompt);
    const existing = f.sessions.get(id)!;
    f.archives.set(id, { ...existing, ...changed, metadata: { ...existing.metadata, ...(changed.metadata ?? {}) }, status: "stopped" });
    f.sessions.delete(id);
    await expect(runtime.prepare({ ...binding, sessionId: id }, f.request("two"), false)).rejects.toThrow();
    expect(f.launches).toHaveLength(1);
    expect(f.prompts).toHaveLength(1);
  }
});

test("explicit source-lookup recovery resumes the archived native request once without changing its receipt", async () => {
  const f = fixture();
  const store = new PipelineStore(join(directory, "preparation-recovery.sqlite"));
  const run = (id: string, recovery = false) => runDeclarativePipeline({ store, definition: definition(), registry: {},
    input: { ...f.request(id), ...(recovery ? { recoverPreparation: true } : {}) }, ownerNpub: "npub1owner", ownerAlias: null,
    sessionApiContext: f.ctx, callbackOrigin: "https://example.com" });
  await run("one");
  const archived = { ...f.sessions.get("session-1")!, status: "stopped" as const };
  f.sessions.delete("session-1");
  // The source was missing before any resume launch. No second native prompt was sent.
  const failed = await run("two");
  expect(failed.status).toBe("error");
  const prepared = store.completedTurns.request("npub1owner", "two")!;
  expect(prepared).toMatchObject({ status: "preparing", sessionId: null, executionId: null, checkpoint: null, error: "Completed-turn bound session unavailable" });
  expect(f.prompts).toHaveLength(1);
  f.archives.set("session-1", archived);
  const recovered = await run("two", true);
  expect(recovered.result).toMatchObject({ status: "completed", receiptId: prepared.receiptId, nativeSessionId: "native-conversation", sequence: 2, invocationRunId: recovered.id });
  expect(f.prompts).toEqual(["  one\nexact  ", "  two\nexact  "]);
  expect(f.launches).toHaveLength(2);
  const repeat = await run("two", true);
  expect(repeat.result).toMatchObject({ status: "completed", receiptId: prepared.receiptId, sequence: 2 });
  expect(f.prompts).toHaveLength(2);
});


test.each(["legacy", "modern", "mixed"] as const)("%s real completedTurn emits public progress, keeps full reply on failure, isolates follow-up", async format => {
  const f = fixture(format);
  const fullReply = "Complete final answer\n\n" + "answer detail ".repeat(3000);
  f.setReply(fullReply);
  const store = new PipelineStore(join(directory, "activity-runs.sqlite"));
  const monitor = new ActivityWebhookMonitor(store, f.ctx);
  const key = generateSecretKey();
  let at = Date.now();
  const delivered: string[] = [];
  const delivery = new ActivityWebhookDelivery(store.activityWebhooks, event => finalizeEvent(event, key), async (_url, body) => { delivered.push(body); return 503; }, () => at);
  const def = definition();
  (def.spec.steps[0] as Extract<import("../pipelines/declarative.ts").DeclarativeStep, { type: "code" }>).activityWebhook = {
    url: "https://receiver.example/activity", correlation: { requestId: "$.requestId", projectId: "$.projectId", workshopId: "$.workshopId", nativeRequestId: "$.nativeRequestId", generation: "$.activityGeneration" },
  };
  (def.spec.steps[0] as Extract<import("../pipelines/declarative.ts").DeclarativeStep, { type: "code" }>).input = {
    pick: { conversationKey: "$.conversationKey", requestId: "$.nativeRequestId", projectId: "$.projectId", prompt: "$.prompt", directory: "$.directory" },
  };
  let turn = 0;
  f.setStarted(async (_session, file) => {
    turn++;
    appendFileSync(file, [
      ...messageRecords(format, `Public turn ${turn}`, `turn-${turn}`),
      ...toolRecords(`turn-${turn}`),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    await monitor.tick();
    const bound = store.activityWebhooks.active().at(-1)!;
    expect(store.getRun(bound.runId)?.completedAt).toBeNull();
    expect(store.completedTurns.get(bound.receiptId!)?.status).toBe("sending");
    expect(store.activityWebhooks.list(bound.turnId).map(item => JSON.parse(item.body).content)).toEqual([`Public turn ${turn}`, "Using tools"]);
    for (let attempt = 0; attempt < 3; attempt++) { await delivery.tick(); at += 10_000; }
  });
  const run = (id: string) => runDeclarativePipeline({ store, definition: def, registry: {}, input: { ...f.request(id), requestId: "original-request", nativeRequestId: id, activityGeneration: id === "one" ? "1" : "2", workshopId: "workshop" },
    ownerNpub: "npub1owner", ownerAlias: null, sessionApiContext: f.ctx, callbackOrigin: "https://example.com" });
  const first = await run("one");
  await monitor.tick();
  const second = await run("two");
  await monitor.tick();
  expect(first.result).toMatchObject({ status: "completed", reply: fullReply });
  expect(second.result).toMatchObject({ status: "completed", reply: fullReply, sessionId: first.result!.sessionId });
  const firstEvents = store.activityWebhooks.list(first.result!.receiptId as string);
  const secondEvents = store.activityWebhooks.list(second.result!.receiptId as string);
  expect(store.completedTurns.get(second.result!.receiptId as string)?.checkpoint).toBe(1);
  expect(firstEvents.map(item => JSON.parse(item.body).type)).toEqual(["commentary", "tools", "completed"]);
  expect(secondEvents.map(item => JSON.parse(item.body).content)).toEqual(["Public turn 2", "Using tools", "Completed"]);
  expect(JSON.parse(firstEvents[0]!.body).correlation).toEqual({ requestId: "original-request", projectId: "project", workshopId: "workshop", nativeRequestId: "one", generation: "1" });
  expect(JSON.parse(secondEvents[0]!.body).correlation).toEqual({ requestId: "original-request", projectId: "project", workshopId: "workshop", nativeRequestId: "two", generation: "2" });
  expect(JSON.parse(secondEvents[0]!.body)).toMatchObject({ runId: second.result!.runId, stepId: second.result!.stepId, sessionId: second.result!.sessionId, turnId: second.result!.receiptId });
  expect(second.result!.executionId).toBe(second.result!.sessionId);
  expect(firstEvents[0]).toMatchObject({ status: "failed", attempts: 3 });
  expect(delivered.join(" ")).not.toContain("PRIVATE");
  expect(store.activityWebhooks.active()).toHaveLength(0);
  await run("two");
  expect(f.prompts).toHaveLength(2);
  expect(store.activityWebhooks.list(second.result!.receiptId as string)).toHaveLength(3);
  f.setStarted(null);
  const disabled = await runDeclarativePipeline({ store, definition: definition(), registry: {}, input: { ...f.request("three") },
    ownerNpub: "npub1owner", ownerAlias: null, sessionApiContext: f.ctx, callbackOrigin: "https://example.com" });
  expect(disabled.result).toMatchObject({ status: "completed", reply: fullReply });
  expect(store.activityWebhooks.list(disabled.result!.receiptId as string)).toHaveLength(0);
});


test("missing declared activity correlation fails before launching or sending native work", async () => {
  const f = fixture();
  const store = new PipelineStore(join(directory, "bad-activity.sqlite"));
  const def = definition();
  (def.spec.steps[0] as Extract<import("../pipelines/declarative.ts").DeclarativeStep, { type: "code" }>).activityWebhook = {
    url: "https://receiver.example/activity", correlation: { requestId: "$.missing" },
  };
  const result = await runDeclarativePipeline({ store, definition: def, registry: {}, input: { ...f.request() },
    ownerNpub: "npub1owner", ownerAlias: null, sessionApiContext: f.ctx, callbackOrigin: "https://example.com" });
  expect(result.status).toBe("error");
  expect(result.error).toContain("Missing trusted activity correlation");
  expect(f.launches).toHaveLength(0);
  expect(f.prompts).toHaveLength(0);
});

test("scoped native abandonment disposes and stops only matching dedicated sessions, preserving transcript and refusing foreign association",async()=>{
 const f=fixture(),store=new PipelineStore(join(directory,'abandon.sqlite'));
 f.setFail(true);
 const run=(input:any,owner='npub1owner')=>runDeclarativePipeline({store,definition:definition(),registry:{},input,ownerNpub:owner,ownerAlias:null,sessionApiContext:f.ctx,callbackOrigin:'https://example.com'});
 const first=await run({...f.request()});expect(first.result?.status).toBe('uncertain');
 let disposals=0,stops=0;
 const originalAdapter=f.ctx.manager.getAdapter;
 (f.ctx.manager as any).getAdapter=(id:string)=>{const adapter=originalAdapter.call(f.ctx.manager,id);return adapter?{...adapter,dispose:async()=>{disposals++}}:null};
 (f.ctx.manager as any).listSessions=()=>[...f.sessions.values()];
 (f.ctx.manager as any).stopSession=async(id:string)=>{stops++;f.sessions.get(id)!.status='stopped';return f.sessions.get(id)};
 const foreign={...f.sessions.get('session-1')!,id:'foreign',npub:'npub1foreign',metadata:{...f.sessions.get('session-1')!.metadata,ownerNpub:'npub1foreign'}} as SessionSnapshot;
 f.sessions.set('foreign',foreign);
 const denied=await run({...f.request(),abandonUncertain:true});expect(denied.status).toBe('error');expect(stops).toBe(0);expect(disposals).toBe(0);
 f.sessions.delete('foreign');
 const stopped=await run({...f.request(),abandonUncertain:true});expect(stopped.result).toMatchObject({status:'abandoned',output:{writerStopped:true,historyPreserved:true}});
 expect(stops).toBe(1);expect(disposals).toBe(1);expect(f.prompts).toHaveLength(1);
 const duplicate=await run({...f.request(),abandonUncertain:true});expect(duplicate.result?.status).toBe('abandoned');expect(stops).toBe(1);
 expect(await Bun.file(join(directory,'sessions','rollout-native-conversation.jsonl')).exists()).toBe(true);
});


test("recovery before activity binding uses original captured destination rather than a newer definition", async () => {
  const f = fixture(); f.setFail(true);
  const store = new PipelineStore(join(directory, "activity-recovery.sqlite"));
  const original = definition();
  const originalStep = original.spec.steps[0] as Extract<import("../pipelines/declarative.ts").DeclarativeStep, { type: "code" }>;
  originalStep.activityWebhook = { url: "https://original.example/activity", correlation: { requestId: "$.requestId" } };
  const execute = (def: PipelineDefinitionRecord) => runDeclarativePipeline({ store, definition: def, registry: {}, input: { ...f.request() },
    ownerNpub: "npub1owner", ownerAlias: null, sessionApiContext: f.ctx, callbackOrigin: "https://example.com" });
  const failed = await execute(original);
  expect(failed.status).toBe("error");
  // Simulate a host dying after the native send claim but before the progress binding is written.
  const db = new Database(store.path);
  db.run("DELETE FROM pipeline_activity_deliveries"); db.run("DELETE FROM pipeline_activity_turns"); db.close();
  const newer = definition();
  (newer.spec.steps[0] as typeof originalStep).activityWebhook = { url: "https://new.example/activity", correlation: {} };
  const recovered = await execute(newer);
  expect(recovered.result).toMatchObject({ status: "completed", reply: "safe final", runId: failed.id });
  expect(f.prompts).toHaveLength(1);
  const binding = store.activityWebhooks.active()[0]!;
  expect(binding.destination).toEqual({ url: "https://original.example/activity", correlation: { requestId: "one" } });
  expect(binding.runId).toBe(failed.id);
});

test("native resume excludes stale ordinary queue transfer; dedicated readiness audits unsent prompts and blocks claimed work",async()=>{
 const {PromptQueueStore}=await import('../storage/prompt-queue-store.ts');
 const {rebindNativeDirectChatRecovery}=await import('../agent-chat/direct-chat-native-recovery.ts');
 const f=fixture(),store=new PipelineStore(join(directory,'queue-collision.sqlite')),queue=new PromptQueueStore(join(directory,'ordinary.sqlite'));
 f.ctx.promptQueueStore=queue;
 const run=(id:string)=>runDeclarativePipeline({store,definition:definition(),registry:{},input:{...f.request(id)},ownerNpub:'npub1owner',ownerAlias:null,sessionApiContext:f.ctx,callbackOrigin:'https://example.com'});
 await run('one');f.sessions.get('session-1')!.status='stopped';queue.addPrompt('session-1',{content:'stale ordinary instruction'});
 const create=f.ctx.manager.createSession;let transfers=0;
 (f.ctx.manager as any).createSession=async(...args:any[])=>{
  const target=await (create as any)(...args);
  rebindNativeDirectChatRecovery(target,{manager:f.ctx.manager,archiveStore:f.ctx.sessionArchiveStore!,getStoredSession:id=>f.sessions.get(id) as any,dispatchStore:{rebindSession:()=>{transfers++;return 0}},promptQueueStore:queue,turnStore:{} as any,interceptStore:{listAll:()=>{throw Error('Dedicated builder must not transfer direct chat')},save:()=>{}}});return target;
 };
 expect((await run('two')).result?.status).toBe('completed');expect(transfers).toBe(0);expect(queue.getQueueCount('session-1')).toBe(1);expect(queue.getQueueCount('session-2')).toBe(0);
 queue.addPrompt('session-2',{content:'unsent stale continuation'});
 expect((await run('three')).result?.status).toBe('completed');expect(queue.getQueueCount('session-2')).toBe(0);expect(queue.getHandledPrompts('session-2')).toEqual([]);
 queue.addPrompt('session-2',{content:'ambiguous ordinary delivery'});queue.claimNextPrompt('session-2');
 const blocked=await run('four');expect(blocked.result).toMatchObject({status:'preparing',error:'Completed-turn session has unresolved ordinary delivery'});expect(f.prompts).toHaveLength(3);expect(queue.getQueueCount('session-2')).toBe(1);
});

test('native project tools upgrade an idle dedicated session by scoped resume, preserving the native thread and prior turn',async()=>{
 const f=fixture(),legacy=createCompletedTurnRuntime(f.ctx),binding={owner:'npub1owner',conversationKey:'conversation',config:'',sessionId:null,executionId:null};
 const first=await legacy.prepare(binding,f.request(),false);await legacy.send(first,f.request().prompt);
 const oldAdapter=f.ctx.manager.getAdapter(first)!;let disposed=0,stopped=0;
 oldAdapter.dispose=async()=>{disposed++;};
 f.ctx.manager.stopSession=async id=>{stopped++;const session=f.sessions.get(id)!;session.status='stopped';return session;};
 const runtime=createCompletedTurnRuntime(f.ctx,{projectTools:true});
 const resumed=await runtime.prepare({...binding,sessionId:first},f.request('two'),false);
 expect(disposed).toBe(1);expect(stopped).toBe(1);expect(f.prompts).toHaveLength(1);
 expect(f.sessions.get(resumed)?.metadata?.nativeProjectTools).toBe(true);
 expect(f.sessions.get(resumed)?.metadata?.nativeAgentSession?.sessionId).toBe('native-conversation');
 expect(f.sessions.get(first)?.status).toBe('stopped');expect(f.launches).toHaveLength(2);
});
