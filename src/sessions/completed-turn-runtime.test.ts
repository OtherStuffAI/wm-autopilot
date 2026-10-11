import { afterEach, beforeEach, expect, test } from "bun:test";
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

function fixture() {
  const sessions = new Map<string, SessionSnapshot>();
  const prompts: string[] = [];
  const launches: Array<{ nativeId: string | undefined }> = [];
  let gate: Promise<void> | null = null;
  let fail = false;
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
      appendFileSync(file, [
        { type: "event_msg", payload: { type: "user_message", message: prompt } },
        { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "safe final" } },
        { type: "event_msg", payload: { type: "task_complete", last_agent_message: "safe final" } },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n");
      if (fail) throw new Error("Response lost after completion");
      return "safe final";
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
    messageStore: { getSession: (id: string) => sessions.get(id), listSessions: () => [...sessions.values()], recordSession: () => {} },
    syncSessionMessages: async () => {}, promptQueueStore: { getQueueCount: () => 0 },
  } as unknown as SessionApiContext;
  const request = (id = "one") => parseCompletedTurnRequest({ conversationKey: "conversation", projectId: "project", requestId: id, prompt: `  ${id}\nexact  `, directory });
  return { ctx, sessions, launches, prompts, request, setGate: (value: Promise<void> | null) => { gate = value; }, setFail: (value: boolean) => { fail = value; } };
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

test("pipeline error preserves uncertainty and later invocation recovers exact completion without replay", async () => {
  const f = fixture();
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
