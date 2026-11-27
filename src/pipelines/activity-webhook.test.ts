import { beforeEach, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { PipelineStore } from "./pipeline-store.ts";
import { ActivityWebhookDelivery, activityAuthTemplate } from "./activity-webhook-delivery.ts";
import { resolveActivityWebhook, validateActivityWebhookSteps } from "./activity-webhook-contract.ts";
import { verifyActivityWebhookRequest } from "./activity-webhook-verification.ts";
import { bindActivityWebhook } from "./activity-webhook-binding.ts";
import { postResultWebhook } from "./result-webhook-http.ts";
import { retainAgentFinalResponse } from "./agent-final-response.ts";
import type { ActivityTurnBinding } from "./activity-webhook-store.ts";
import type { lookup } from "node:dns/promises";
import { ResultWebhookService } from "./result-webhook-service.ts";
import { ActivityWebhookMonitor } from "./activity-webhook-monitor.ts";
import { AcpEventNormalizer } from "../agents/acp-event-normalizer.ts";
import type { AgentMessage } from "../agents/agent-client.ts";
import type { SessionApiContext } from "../server/session-api-routes.ts";

let directory: string;
let store: PipelineStore;
let binding: ActivityTurnBinding;
let at: number;
const secret = generateSecretKey();
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "activity-webhook-"));
  store = new PipelineStore(join(directory, "runs.sqlite"));
  at = Date.now();
  const run = store.createRun({ definitionId: "test", name: "test", scope: "shared", ownerNpub: "owner", input: { requestId: "request", project: { id: "project" } } });
  const step = store.createStep({ runId: run.id, stepIndex: 0, name: "Agent", kind: "agent", input: {} });
  binding = { turnId: "turn", runId: run.id, stepId: step.id, sessionId: "session", receiptId: null, checkpoint: 0, prompt: "prompt",
    destination: { url: "https://receiver.example/activity", correlation: { requestId: "request", projectId: "project" } } };
  store.activityWebhooks.bind(binding);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const append = (sourceId: string) => store.activityWebhooks.append(binding, { sourceId, timestamp: new Date(at).toISOString(), type: "commentary", content: `Public ${sourceId}` });

function adapterMonitor(messages: AgentMessage[], agent = "antigravity-acp", target = store): ActivityWebhookMonitor {
  target.completeStep({ id: binding.stepId, status: "running", wingmanSessionId: binding.sessionId });
  const ctx = { manager: {
    getSession: () => ({ agent }),
    getAdapter: () => ({ fetchMessages: async () => messages }),
  } } as unknown as SessionApiContext;
  return new ActivityWebhookMonitor(target, ctx);
}

function message(role: string, content: string, messageId = role): AgentMessage {
  return { role, content, messageId, createdAt: new Date(at).toISOString() };
}

function activityBodies() {
  return store.activityWebhooks.list(binding.turnId).map(item => JSON.parse(item.body));
}

test("ACP thinking growth and rolled progress survive unchanged polls and monitor recovery", async () => {
  const normalizer = new AcpEventNormalizer(() => new Date(at), { rollIntermediateAgentMessages: true });
  normalizer.beginTurn();
  const messages = [message("user", binding.prompt)];
  function update(sessionUpdate: string, text: string, messageId?: string) {
    const result = normalizer.normalize({ sessionUpdate, content: { type: "text", text }, messageId });
    if (result.kind !== "message" && result.kind !== "messages") throw new Error("Expected normalized messages");
    for (const entry of result.kind === "messages" ? result.messages : [result.message]) {
      const index = messages.findIndex(item => item.messageId === entry.messageId);
      if (index < 0) messages.push(entry); else messages[index] = entry;
    }
  }
  const monitor = adapterMonitor(messages);
  update("agent_thought_chunk", "Inspecting");
  await monitor.tick(); await monitor.tick();
  expect(activityBodies().map(item => item.content)).toEqual(["Inspecting"]);
  update("agent_thought_chunk", " files");
  await monitor.tick(); await monitor.tick();
  update("agent_message_chunk", "Progress report", "first");
  update("agent_message_chunk", "Final answer", "second");
  await monitor.tick();
  const recovered = new PipelineStore(store.path);
  await adapterMonitor(messages, "antigravity-acp", recovered).tick();
  const events = activityBodies();
  expect(events.map(item => item.content)).toEqual(["Inspecting", "Inspecting files", "Inspecting files\n\nProgress report"]);
  expect(events.map(item => item.type)).toEqual(["commentary", "commentary", "commentary"]);
  expect(new Set(events.map(item => item.eventId)).size).toBe(3);
  expect(store.listEvents(binding.runId).filter(item => item.type === "activity_source_unavailable")).toEqual([]);
});

