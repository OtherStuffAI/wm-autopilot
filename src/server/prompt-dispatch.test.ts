import { PromptQueueStore } from "../storage/prompt-queue-store";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentAdapter, PromptReadiness } from "../agents/agent-adapter";
import type { SessionSnapshot } from "../agents/process-manager";
import { createPromptDispatchEngine } from "./prompt-dispatch";
import { SessionDispatchInboxCoordinator } from "../session-dispatch/session-dispatch-inbox";
import { SessionDispatchStore } from "../session-dispatch/session-dispatch-store";
import { handleQueueRoutes } from "./session-queue-routes";
import type { SessionApiContext } from "./session-api-routes";
import type { RequestAuthContext } from "../auth/request-context";
import { DirectChatTurnStore } from "../agent-chat/direct-chat-turn-store";

const roots: string[] = [];

const baseSession: SessionSnapshot = {
  id: "session-1",
  agent: "codex",
  status: "running",
  npub: "npub1owner",
  port: 3700,
  pid: 1234,
  name: "test session",
  startedAt: new Date().toISOString(),
  command: ["codex"],
  workingDirectory: "/tmp/project",
  logs: [],
  agentRuntimeStatus: "running",
  origin: undefined,
  pm2Name: undefined,
  targetFile: undefined,
  metadata: { AGENT: false, billingMode: "subscription" },
};

function createQueue(prompts: string[]) {
  return {
    prompts: prompts.map((content, index) => ({
      id: `prompt-${index + 1}`,
      sessionId: "session-1",
      content,
      timestamp: new Date().toISOString(),
      order: index + 1,
    })),
    getNextQueuedPrompt(sessionId: string) {
      return sessionId === "session-1" ? this.prompts[0] ?? null : null;
    },
    claimNextPrompt(sessionId: string) {
      const prompt = this.getNextQueuedPrompt(sessionId);
      return prompt ? { ...prompt, claimToken: "test-claim" } : null;
    },
    getSessionQueue() { return this.prompts; },
    markClaimSending() {},
    recordClaimAcceptance() {},
    completeClaim(sessionId: string, id: string) {
      if (sessionId === "session-1") this.prompts = this.prompts.filter((prompt) => prompt.id !== id);
    },
    releaseRejectedClaim() {},
    removeNextPrompt(sessionId: string) {
      if (sessionId === "session-1") {
        this.prompts.shift();
      }
    },
    getQueueCount(sessionId: string) {
      return sessionId === "session-1" ? this.prompts.length : 0;
    },
  };
}

function buildEngine(overrides: Record<string, unknown> = {}) {
  const session = { ...baseSession };
  const queue = createQueue(["queued prompt"]);
  const waitForSessionPromptReadiness = mock(async () => undefined);
  const syncSessionMessages = mock(async () => [{ role: "user", content: "queued prompt" }]);
  const maybeTriggerNightWatch = mock(() => undefined);
  const captureAgentapiCodexSessionIdFromPrompt = mock(
    async (_id: string, _prompt: string, _options?: { sentAtMs?: number }) => false,
  );
  const getPromptReadiness = mock(async (): Promise<PromptReadiness> => ({
    state: "ready",
    reason: "test-ready",
    retryAfterMs: 250,
    observedAt: Date.now(),
  }));
  const adapter = {
    getPromptReadiness,
    fetchStatus: mock(async () => "stable" as const),
    sendMessage: mock(async () => {}),
    fetchMessages: mock(async () => []),
    interruptCurrentTurn: mock(async () => false),
    getEventsUrl: () => null,
    waitForReady: mock(async () => {}),
    dispose: mock(async () => {}),
  } satisfies AgentAdapter;

  const engine = createPromptDispatchEngine({
    manager: {
      getSession: (id: string) => (id === session.id ? session : undefined),
      listSessions: () => [],
      getAdapter: () => adapter,
      captureAgentapiCodexSessionIdFromPrompt,
    },
    agentHost: "127.0.0.1",
    messageStore: {
      listSessionMessages: () => [],
    },
    promptQueueStore: queue,
    buildAgentUrl: () => "http://127.0.0.1:3700/message",
    waitForSessionPromptReadiness,
    syncSessionMessages,
    maybeTriggerNightWatch,
    nightWatchDeps: {},
    ...overrides,
  });

  return {
    engine,
    session,
    queue,
    adapter,
    getPromptReadiness,
    waitForSessionPromptReadiness,
    syncSessionMessages,
    maybeTriggerNightWatch,
    captureAgentapiCodexSessionIdFromPrompt,
  };
}

