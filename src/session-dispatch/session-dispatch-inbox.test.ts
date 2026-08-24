import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptQueueStore } from "../storage/prompt-queue-store";
import { SessionDispatchInboxCoordinator } from "./session-dispatch-inbox";
import { SessionDispatchStore } from "./session-dispatch-store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dispatch-inbox-")); roots.push(root);
  const path = join(root, "dispatch.db");
  const store = new SessionDispatchStore(path);
  let now = new Date("2026-08-20T00:00:00.000Z");
  const policy = { now: () => now, maxAttempts: 3, leaseMs: 100, retryInitialMs: 1, retryMaxMs: 1 };
  const inbox = new SessionDispatchInboxCoordinator(store, policy);
  let number = 0;
  const addCallback = (state: "callback_pending" | "callback_delivered" = "callback_pending") => {
    const index = ++number;
    return store.create({ workerSessionId: `worker-${index}`, callbackSessionId: "supervisor",
      ownerNpub: "npub1owner", state, prompt: `Work ${index}`, promptQueuedAt: now.toISOString(),
      reportingContext: { taskId: `task-${index}` }, terminalStatus: "completed", terminalMessage: `Done ${index}`,
      terminalMessageCreatedAt: now.toISOString(), terminalFingerprint: `fingerprint-${index}`,
      callbackPrompt: state === "callback_delivered" ? `Legacy ${index}` : null,
      nativeDiscoveryStartedAt: null, nativeDiscoveryNextAttemptAt: null,
      nativeDiscoveryAttemptCount: 0, nativeDiscoveryLastError: null,
      callbackAttemptCount: 0, callbackNextAttemptAt: null, callbackExpiresAt: null,
      callbackQueuedAt: null, callbackAcknowledgedAt: null, closedAt: null, lastError: null });
  };
  return { root, path, store, inbox, policy, addCallback,
    advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); } };
}

describe("SessionDispatchInboxCoordinator", () => {
  test("atomically claims at most one wake for one unchanged inbox", () => {
    const f = fixture();
    f.addCallback();
    const first = f.inbox.claimForStableSession("supervisor");
    const racing = f.inbox.claimForStableSession("supervisor");
    expect(first).not.toBeNull();
    expect(racing).toBeNull();
    expect(first?.prompt).toContain("read the current unresolved callbacks");
    expect(first?.prompt).not.toContain("worker-1");
  });

  test("does not overlap when callbacks enlarge an active wake inbox", () => {
    const f = fixture();
    f.addCallback();
    const first = f.inbox.claimForStableSession("supervisor")!;
    f.inbox.markSubmitted(first);
    f.addCallback();
    expect(f.inbox.claimForStableSession("supervisor")).toBeNull();
    f.inbox.noteSessionBusy("supervisor");
    expect(f.inbox.claimForStableSession("supervisor")).not.toBeNull();
    expect(f.inbox.inspect("supervisor").callbacks).toHaveLength(2);
  });

  test("survives restart leases and retries a failed claim with bounded backoff", () => {
    const f = fixture();
    f.addCallback();
    const first = f.inbox.claimForStableSession("supervisor")!;
    const restarted = new SessionDispatchInboxCoordinator(new SessionDispatchStore(f.path), f.policy);
    expect(restarted.claimForStableSession("supervisor")).toBeNull();
    f.advance(100);
    expect(restarted.claimForStableSession("supervisor")).toBeNull();
    f.advance(1);
    const retried = restarted.claimForStableSession("supervisor");
    expect(retried?.attemptCount).toBe(2);
    expect(first.inboxFingerprint).toBe(retried?.inboxFingerprint);
  });

  test("blocks an unchanged inbox after the configured wake-turn limit", () => {
    const f = fixture();
    f.addCallback();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = f.inbox.claimForStableSession("supervisor")!;
      expect(claim.attemptCount).toBe(attempt);
      f.inbox.markSubmitted(claim);
      f.inbox.noteSessionBusy("supervisor");
      expect(f.inbox.claimForStableSession("supervisor")).toBeNull();
      f.advance(1);
    }
    expect(f.inbox.claimForStableSession("supervisor")).toBeNull();
    expect(f.inbox.inspect("supervisor").wake).toMatchObject({ state: "blocked", attemptCount: 3,
      lastError: "Inbox remained unchanged after 3 wake turns" });
  });

  test("acknowledgement progress changes the fingerprint and clears wake need", () => {
    const f = fixture();
    const callback = f.addCallback();
    const claim = f.inbox.claimForStableSession("supervisor")!;
    f.inbox.markSubmitted(claim);
    f.inbox.noteSessionBusy("supervisor");
    f.store.update(callback.dispatchId, { state: "acknowledged", callbackAcknowledgedAt: "2026-08-20T00:00:01Z" });
    expect(f.inbox.claimForStableSession("supervisor")).toBeNull();
    expect(f.inbox.hasUnresolved("supervisor")).toBeFalse();
    expect(f.inbox.inspect("supervisor").wake?.state).toBe("resolved");
  });

  test("migration removes only typed legacy prompts and recovers delivered callbacks", () => {
    const f = fixture();
    const queue = new PromptQueueStore(join(f.root, "queue.db"));
    queue.addPrompt("supervisor", { content: "human", type: "human" });
    queue.addPrompt("supervisor", { content: "untyped" });
    queue.addPrompt("supervisor", { content: "legacy callback", type: "dispatch_callback" });
    const legacy = f.addCallback("callback_delivered");

    expect(f.inbox.migrateLegacyCallbacks(queue)).toEqual({ removedPromptRows: 1, recoveredDispatches: 1 });
    expect(queue.getSessionQueue("supervisor").map((prompt) => prompt.content)).toEqual(["human", "untyped"]);
    expect(f.store.get(legacy.dispatchId)?.state).toBe("callback_pending");
    expect(f.inbox.migrateLegacyCallbacks(queue)).toEqual({ removedPromptRows: 0, recoveredDispatches: 0 });
  });
});