test("non-Codex thinking interleaves with coalesced tools and respects turn boundaries", async () => {
  const messages = [message("user", "earlier"), message("agent-thinking", "Ignore old"),
    message("user", binding.prompt, "current"), message("agent-thinking", "Planning", "thinking-1"),
    message("agent-tools", "tool one", "tool-1"), message("agent-tools", "tool two", "tool-2"),
    message("agent-thinking", "Checking", "thinking-2"), message("agent-tools", "tool three", "tool-3"),
    message("agent-commentary", "Done checking", "comment"), message("assistant", "Final"),
    message("user", "follow-up", "next"), message("agent-thinking", "Ignore next", "next-thinking")];
  binding.checkpoint = 1;
  const monitor = adapterMonitor(messages, "goose");
  await monitor.observe(binding); await monitor.observe(binding);
  expect(activityBodies().map(item => [item.type, item.content])).toEqual([
    ["commentary", "Planning"], ["tools", "Using tools"], ["commentary", "Checking"],
    ["tools", "Using tools"], ["commentary", "Done checking"],
  ]);
});

test("long growing thinking publishes recent bounded text and ignores empty sanitized content", async () => {
  const messages = [message("user", binding.prompt), message("agent-thinking", " \0 ", "empty"),
    message("agent-thinking", "x".repeat(4001), "growing")];
  const monitor = adapterMonitor(messages);
  await monitor.tick();
  messages[2]!.content += "New progress";
  await monitor.tick(); await monitor.tick();
  expect(activityBodies().map(item => item.content)).toEqual(["x".repeat(4000), "x".repeat(3988) + "New progress"]);
});

test("immutable outbox rescans deduplicate, sequence is ordered and terminal cannot reopen", () => {
  append("one"); append("two"); append("one");
  store.activityWebhooks.finish(binding, true);
  append("late"); store.activityWebhooks.finish(binding, false);
  const recovered = new PipelineStore(store.path);
  const deliveries = recovered.activityWebhooks.list(binding.turnId);
  expect(deliveries.map(item => item.sequence)).toEqual([1, 2, 3]);
  expect(deliveries.map(item => JSON.parse(item.body).type)).toEqual(["commentary", "commentary", "completed"]);
  expect(recovered.activityWebhooks.active()).toHaveLength(0);
  expect(() => recovered.activityWebhooks.bind({ ...binding, sessionId: "foreign" })).toThrow("binding changed");
  expect(recovered.activityWebhooks.due(at)).toHaveLength(1);
  recovered.activityWebhooks.bindNative(binding.turnId, "native-one");
  recovered.activityWebhooks.bindNative(binding.turnId, "native-one");
  expect(() => recovered.activityWebhooks.bindNative(binding.turnId, "native-two")).toThrow("conversation binding changed");
});

test("signed delivery binds exact URL/method/raw body and headers; forged callbacks rejected", async () => {
  append("one");
  let captured!: { body: string; headers: Headers };
  const sender = new ActivityWebhookDelivery(store.activityWebhooks, event => finalizeEvent(event, secret), async (_url, body, headers) => {
    captured = { body, headers: new Headers(headers) }; return 204;
  }, () => at);
  await sender.tick();
  const request = { url: binding.destination.url, method: "POST", ...captured, signerPubkey: getPublicKey(secret), now: at };
  expect(verifyActivityWebhookRequest(request)).toMatchObject({ version: 1, sequence: 1, turnId: "turn", correlation: binding.destination.correlation });
  expect(verifyActivityWebhookRequest({ ...request, body: Buffer.from(captured.body, "utf8") })).toMatchObject({ eventId: JSON.parse(captured.body).eventId });
  for (const changed of [{ url: "https://receiver.example/other" }, { method: "GET" }, { body: `${captured.body} ` }, { signerPubkey: getPublicKey(generateSecretKey()) }, { now: at + 91_000 }]) {
    expect(() => verifyActivityWebhookRequest({ ...request, ...changed })).toThrow();
  }
  const headers = new Headers(captured.headers); headers.set("x-wingman-event-id", "forged");
  expect(() => verifyActivityWebhookRequest({ ...request, headers })).toThrow("header/body");
  const duplicateTag = activityAuthTemplate(binding.destination.url, captured.body, at);
  duplicateTag.tags.push(["u", "https://receiver.example/other"]);
  headers.set("authorization", `Nostr ${Buffer.from(JSON.stringify(finalizeEvent(duplicateTag, secret))).toString("base64")}`);
  expect(() => verifyActivityWebhookRequest({ ...request, headers })).toThrow("authentication tag");
});