describe("prompt dispatch engine", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("auto-dispatch attempts queued prompts for running sessions even before cached status is stable", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { engine, session, queue, waitForSessionPromptReadiness } = buildEngine();

    await engine.maybeAutoDispatchQueuedPrompt(session);

    expect(waitForSessionPromptReadiness).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queue.getQueueCount(session.id)).toBe(0);
  });

  test("skips readiness probes when a running session has no queued or callback work", async () => {
    const { engine, session, queue, getPromptReadiness } = buildEngine();
    queue.prompts = [];

    await engine.maybeAutoDispatchQueuedPrompt(session);

    expect(getPromptReadiness).not.toHaveBeenCalled();
  });

  test("coalesces overlapping readiness checks for one busy session", async () => {
    const { engine, session, getPromptReadiness } = buildEngine();
    let release: ((readiness: PromptReadiness) => void) | null = null;
    getPromptReadiness.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    const first = engine.maybeAutoDispatchQueuedPrompt(session);
    const second = engine.maybeAutoDispatchQueuedPrompt(session);
    expect(getPromptReadiness).toHaveBeenCalledTimes(1);
    release?.({ state: "busy", reason: "active-turn", retryAfterMs: 250, observedAt: Date.now() });
    await Promise.all([first, second]);

    expect(getPromptReadiness).toHaveBeenCalledTimes(1);
  });

  test("auto-dispatch defers when adapter readiness says busy even if cached status is stable", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { engine, session, queue, getPromptReadiness, waitForSessionPromptReadiness } = buildEngine();
    session.agentRuntimeStatus = "stable";
    getPromptReadiness.mockResolvedValue({
      state: "busy",
      reason: "test-active-turn",
      retryAfterMs: 250,
      observedAt: Date.now(),
    });

    await engine.maybeAutoDispatchQueuedPrompt(session);

    expect(waitForSessionPromptReadiness).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queue.getQueueCount(session.id)).toBe(1);
  });

  test("auto-dispatch does not send queued prompts for unapproved users", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { engine, session, queue, waitForSessionPromptReadiness } = buildEngine({
      isUserApprovedForWork: () => false,
    });

    await engine.maybeAutoDispatchQueuedPrompt(session);

    expect(waitForSessionPromptReadiness).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queue.getQueueCount(session.id)).toBe(1);
  });

  test("cached startup readiness does not skip per-turn readiness while a session is busy", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { engine, session, queue, waitForSessionPromptReadiness } = buildEngine();

    session.agentRuntimeStatus = "stable";
    await engine.maybeAutoDispatchQueuedPrompt(session);

    queue.prompts.push({
      id: "prompt-2",
      sessionId: session.id,
      content: "second prompt",
      timestamp: new Date().toISOString(),
      order: 1,
    });
    session.agentRuntimeStatus = "running";

    await engine.maybeAutoDispatchQueuedPrompt(session);

    expect(waitForSessionPromptReadiness).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(queue.getQueueCount(session.id)).toBe(0);
  });

  test("releases retained prompts chronologically only after readiness returns", async () => {
    const delivered: string[] = [];
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      delivered.push(JSON.parse(String(init?.body ?? "{}")).content);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const { engine, session, queue, getPromptReadiness } = buildEngine();
    queue.prompts = [
      { id: "prompt-1", sessionId: session.id, content: "first", timestamp: "2026-08-04T02:00:00.000Z", order: 1 },
      { id: "prompt-2", sessionId: session.id, content: "second", timestamp: "2026-08-04T02:00:01.000Z", order: 2 },
    ];
    getPromptReadiness.mockResolvedValue({
      state: "busy",
      reason: "goose-waiting-permission",
      retryAfterMs: 250,
      observedAt: Date.now(),
    });

    await engine.maybeAutoDispatchQueuedPrompt(session);
    expect(delivered).toEqual([]);
    expect(queue.getQueueCount(session.id)).toBe(2);

    await Bun.sleep(275);
    getPromptReadiness.mockResolvedValue({
      state: "ready",
      reason: "goose-ready-after-turn-settled",
      retryAfterMs: 250,
      observedAt: Date.now(),
    });
    await engine.maybeAutoDispatchQueuedPrompt(session);
    await engine.maybeAutoDispatchQueuedPrompt(session);

    expect(delivered).toEqual(["first", "second"]);
    expect(queue.getQueueCount(session.id)).toBe(0);
  });

  test("captures Codex native session id after queued prompt delivery", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { engine, session, captureAgentapiCodexSessionIdFromPrompt } = buildEngine();

    const result = await engine.dispatchNextQueuedPromptForSession(session, "npub1owner");

    expect(result.sentPrompt.content).toBe("queued prompt");
    expect(captureAgentapiCodexSessionIdFromPrompt).toHaveBeenCalledTimes(1);
    expect(captureAgentapiCodexSessionIdFromPrompt.mock.calls[0]?.[0]).toBe(session.id);
    expect(captureAgentapiCodexSessionIdFromPrompt.mock.calls[0]?.[1]).toBe("queued prompt");
    expect(captureAgentapiCodexSessionIdFromPrompt.mock.calls[0]?.[2]).toEqual({
      sentAtMs: expect.any(Number),
    });
  });

  test("submits one direct inbox wake when an idle session has unresolved callbacks", async () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-inbox-")); roots.push(root);
    const store = new SessionDispatchStore(join(root, "dispatch.db"));
    store.create({ workerSessionId: "worker-1", callbackSessionId: "session-1", ownerNpub: "npub1owner",
      state: "callback_pending", prompt: "Do work", promptQueuedAt: "2026-08-20T00:00:00Z", reportingContext: {},
      terminalStatus: "completed", terminalMessage: "Done", terminalMessageCreatedAt: "2026-08-20T00:01:00Z",
      terminalFingerprint: "terminal-1", callbackPrompt: null, nativeDiscoveryStartedAt: null,
      nativeDiscoveryNextAttemptAt: null, nativeDiscoveryAttemptCount: 0, nativeDiscoveryLastError: null,
      callbackAttemptCount: 0, callbackNextAttemptAt: null, callbackExpiresAt: null, callbackQueuedAt: null,
      callbackAcknowledgedAt: null, closedAt: null, lastError: null });
    const inbox = new SessionDispatchInboxCoordinator(store);
    const delivered: string[] = [];
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      delivered.push(JSON.parse(String(init?.body ?? "{}")).content);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const f = buildEngine({ dispatchInbox: inbox });
    f.queue.prompts = [];
    f.session.agentRuntimeStatus = "stable";

    await Promise.all([f.engine.reconcileNextTurn(f.session), f.engine.reconcileNextTurn(f.session)]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("unresolved supervised-dispatch callbacks");
    expect(delivered[0]).not.toContain("worker-1");
    expect(f.queue.getQueueCount(f.session.id)).toBe(0);
    expect(inbox.inspect(f.session.id).wake?.state).toBe("submitted");
    expect(inbox.inspect(f.session.id).wake?.busyObservedAt).not.toBeNull();

    await f.engine.reconcileNextTurn(f.session);
    expect(delivered).toHaveLength(1);
    expect(inbox.inspect(f.session.id).wake).toMatchObject({ state: "pending",
      lastError: "Previous wake turn made no inbox progress" });
  });

  test("keeps an unresolved inbox silent while the supervisor turn is busy", async () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-inbox-busy-")); roots.push(root);
    const store = new SessionDispatchStore(join(root, "dispatch.db"));
    store.create({ workerSessionId: "worker-1", callbackSessionId: "session-1", ownerNpub: "npub1owner",
      state: "callback_pending", prompt: "Do work", promptQueuedAt: "2026-08-20T00:00:00Z", reportingContext: {},
      terminalStatus: "completed", terminalMessage: "Done", terminalMessageCreatedAt: "2026-08-20T00:01:00Z",
      terminalFingerprint: "terminal-1", callbackPrompt: null, nativeDiscoveryStartedAt: null,
      nativeDiscoveryNextAttemptAt: null, nativeDiscoveryAttemptCount: 0, nativeDiscoveryLastError: null,
      callbackAttemptCount: 0, callbackNextAttemptAt: null, callbackExpiresAt: null, callbackQueuedAt: null,
      callbackAcknowledgedAt: null, closedAt: null, lastError: null });
    const inbox = new SessionDispatchInboxCoordinator(store);
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const f = buildEngine({ dispatchInbox: inbox });
    f.queue.prompts = [];
    f.getPromptReadiness.mockResolvedValue({ state: "busy", reason: "active-turn", retryAfterMs: 250,
      observedAt: Date.now() });

    await f.engine.reconcileNextTurn(f.session);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inbox.inspect(f.session.id)).toMatchObject({ callbacks: [{ dispatchId: expect.any(String) }], wake: null });
  });

  test("keeps callback wakes durable until the accepted Agent Direct turn is published", async () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-inbox-direct-fence-")); roots.push(root);
    const path = join(root, "dispatch.db");
    const dispatchStore = new SessionDispatchStore(path);
    dispatchStore.create({ workerSessionId: "worker-1", callbackSessionId: "session-1", ownerNpub: "npub1owner",
      state: "callback_pending", prompt: "Do work", promptQueuedAt: "2026-10-19T12:48:47.753Z", reportingContext: {},
      terminalStatus: "completed", terminalMessage: "Callback final", terminalMessageCreatedAt: "2026-10-19T12:48:47.753Z",
      terminalFingerprint: "terminal-1", callbackPrompt: null, nativeDiscoveryStartedAt: null,
      nativeDiscoveryNextAttemptAt: null, nativeDiscoveryAttemptCount: 0, nativeDiscoveryLastError: null,
      callbackAttemptCount: 0, callbackNextAttemptAt: null, callbackExpiresAt: null, callbackQueuedAt: null,
      callbackAcknowledgedAt: null, closedAt: null, lastError: null });
    const inbox = new SessionDispatchInboxCoordinator(dispatchStore);
    const turns = new DirectChatTurnStore(path);
    const now = "2026-10-19T12:48:40.000Z";
    turns.save({ turnId: "human-turn", routingKey: "route", sourceMessageIds: ["human-1", "human-2"],
      clientRequestId: "agentdirect:route:human-turn", replyBody: null, publishedMessageId: null,
      state: "awaiting_reply", createdAt: now, updatedAt: now, sessionId: "session-1", promptType: "direct_chat" });
    const delivered: string[] = [];
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      delivered.push(JSON.parse(String(init?.body ?? "{}")).content);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const f = buildEngine({ dispatchInbox: inbox,
      hasUnpublishedDirectChatTurn: (sessionId: string) => turns.hasRecoverableSessionTurn(sessionId) });
    f.queue.prompts = [];
    f.session.agentRuntimeStatus = "stable";

    await f.engine.reconcileNextTurn(f.session);
    expect(delivered).toEqual([]);
    expect(inbox.inspect(f.session.id).wake).toBeNull();

    turns.save({ ...turns.get("human-turn")!, state: "published", publishedMessageId: "human-answer",
      publishedAt: "2026-10-19T12:48:43.116Z", updatedAt: "2026-10-19T12:48:43.116Z" });
    const reopenedTurns = new DirectChatTurnStore(path);
    expect(reopenedTurns.hasRecoverableSessionTurn(f.session.id)).toBeFalse();

    await f.engine.reconcileNextTurn(f.session);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("unresolved supervised-dispatch callbacks");
    expect(inbox.inspect(f.session.id).wake?.state).toBe("submitted");
  });

  test("delivers a queued human prompt before the durable callback inbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-priority-")); roots.push(root);
    const store = new SessionDispatchStore(join(root, "dispatch.db"));
    store.create({ workerSessionId: "worker-1", callbackSessionId: "session-1", ownerNpub: "npub1owner",
      state: "callback_pending", prompt: "Do work", promptQueuedAt: "2026-08-20T00:00:00Z", reportingContext: {},
      terminalStatus: "completed", terminalMessage: "Done", terminalMessageCreatedAt: "2026-08-20T00:01:00Z",
      terminalFingerprint: "terminal-1", callbackPrompt: null, nativeDiscoveryStartedAt: null,
      nativeDiscoveryNextAttemptAt: null, nativeDiscoveryAttemptCount: 0, nativeDiscoveryLastError: null,
      callbackAttemptCount: 0, callbackNextAttemptAt: null, callbackExpiresAt: null, callbackQueuedAt: null,
      callbackAcknowledgedAt: null, closedAt: null, lastError: null });
    const inbox = new SessionDispatchInboxCoordinator(store);
    const delivered: string[] = [];
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      delivered.push(JSON.parse(String(init?.body ?? "{}")).content);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const f = buildEngine({ dispatchInbox: inbox });
    f.queue.prompts[0]!.content = "Human asks first";
    f.session.agentRuntimeStatus = "stable";

    await f.engine.reconcileNextTurn(f.session);
    expect(delivered).toEqual(["Human asks first"]);
    expect(inbox.hasUnresolved(f.session.id)).toBeTrue();
    expect(inbox.inspect(f.session.id).wake).toBeNull();

    store.update(store.listUnresolvedCallbacks(f.session.id)[0]!.dispatchId, { state: "acknowledged" });
    await f.engine.reconcileNextTurn(f.session);
    expect(delivered).toEqual(["Human asks first"]);
  });

  test("leaves stopped sessions untouched and wakes once when the same session becomes available", async () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-resume-")); roots.push(root);
    const store = new SessionDispatchStore(join(root, "dispatch.db"));
    store.create({ workerSessionId: "worker-1", callbackSessionId: "session-1", ownerNpub: "npub1owner",
      state: "callback_pending", prompt: "Do work", promptQueuedAt: "2026-08-20T00:00:00Z", reportingContext: {},
      terminalStatus: "completed", terminalMessage: "Done", terminalMessageCreatedAt: "2026-08-20T00:01:00Z",
      terminalFingerprint: "terminal-1", callbackPrompt: null, nativeDiscoveryStartedAt: null,
      nativeDiscoveryNextAttemptAt: null, nativeDiscoveryAttemptCount: 0, nativeDiscoveryLastError: null,
      callbackAttemptCount: 0, callbackNextAttemptAt: null, callbackExpiresAt: null, callbackQueuedAt: null,
      callbackAcknowledgedAt: null, closedAt: null, lastError: null });
    const inbox = new SessionDispatchInboxCoordinator(store);
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const f = buildEngine({ dispatchInbox: inbox });
    f.queue.prompts = [];
    f.session.status = "stopped";
    await f.engine.reconcileNextTurn(f.session);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inbox.hasUnresolved(f.session.id)).toBeTrue();

    f.session.status = "running";
    f.session.agentRuntimeStatus = "stable";
    await f.engine.reconcileNextTurn(f.session);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  test("acknowledgement during dispatcher readiness wait prevents delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "queue-dispatch-race-")); roots.push(root);
    const queue = new PromptQueueStore(join(root, "queue.db"));
    const prompt = queue.addPrompt("session-1", { content: "handled while busy" })!;
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => { ready = resolve; });
    const f = buildEngine({ promptQueueStore: queue, waitForSessionPromptReadiness: () => waiting });
    const send = mock(async () => new Response("{}")); globalThis.fetch = send as typeof fetch;
    const dispatch = f.engine.dispatchNextQueuedPromptForSession(f.session, "npub1owner");
    queue.acknowledgePrompt("session-1", prompt.id, prompt.revision, "session:session-1", "handled through callback");
    ready();
    await expect(dispatch).rejects.toMatchObject({ status: 404 });
    expect(send).not.toHaveBeenCalled();
    expect(queue.getHandledPrompts("session-1")).toHaveLength(1);
  });

  test("dispatch claim wins before asynchronous adapter delivery and cannot be acknowledged", async () => {
    const root = mkdtempSync(join(tmpdir(), "queue-dispatch-race-")); roots.push(root);
    const queue = new PromptQueueStore(join(root, "queue.db"));
    const prompt = queue.addPrompt("session-1", { content: "dispatch first" })!;
    const f = buildEngine({ promptQueueStore: queue });
    Object.assign(f.adapter, { deliversPromptsDirectly: () => true });
    f.adapter.sendMessage = mock(async () => {
      expect(() => queue.acknowledgePrompt("session-1", prompt.id, prompt.revision, "actor", "too late")).toThrow("already claimed");
      expect(queue.deletePromptById("session-1", prompt.id)).toBeFalse();
    });
    await f.engine.dispatchNextQueuedPromptForSession(f.session, "npub1owner");
    expect(f.adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(queue.getQueueCount("session-1")).toBe(0);
    expect(() => queue.acknowledgePrompt("session-1", prompt.id, prompt.revision, "actor", "too late")).toThrow("already dispatched");
  });

  test("ambiguous adapter failure retains the durable claim across restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "queue-dispatch-failure-")); roots.push(root);
    const path = join(root, "queue.db");
    const queue = new PromptQueueStore(path);
    queue.addPrompt("session-1", { content: "uncertain delivery" });
    const f = buildEngine({ promptQueueStore: queue });
    Object.assign(f.adapter, { deliversPromptsDirectly: () => true });
    f.adapter.sendMessage = mock(async () => { throw new Error("connection lost after submission"); });
    await expect(f.engine.dispatchNextQueuedPromptForSession(f.session, "npub1owner")).rejects.toMatchObject({ status: 502, payload: { reviewRequired: true } });
    await expect(f.engine.dispatchNextQueuedPromptForSession(f.session, "npub1owner")).rejects.toMatchObject({ status: 409, payload: { reviewRequired: true } });
    expect(f.adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(new PromptQueueStore(path).claimNextPrompt("session-1")).toBeNull();
    expect(queue.getSessionQueue("session-1")[0]?.state).toBe("claimed");
  });

  test("a handled callback cannot deliver a stale wake after adapter readiness yields", async () => {
    const root = mkdtempSync(join(tmpdir(), "callback-wake-race-")); roots.push(root);
    const store = new SessionDispatchStore(join(root, "dispatch.db"));
    const record = store.create({ workerSessionId: "worker", callbackSessionId: "session-1", ownerNpub: "npub1owner",
      state: "callback_pending", prompt: "work", promptQueuedAt: "2026-10-02T00:00:00Z", reportingContext: {},
      terminalStatus: "completed", terminalMessage: "done", terminalMessageCreatedAt: "2026-10-02T00:00:01Z",
      terminalFingerprint: "done-1", callbackPrompt: null, nativeDiscoveryStartedAt: null,
      nativeDiscoveryNextAttemptAt: null, nativeDiscoveryAttemptCount: 0, nativeDiscoveryLastError: null,
      callbackAttemptCount: 0, callbackNextAttemptAt: null, callbackExpiresAt: null, callbackQueuedAt: null,
      callbackAcknowledgedAt: null, closedAt: null, lastError: null });
    const inbox = new SessionDispatchInboxCoordinator(store);
    const f = buildEngine({ dispatchInbox: inbox });
    f.queue.prompts = []; f.session.agentRuntimeStatus = "stable";
    Object.assign(f.adapter, { deliversPromptsDirectly: () => true });
    f.adapter.waitForReady = mock(async () => {
      store.update(record.dispatchId, { state: "acknowledged" });
      inbox.reconcileHandledCallbacks("session-1");
    });
    await f.engine.reconcileNextTurn(f.session);
    expect(f.adapter.sendMessage).not.toHaveBeenCalled();
    expect(inbox.inspect("session-1").wake?.state).toBe("resolved");
  });

  test("explicit busy rejection releases its exact claim for active-turn acknowledgement", async () => {
    const root = mkdtempSync(join(tmpdir(), "queue-dispatch-busy-")); roots.push(root);
    const queue = new PromptQueueStore(join(root, "queue.db"));
    const prompt = queue.addPrompt("session-1", { content: "handled while busy" })!;
    const f = buildEngine({ promptQueueStore: queue });
    Object.assign(f.adapter, { deliversPromptsDirectly: () => true });
    f.getPromptReadiness.mockResolvedValue({ state: "busy", reason: "active-turn", retryAfterMs: 250, observedAt: Date.now() });
    await expect(f.engine.dispatchNextQueuedPromptForSession(f.session, "npub1owner")).rejects.toMatchObject({ status: 409 });
    expect(f.adapter.sendMessage).not.toHaveBeenCalled();
    expect(queue.acknowledgePrompt("session-1", prompt.id, prompt.revision, "session:session-1", "Completed in busy turn").state).toBe("handled");
  });

});

