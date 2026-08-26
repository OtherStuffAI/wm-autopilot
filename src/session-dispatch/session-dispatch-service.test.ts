import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptQueueStore } from "../storage/prompt-queue-store";
import { SessionDispatchInboxCoordinator } from "./session-dispatch-inbox";
import { SessionDispatchService } from "./session-dispatch-service";
import { SessionDispatchStore } from "./session-dispatch-store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function session(id: string, owner = "npub1owner", runtimeStatus: "running" | "stable" = "running") {
  return { id, npub: owner, metadata: { AGENT: true, billingMode: "subscription", ownerNpub: owner },
    status: "running", agent: "claude-code", port: 3700, agentRuntimeStatus: runtimeStatus } as any;
}

function fixture(options: { supervisorRuntime?: "running" | "stable" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dispatch-service-")); roots.push(root);
  const store = new SessionDispatchStore(join(root, "dispatch.db"));
  const queue = new PromptQueueStore(join(root, "queue.db"));
  const inbox = new SessionDispatchInboxCoordinator(store);
  const sessions = new Map([["supervisor", session("supervisor", "npub1owner", options.supervisorRuntime)]]);
  let workerNumber = 0;
  const adapters = new Map<string, any>();
  const createSession = mock(async () => {
    const index = ++workerNumber;
    const worker = session(`worker-${index}`);
    sessions.set(worker.id, worker);
    adapters.set(worker.id, { deliversPromptsDirectly: () => true, fetchStatus: async () => "stable",
      fetchMessages: async () => [{ role: "user", content: `Work ${index}`, createdAt: "2026-01-01T00:00:00Z" },
        { role: "assistant", content: `Done ${index}`, createdAt: `2026-01-01T00:01:${String(index).padStart(2, "0")}Z` }] });
    return worker;
  });
  const manager = {
    getSession: (id: string) => sessions.get(id),
    getAdapter: (id: string) => adapters.get(id) ?? null,
    createSession,
  } as any;
  const requested = mock(async () => {});
  const closedWorkers: string[] = [];
  const service = new SessionDispatchService(store, manager, queue, () => {}, {},
    (id) => { closedWorkers.push(id); }, inbox, requested);
  return { store, queue, inbox, sessions, adapters, service, requested, closedWorkers, createSession };
}

describe("SessionDispatchService callback inbox", () => {
  test("creates an owned dispatched-worker session through the manager issuance path", async () => {
    const f = fixture();

    await f.service.create({ agent: "codex", prompt: "Use broker capability", callbackEnabled: true,
      callbackSessionId: "supervisor" });

    expect(f.createSession).toHaveBeenCalledWith(
      "codex",
      undefined,
      undefined,
      { type: "session-dispatch", id: "supervisor" },
      undefined,
      "npub1owner",
      { role: "dispatched-worker", callbackSessionId: "supervisor" },
    );
  });

  test("captures a terminal result without adding a supervisor queue prompt", async () => {
    const f = fixture();
    const created = await f.service.create({ agent: "claude", prompt: "Work 1", callbackEnabled: true,
      callbackSessionId: "supervisor" });
    await f.service.checkRunning();

    expect(f.queue.getSessionQueue("supervisor")).toHaveLength(0);
    expect(f.service.getInbox("supervisor").callbacks).toHaveLength(1);
    expect(f.service.get(created.dispatchId, "supervisor")).toMatchObject({ state: "callback_pending",
      terminalStatus: "completed", terminalMessage: "Done 1", callbackPrompt: null });
    expect(f.requested).toHaveBeenCalledTimes(1);
    expect(f.closedWorkers).toEqual(["worker-1"]);
  });

  test("ten terminal results remain ten inbox items and consume no supervisor queue rows", async () => {
    const f = fixture();
    for (let index = 1; index <= 10; index += 1) {
      await f.service.create({ agent: "claude", prompt: `Work ${index}`, callbackEnabled: true,
        callbackSessionId: "supervisor" });
    }
    await f.service.checkRunning();
    expect(f.service.getInbox("supervisor").callbacks).toHaveLength(10);
    expect(f.queue.getSessionQueue("supervisor")).toHaveLength(0);
  });

  test("allows acknowledgement before a wake and prevents same-owner cross-session handling", async () => {
    const f = fixture();
    f.sessions.set("peer", session("peer"));
    const created = await f.service.create({ agent: "claude", prompt: "Work 1", callbackEnabled: true,
      callbackSessionId: "supervisor" });
    await f.service.checkRunning();

    expect(f.service.getInbox("peer").callbacks).toHaveLength(0);
    expect(() => f.service.acknowledge(created.dispatchId, "peer")).toThrow("Only the callback session");
    expect(f.service.acknowledge(created.dispatchId, "supervisor").state).toBe("acknowledged");
    expect(f.service.getInbox("supervisor").callbacks).toHaveLength(0);
    expect(f.service.close(created.dispatchId, "supervisor").state).toBe("closed");
  });

  test("rejects dispatch access from a session owned by someone else", async () => {
    const f = fixture();
    f.sessions.set("intruder", session("intruder", "npub1other"));
    const created = await f.service.create({ agent: "claude", prompt: "Work 1", callbackEnabled: true,
      callbackSessionId: "supervisor" });

    expect(() => f.service.get(created.dispatchId, "intruder")).toThrow("another owner");
    expect(() => f.service.acknowledge(created.dispatchId, "intruder")).toThrow("another owner");
  });

  test("keeps a stopped or missing supervisor inbox durable", async () => {
    const f = fixture();
    const created = await f.service.create({ agent: "claude", prompt: "Work 1", callbackEnabled: true,
      callbackSessionId: "supervisor" });
    f.sessions.delete("supervisor");
    await f.service.checkRunning();
    expect(f.store.listUnresolvedCallbacks("supervisor")).toHaveLength(1);
    expect(f.store.get(created.dispatchId)?.state).toBe("callback_pending");
    expect(f.queue.getSessionQueue("supervisor")).toHaveLength(0);
  });

  test("retries delayed Codex native discovery and captures timeout failure in the inbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-native-")); roots.push(root);
    const queue = new PromptQueueStore(join(root, "queue.db"));
    const store = new SessionDispatchStore(join(root, "dispatch.db"));
    const inbox = new SessionDispatchInboxCoordinator(store);
    let now = new Date("2026-01-01T00:00:00.000Z");
    let discoveryAttempts = 0;
    const supervisor = session("supervisor");
    const worker = { ...session("worker"), agent: "codex", metadata: { agentTransport: "agentapi" } } as any;
    const sessions = new Map([["supervisor", supervisor], ["worker", worker]]);
    const manager = { getSession: (id: string) => sessions.get(id),
      getAdapter: (id: string) => id === "worker" ? { deliversPromptsDirectly: () => false } : null,
      createSession: async () => worker,
      captureAgentapiCodexSessionIdFromPrompt: async () => { discoveryAttempts += 1; return false; } } as any;
    const service = new SessionDispatchService(store, manager, queue, () => {}, {
      now: () => now, nativeDiscoveryRetryInitialMs: 1_000, nativeDiscoveryTimeoutMs: 1_000,
    }, () => {}, inbox);
    const created = await service.create({ agent: "codex", prompt: "Build it", callbackEnabled: true,
      callbackSessionId: "supervisor" });

    await service.checkRunning();
    expect(discoveryAttempts).toBe(1);
    now = new Date(now.getTime() + 1_000);
    await service.checkRunning();
    expect(service.get(created.dispatchId)).toMatchObject({ state: "callback_pending", terminalStatus: "failed" });
    expect(service.getInbox("supervisor").callbacks[0]?.terminalMessage).toContain("native transcript");
  });

  test("retains successful delayed Codex native-session discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-native-success-")); roots.push(root);
    const queue = new PromptQueueStore(join(root, "queue.db"));
    const store = new SessionDispatchStore(join(root, "dispatch.db"));
    const inbox = new SessionDispatchInboxCoordinator(store);
    let now = new Date("2026-01-01T00:00:00.000Z");
    let discoveryAttempts = 0;
    const supervisor = session("supervisor");
    const worker = { ...session("worker"), agent: "codex", metadata: { agentTransport: "agentapi" } } as any;
    const sessions = new Map([["supervisor", supervisor], ["worker", worker]]);
    const manager = { getSession: (id: string) => sessions.get(id),
      getAdapter: (id: string) => id === "worker"
        ? { deliversPromptsDirectly: () => false, fetchStatus: async () => "stable", fetchMessages: async () => [] }
        : null,
      createSession: async () => worker,
      captureAgentapiCodexSessionIdFromPrompt: async () => {
        discoveryAttempts += 1;
        if (discoveryAttempts < 2) return false;
        worker.metadata.nativeAgentSession = { agent: "codex", sessionId: "native-worker",
          workingDirectory: "/repo", capturedAt: now.toISOString(), source: "agentapi" };
        return true;
      } } as any;
    const service = new SessionDispatchService(store, manager, queue, () => {}, {
      now: () => now, nativeDiscoveryRetryInitialMs: 1_000, nativeDiscoveryRetryMaxMs: 1_000,
    }, () => {}, inbox);
    const created = await service.create({ agent: "codex", prompt: "Build it", callbackEnabled: true,
      callbackSessionId: "supervisor" });

    await service.checkRunning();
    expect(service.get(created.dispatchId)).toMatchObject({ state: "running", nativeDiscoveryAttemptCount: 1,
      nativeDiscoveryLastError: "Codex native transcript is not available yet" });
    now = new Date(now.getTime() + 1_000);
    await service.checkRunning();
    expect(discoveryAttempts).toBe(2);
    expect(service.get(created.dispatchId)).toMatchObject({ state: "running", nativeDiscoveryAttemptCount: 2,
      nativeDiscoveryLastError: null });
  });
});