test("delivery failures stop at three attempts, recover leases, and do not suppress terminal/final result", async () => {
  append("one"); store.activityWebhooks.finish(binding, true);
  store.completeRun(binding.runId, "ok", { reply: "FULL FINAL" });
  const attempts: string[] = [];
  let reopened = store;
  for (let i = 0; i < 3; i++) {
    const sender = new ActivityWebhookDelivery(reopened.activityWebhooks, event => finalizeEvent(event, secret), async (_url, body) => { attempts.push(body); throw new Error("offline"); }, () => at);
    await sender.tick();
    const row = reopened.activityWebhooks.list(binding.turnId)[0]!;
    at = row.nextAttemptAt;
    reopened = new PipelineStore(store.path);
  }
  expect(attempts).toHaveLength(3);
  expect(new Set(attempts).size).toBe(1);
  expect(reopened.activityWebhooks.list(binding.turnId)[0]).toMatchObject({ attempts: 3, status: "failed" });
  const terminal = reopened.activityWebhooks.due(at)[0]!;
  expect(JSON.parse(terminal.body).type).toBe("completed");
  const claim = reopened.activityWebhooks.claim(terminal.eventId, at)!;
  expect(reopened.activityWebhooks.claim(terminal.eventId, at)).toBeNull();
  at += 30_000;
  const recoveredClaim = reopened.activityWebhooks.claim(claim.eventId, at)!;
  expect(recoveredClaim.body).toBe(claim.body);
  expect(reopened.getRun(binding.runId)?.result).toEqual({ reply: "FULL FINAL" });
});

test("stalled progress transport does not block authoritative result callback delivery", async () => {
  append("one");
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const progress = new ActivityWebhookDelivery(store.activityWebhooks, event => finalizeEvent(event, secret), async () => { await stalled; return 503; }, () => at);
  const pending = progress.tick();
  const run = store.publicCalls.create({ owner: "owner", definitionId: "test", key: null, fingerprint: "x", webhookUrl: "https://receiver.example/final" },
    () => store.createRun({ definitionId: "test", name: "test", scope: "shared", ownerNpub: "owner", input: {} }));
  store.completeRun(run.id, "ok", { reply: "UNTRUNCATED FINAL" });
  const final = new ResultWebhookService(store, getPublicKey(secret), event => finalizeEvent(event, secret), async () => 204, () => at);
  await final.tick();
  expect(store.publicCalls.getDelivery(run.id)?.status).toBe("delivered");
  release(); await pending;
});

test("trusted correlation reads original input, disabled configuration creates no binding", () => {
  const spec = { url: binding.destination.url, correlation: { requestId: "$.requestId", projectId: "$.project.id" } };
  expect(resolveActivityWebhook(store, binding.runId, spec)).toEqual(binding.destination);
  expect(() => resolveActivityWebhook(store, binding.runId, { ...spec, correlation: { requestId: "$.missing" } })).toThrow("Missing trusted");
  expect(resolveActivityWebhook(store, binding.runId)).toBeNull();
  expect(bindActivityWebhook({ ...binding, store, turnId: "disabled" })).toBeNull();
  expect(bindActivityWebhook({ ...binding, store, turnId: "bad-config", spec: { ...spec, correlation: { requestId: "$.missing" } } })).toBeNull();
  expect(store.listEvents(binding.runId).some(event => event.type === "activity_configuration_failed")).toBe(true);
  expect(store.activityWebhooks.active()).toHaveLength(1);
  expect(() => validateActivityWebhookSteps({ name: "test", steps: [{ type: "code", name: "bad", function: "echo", activityWebhook: spec }] })).toThrow("requires an agent");
});

test("destination revalidation rejects private/mixed DNS, credentials, redirects and nonliteral config", async () => {
  let sent = 0;
  const options = { resolve: (async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup,
    transport: async () => { sent++; return 204; } };
  await expect(postResultWebhook(binding.destination.url, "{}", {}, options)).rejects.toThrow("non-public");
  expect(sent).toBe(0);
  for (const url of ["$.webhookUrl", "http://receiver.example/a", "https://user:secret@receiver.example/a", "https://receiver.example:444/a"]) {
    expect(() => resolveActivityWebhook(store, binding.runId, { url, correlation: {} })).toThrow();
  }
});

test("ordinary Agent Step retains complete final transcript answer independently of callback output", () => {
  const full = "Full answer\n\n" + "long text ".repeat(2000);
  const ctx = { messageStore: { listSessionMessages: () => [
    { role: "user", content: "old" }, { role: "agent", content: "old answer" },
    { role: "user", content: "current" }, { role: "agent-thinking", content: "PRIVATE" }, { role: "agent", content: full },
  ] } };
  expect(retainAgentFinalResponse(ctx as never, "session", { artifactId: "artifact" })).toEqual({ artifactId: "artifact", finalResponse: full });
});
