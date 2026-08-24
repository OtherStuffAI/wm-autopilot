import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentAdapter, PromptReadiness } from "../agents/agent-adapter";
import type { SessionSnapshot } from "../agents/process-manager";
import { createPromptDispatchEngine } from "./prompt-dispatch";
import { SessionDispatchInboxCoordinator } from "../session-dispatch/session-dispatch-inbox";
import { SessionDispatchStore } from "../session-dispatch/session-dispatch-store";

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
});