describe("queue delivery recovery boundaries", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  test("drain gate and message lookup exceptions after claim release exact unsent claim", async () => {
    const { restartDrainGate } = await import("../agents/session-admission");
    const original = restartDrainGate.assertPromptExecutionAllowed;
    for (const boundary of ["drain", "messages", "adapter", "readiness"]) {
      const root = mkdtempSync(join(tmpdir(), "queue-presend-")); roots.push(root);
      const queue = new PromptQueueStore(join(root, "queue.db"));
      const first = queue.addPrompt("session-1", { content: boundary })!;
      const second = queue.addPrompt("session-1", { content: "second" })!;
      const f = buildEngine({ promptQueueStore: queue, ...(boundary === "messages" ? { messageStore: { listSessionMessages: () => { throw new Error("lookup failed"); } } } : {}),
        ...(boundary === "adapter" ? { manager: { listSessions: () => [], getAdapter: () => { throw new Error("adapter lookup failed"); } } } : {}) });
      if (boundary === "readiness") f.adapter.waitForReady = mock(async () => { throw new Error("readiness failed"); });
      try {
        if (boundary === "drain") restartDrainGate.assertPromptExecutionAllowed = () => { throw new Error("draining"); };
        await expect(f.engine.dispatchNextQueuedPromptForSession(f.session, "npub1owner")).rejects.toThrow();
        expect(queue.getSessionQueue("session-1").map(p => p.id)).toEqual([first.id, second.id]);
        expect(queue.getSessionQueue("session-1")[0]?.state).toBe("pending");
      } finally { restartDrainGate.assertPromptExecutionAllowed = original; }
    }
  });
  test("lost HTTP acceptance response never replays across reopen; accepted recovery releases second FIFO item", async () => {
    const root = mkdtempSync(join(tmpdir(), "queue-response-loss-")); roots.push(root);
    const path = join(root, "queue.db");
    const queue = new PromptQueueStore(path);
    const first = queue.addPrompt("session-1", { content: "first" })!;
    const second = queue.addPrompt("session-1", { content: "second" })!;
    let accepted = 0;
    globalThis.fetch = (async () => { accepted++; throw new Error("response lost after acceptance"); }) as typeof fetch;
    const f = buildEngine({ promptQueueStore: queue });
    await expect(f.engine.dispatchNextQueuedPromptForSession(f.session, "npub1owner")).rejects.toThrow();
    const reopened = new PromptQueueStore(path);
    const again = buildEngine({ promptQueueStore: reopened });
    await expect(again.engine.dispatchNextQueuedPromptForSession(again.session, "npub1owner")).rejects.toMatchObject({ status: 409 });
    expect(accepted).toBe(1);
    const read = reopened.getSessionQueue("session-1")[0]!;
    expect(read.deliveryState).toBe("uncertain");
    reopened.reconcileClaim("session-1", first.id, read.revision, read.claimToken!, "accepted", "actor", "confirmed in receiver conversation");
    expect(reopened.claimNextPrompt("session-1")?.id).toBe(second.id);
  });
  test("acceptance receipt survives failure before completion and prevents automatic replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "queue-accepted-crash-")); roots.push(root);
    const path = join(root, "queue.db");
    const queue = new PromptQueueStore(path);
    const prompt = queue.addPrompt("session-1", { content: "first" })!;
    queue.completeClaim = () => { throw new Error("crash before completion"); };
    const f = buildEngine({ promptQueueStore: queue });
    const send = mock(async () => new Response("{}")); globalThis.fetch = send as typeof fetch;
    await expect(f.engine.dispatchNextQueuedPromptForSession(f.session, "npub1owner")).rejects.toThrow();
    const reopened = new PromptQueueStore(path);
    expect(reopened.getSessionQueue("session-1")[0]).toMatchObject({ id: prompt.id, deliveryState: "accepted" });
    expect(reopened.claimNextPrompt("session-1")).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

test("post-acceptance synchronization failure never suggests replaying the accepted prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "queue-sync-failure-"));
  const original = globalThis.fetch;
  try {
    const queue = new PromptQueueStore(join(root, "queue.db"));
    queue.addPrompt("session-1", { content: "accepted work" });
    const f = buildEngine({ promptQueueStore: queue, syncSessionMessages: async () => { throw new Error("sync failed"); } });
    globalThis.fetch = (async () => new Response("{}")) as typeof fetch;
    await expect(f.engine.dispatchNextQueuedPromptForSession(f.session, "npub1owner")).rejects.toMatchObject({ payload: { deliveryAccepted: true } });
    expect(queue.getQueueCount("session-1")).toBe(0);
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});


test("direct delegated delivery registers its active attempt before allowing reconciliation", async () => {
  const root = mkdtempSync(join(tmpdir(), "queue-direct-active-"));
  let release!: () => void;
  let sending: Promise<unknown> | undefined;
  try {
    const queue = new PromptQueueStore(join(root, "queue.db"));
    queue.addPrompt("session-1", { content: "Delegated immediate delivery" });
    const f = buildEngine({ promptQueueStore: queue });
    Object.assign(f.adapter, { deliversPromptsDirectly: () => true });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    f.adapter.sendMessage.mockImplementation(async () => { entered(); await held; });
    sending = f.engine.dispatchNextQueuedPromptForSession(f.session, "npub1owner");
    await started;
    const read = queue.getSessionQueue("session-1")[0]!;
    const ctx = { promptQueueStore: queue, queueDispatchInFlight: f.engine.queueDispatchInFlight } as unknown as SessionApiContext;
    const parts = ["", "api", "sessions", "session-1", "queue", read.id, "reconcile"];
    const response = await handleQueueRoutes(new Request(`http://localhost${parts.join("/")}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: read.revision, claimToken: read.claimToken, resolution: "retry", reason: "Attempt to replay active work" }),
    }), "POST", parts, "session-1", f.session, { capabilitySessionId: "session-1" } as RequestAuthContext, ctx);
    expect(response.status).toBe(409);
    expect(queue.getSessionQueue("session-1")[0]?.state).toBe("claimed");
    release();
    await sending;
    expect(f.adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(queue.getQueueCount("session-1")).toBe(0);
    expect(f.engine.queueDispatchInFlight.has("session-1")).toBeFalse();
  } finally {
    release?.();
    await sending?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});


test("overlapping direct deliveries cannot clear another attempt's lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "queue-direct-overlap-"));
  let release!: () => void;
  let first: Promise<unknown> | undefined;
  try {
    const queue = new PromptQueueStore(join(root, "queue.db"));
    queue.addPrompt("session-1", { content: "First delegated delivery" });
    const later = queue.addPrompt("session-1", { content: "Later delegated delivery" })!;
    const f = buildEngine({ promptQueueStore: queue });
    Object.assign(f.adapter, { deliversPromptsDirectly: () => true });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    f.syncSessionMessages.mockImplementation(async () => { entered(); await held; return [{ role: "user", content: "First delegated delivery" }]; });
    first = f.engine.dispatchNextQueuedPromptForSession(f.session, "npub1owner");
    await started;
    await expect(f.engine.dispatchNextQueuedPromptForSession(f.session, "npub1owner")).rejects.toMatchObject({ status: 409 });
    expect(f.engine.queueDispatchInFlight.has("session-1")).toBeTrue();
    expect(queue.getSessionQueue("session-1")[0]).toMatchObject({ id: later.id, state: "pending" });
    expect(f.adapter.sendMessage).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(f.engine.queueDispatchInFlight.has("session-1")).toBeFalse();
    f.syncSessionMessages.mockResolvedValue([{ role: "user", content: "Later delegated delivery" }]);
    await f.engine.dispatchNextQueuedPromptForSession(f.session, "npub1owner");
    expect(f.adapter.sendMessage).toHaveBeenCalledTimes(2);
    expect(queue.getQueueCount("session-1")).toBe(0);
  } finally {
    release?.();
    await first?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepted native pickup shrinks pending before its long-running turn completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "queue-pickup-"));
  try {
    const queue = new PromptQueueStore(join(root, "queue.db"));
    const first = queue.addPrompt("session-1", { content: "First native instruction" })!;
    const second = queue.addPrompt("session-1", { content: "Later independent instruction" })!;
    const f = buildEngine({ promptQueueStore: queue });
    let listener: ((event: any) => void) | undefined;
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    Object.assign(f.adapter, { deliversPromptsDirectly: () => true,
      subscribeToEvents: (next: typeof listener) => { listener = next; return () => { listener = undefined; }; },
      sendMessage: async (content: string) => {
        listener?.({ type: "message", message: { role: "user", content } });
        await completion;
      } });
    await f.engine.dispatchNextQueuedPromptForSession(f.session, "npub1owner");
    expect(queue.getSessionQueue("session-1").map(row => row.id)).toEqual([second.id]);
    expect(queue.getSessionQueue("session-1").some(row => row.id === first.id)).toBe(false);
    finish();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
