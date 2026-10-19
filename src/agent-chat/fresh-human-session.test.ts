import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptQueueStore } from "../storage/prompt-queue-store";
import { DirectChatTurnStore } from "./direct-chat-turn-store";
import { ChatInterceptStateStore } from "./chat-intercept-state-store";
import { prepareFreshHumanSession, afterFreshHumanBoundary } from "./fresh-human-session";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fresh-human-")); roots.push(root);
  const queuePath = join(root, "queue.db");
  const queue = new PromptQueueStore(queuePath);
  const turnStore = new DirectChatTurnStore(join(root, "turns.db"));
  const interceptStore = new ChatInterceptStateStore(join(root, "intercepts.db"));
  const intercept = interceptStore.upsertMessage({ routingKey: "route", subscriptionId: "sub", agentId: "agent",
    workspaceOwnerNpub: "owner", sourceAppNpub: "app", channelId: "channel", threadId: "thread", botNpub: "bot", messageId: "old" }).record;
  interceptStore.save({ ...intercept, sessionId: "session", state: "archived" });
  let status = "stopped";
  const deps = { manager: { getSession: () => ({ status }) } as any, interceptStore, turnStore,
    retireSessionWork: (sessionId: string, trigger: string) => queue.retireForFreshHumanTrigger(sessionId, trigger) };
  return { root, queuePath, queue, turnStore, interceptStore, deps, setStatus: (next: string) => { status = next; } };
}

test("inactive fresh-human cutoff retires uncertain claims without acceptance, survives reopen, and never widens on retry", () => {
  const f = fixture();
  const old = f.queue.addPrompt("session", { content: "Interrupted work" })!;
  const claimed = f.queue.claimNextPrompt("session")!;
  f.queue.markClaimSending("session", old.id, claimed.claimToken!);
  const ageFixture = new Database(f.queuePath);
  ageFixture.query("UPDATE prompt_queue SET timestamp='2000-01-01T00:00:00Z',delivery_updated_at='2000-01-01T00:00:00Z' WHERE id=?").run(old.id);
  ageFixture.close();
  f.queue.addPrompt("unrelated", { content: "Leave this alone" });
  prepareFreshHumanSession(f.deps, f.interceptStore.getByRoutingKey("route")!, "new");
  expect(f.queue.getQueueCount("session")).toBe(0);
  const fresh = f.queue.addPrompt("session", { content: "Concurrent post-cutoff work" })!;
  const reopened = new PromptQueueStore(f.queuePath);
  reopened.retireForFreshHumanTrigger("session", "new");
  expect(reopened.getSessionQueue("session").map(r => r.id)).toEqual([fresh.id]);
  expect(reopened.getQueueCount("unrelated")).toBe(1);
  expect(() => reopened.completeClaim("session", old.id, claimed.claimToken!)).toThrow();
  const inspect = new Database(f.queuePath);
  expect(inspect.query("SELECT state,delivery_state FROM prompt_queue WHERE id=?").get(old.id))
    .toEqual({ state: "superseded", delivery_state: "uncertain" });
  inspect.close();
  // A second human arrives while creation is still pending: join the first boundary.
  prepareFreshHumanSession(f.deps, f.interceptStore.getByRoutingKey("route")!, "newer");
  expect(f.queue.getQueueCount("session")).toBe(1);
  expect(f.interceptStore.getByRoutingKey("route")?.freshStartMessageId).toBe("new");
  const history = [{ messageId: "old" }, { messageId: "new" }, { messageId: "newer" }];
  expect(afterFreshHumanBoundary(history, history, f.interceptStore.getByRoutingKey("route")!))
    .toEqual(history.slice(1));
  // Same-session rehydration followed by another stop establishes a new generation.
  f.interceptStore.save({ ...f.interceptStore.getByRoutingKey("route")!, state: "idle" });
  prepareFreshHumanSession(f.deps, f.interceptStore.getByRoutingKey("route")!, "next-stop");
  expect(f.queue.getQueueCount("session")).toBe(0);
  expect(f.interceptStore.getByRoutingKey("route")?.freshStartMessageId).toBe("next-stop");
});

test("active intake leaves the queue intact; retired direct turns cannot be resurrected by stale snapshots", () => {
  const f = fixture();
  f.setStatus("running");
  f.queue.addPrompt("session", { content: "Active pending work" });
  prepareFreshHumanSession(f.deps, f.interceptStore.getByRoutingKey("route")!, "active");
  expect(f.queue.getQueueCount("session")).toBe(1);
  expect(f.interceptStore.getByRoutingKey("route")?.freshStartMessageId).toBeNull();
  const now = new Date().toISOString();
  const old = f.turnStore.save({ turnId: "old", routingKey: "route", sessionId: "session", sourceMessageIds: ["old"],
    clientRequestId: "old-client", replyBody: null, publishedMessageId: null, state: "awaiting_reply", createdAt: now, updatedAt: now,
    threadId: "thread", agentNpub: "bot" });
  f.setStatus("stopped");
  prepareFreshHumanSession(f.deps, f.interceptStore.getByRoutingKey("route")!, "new");
  expect(f.turnStore.save({ ...old, state: "awaiting_reply" }).state).toBe("suppressed");
  expect(f.turnStore.freezeReply("old", "Duplicate callback", now).state).toBe("suppressed");
  expect(f.turnStore.getPending("route")).toBeNull();
});

test("a durable interrupted turn supersedes live process status after stores reopen", async () => {
  const { prepareFreshHumanIntake } = await import("./fresh-human-session");
  const f = fixture();
  const now = new Date().toISOString();
  f.setStatus("running");
  f.queue.addPrompt("session", { content: "Interrupted accepted work" });
  f.turnStore.save({ turnId: "interrupted", routingKey: "route", sessionId: "session", sourceMessageIds: ["old"],
    clientRequestId: "interrupted-client", replyBody: null, publishedMessageId: null, state: "awaiting_reply",
    createdAt: now, updatedAt: now, threadId: "thread", agentNpub: "bot",
    lastError: "server_overloaded", lastErrorClass: "accepted_turn_interrupted" });
  const reopenedTurns = new DirectChatTurnStore(join(f.root, "turns.db"));
  const reopenedIntercepts = new ChatInterceptStateStore(join(f.root, "intercepts.db"));
  const manager = { getSession: () => ({ id: "session", status: "running", agentRuntimeStatus: "running" }),
    getAdapter: () => { throw new Error("failed intake must not wait for live readiness"); } } as any;

  await prepareFreshHumanIntake({ ...f.deps, manager, turnStore: reopenedTurns, interceptStore: reopenedIntercepts },
    reopenedIntercepts.getByRoutingKey("route")!, "fresh");

  expect(reopenedTurns.get("interrupted")).toMatchObject({ state: "suppressed", lastErrorClass: "fresh_human_supersession" });
  expect(reopenedIntercepts.getByRoutingKey("route")?.freshStartMessageId).toBe("fresh");
  expect(f.queue.getQueueCount("session")).toBe(0);
});

test("a persisted cross-store snapshot protects arrivals and edits after interrupted cleanup", async () => {
  const { SessionDispatchStore } = await import("../session-dispatch/session-dispatch-store");
  const { SessionDispatchInboxCoordinator } = await import("../session-dispatch/session-dispatch-inbox");
  const { createFreshSessionWorkRetirement } = await import("./fresh-session-work-retirement");
  const f = fixture();
  const callbacks = new SessionDispatchStore(join(f.root, "callbacks.db"));
  const inbox = new SessionDispatchInboxCoordinator(callbacks);
  const oldPrompt = f.queue.addPrompt("session", { content: "Old" })!;
  const template = { workerSessionId: "worker", callbackSessionId: "session", ownerNpub: "owner", state: "callback_pending" as const,
    prompt: "work", promptQueuedAt: new Date().toISOString(), reportingContext: {}, terminalStatus: "completed" as const,
    terminalMessage: "done", terminalMessageCreatedAt: new Date().toISOString(), terminalFingerprint: "old-fingerprint",
    callbackPrompt: null, nativeDiscoveryStartedAt: null, nativeDiscoveryNextAttemptAt: null, nativeDiscoveryAttemptCount: 0,
    nativeDiscoveryLastError: null, callbackAttemptCount: 0, callbackNextAttemptAt: null, callbackExpiresAt: null,
    callbackQueuedAt: null, callbackAcknowledgedAt: null, closedAt: null, lastError: null };
  const old = callbacks.create(template);
  const oldWake = inbox.claimForStableSession("session")!;
  let fail = true;
  const retire = createFreshSessionWorkRetirement({ turns: f.turnStore, prompts: f.queue,
    callbacks: { captureFreshHumanCutoff: id => callbacks.captureFreshHumanCutoff(id),
      retireForFreshHumanTrigger: (...args) => { if (fail) throw new Error("simulated exit after queue commit"); callbacks.retireForFreshHumanTrigger(...args); } } });
  expect(() => retire("session", "human-1", "route")).toThrow("simulated exit");
  const fresh = callbacks.create({ ...template, terminalFingerprint: "new-fingerprint" });
  const freshPrompt = f.queue.addPrompt("session", { content: "Arrived after cutoff" })!;
  fail = false;
  retire("session", "human-1", "route");
  expect(callbacks.get(old.dispatchId)?.state).toBe("superseded");
  expect(callbacks.get(fresh.dispatchId)?.state).toBe("callback_pending");
  expect(f.queue.getSessionQueue("session").map(row => row.id)).toEqual([freshPrompt.id]);
  expect(f.queue.getSessionQueue("session").some(row => row.id === oldPrompt.id)).toBe(false);
  expect(inbox.validateClaim(oldWake)).toBe(false);
  const restartedTurns = new DirectChatTurnStore(join(f.root, "turns.db"));
  const snapshot = restartedTurns.freshSessionSnapshot("session", "human-1", () => { throw Error("must not recapture"); });
  expect(snapshot).toBeDefined();
});

test("live idle reactivation retires old work only after authoritative readiness; busy turns remain intact", async () => {
  const { prepareFreshHumanIntake } = await import("./fresh-human-session");
  for (const readiness of ["stable", "running", "unreachable"] as const) {
    const f = fixture();
    f.setStatus("running");
    f.queue.addPrompt("session", { content: "Prior pending instruction" });
    f.interceptStore.save({ ...f.interceptStore.getByRoutingKey("route")!, state: "idle" });
    const adapter = { fetchStatus: async () => readiness === "unreachable" ? null : readiness };
    const manager = { getSession: () => ({ id: "session", status: "running", agentRuntimeStatus: "stable" }), getAdapter: () => adapter } as any;
    await prepareFreshHumanIntake({ ...f.deps, manager }, f.interceptStore.getByRoutingKey("route")!, "new");
    expect(f.queue.getQueueCount("session")).toBe(readiness === "stable" ? 0 : 1);
  }
  const f = fixture();
  f.queue.addPrompt("session", { content: "Busy work" });
  f.interceptStore.save({ ...f.interceptStore.getByRoutingKey("route")!, state: "idle" });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const snapshot = { id: "session", status: "running", agentRuntimeStatus: "stable" };
  const adapter = { fetchStatus: async () => { await gate; return "stable"; } };
  const manager = { getSession: () => snapshot, getAdapter: () => adapter } as any;
  const intake = prepareFreshHumanIntake({ ...f.deps, manager }, f.interceptStore.getByRoutingKey("route")!, "new");
  snapshot.agentRuntimeStatus = "running";
  release();
  await intake;
  expect(f.queue.getQueueCount("session")).toBe(1);
});

test("concurrent live-idle humans share the first trigger even when readiness is delayed", async () => {
  const { FreshHumanIntakeCoordinator } = await import("./fresh-human-session");
  const f = fixture();
  f.interceptStore.save({ ...f.interceptStore.getByRoutingKey("route")!, state: "idle" });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const adapter = { fetchStatus: async () => { reads++; await gate; return "stable"; } };
  const manager = { getSession: () => ({ id: "session", status: "running", agentRuntimeStatus: "stable" }), getAdapter: () => adapter } as any;
  const intake = new FreshHumanIntakeCoordinator();
  const first = intake.prepare({ ...f.deps, manager }, f.interceptStore.getByRoutingKey("route")!, "first");
  const second = intake.prepare({ ...f.deps, manager }, f.interceptStore.getByRoutingKey("route")!, "second");
  release();
  await Promise.all([first, second]);
  expect(reads).toBe(1);
  expect(f.interceptStore.getByRoutingKey("route")?.freshStartMessageId).toBe("first");
});
