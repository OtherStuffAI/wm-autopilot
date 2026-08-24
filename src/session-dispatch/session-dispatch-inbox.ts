import type { SessionDispatch, CallbackWakeRecord } from "./session-dispatch-store";
import { SessionDispatchStore } from "./session-dispatch-store";
import type { PromptQueueStore } from "../storage/prompt-queue-store";

export const DISPATCH_INBOX_WAKE_PROMPT = `You have unresolved supervised-dispatch callbacks.

Use the session dispatch inbox tool to read the current unresolved callbacks. Review each result and supporting evidence, take the required reporting or follow-up action, then acknowledge and close the callbacks you have handled. Do not assume a worker's completion claim is automatically accepted.`;

export interface DispatchInboxWakePolicy {
  now?: () => Date;
  maxAttempts?: number;
  leaseMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
}

export interface DispatchInboxWakeClaim {
  callbackSessionId: string;
  inboxFingerprint: string;
  attemptCount: number;
  prompt: string;
}

export interface DispatchCallbackInbox {
  callbacks: SessionDispatch[];
  wake: CallbackWakeRecord | null;
  inboxFingerprint: string | null;
}

const DEFAULT_POLICY = {
  maxAttempts: 3,
  leaseMs: 5 * 60_000,
  retryInitialMs: 5_000,
  retryMaxMs: 5 * 60_000,
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveDispatchInboxWakePolicy(env: Record<string, string | undefined>): DispatchInboxWakePolicy {
  const read = (key: string) => env[key] ?? env[`WINGMAN_${key}`];
  return {
    maxAttempts: positiveInteger(read("DISPATCH_INBOX_WAKE_MAX_ATTEMPTS"), DEFAULT_POLICY.maxAttempts),
    leaseMs: positiveInteger(read("DISPATCH_INBOX_WAKE_LEASE_MS"), DEFAULT_POLICY.leaseMs),
    retryInitialMs: positiveInteger(read("DISPATCH_INBOX_WAKE_RETRY_INITIAL_MS"), DEFAULT_POLICY.retryInitialMs),
    retryMaxMs: positiveInteger(read("DISPATCH_INBOX_WAKE_RETRY_MAX_MS"), DEFAULT_POLICY.retryMaxMs),
  };
}

export class SessionDispatchInboxCoordinator {
  constructor(private readonly store: SessionDispatchStore, private readonly policy: DispatchInboxWakePolicy = {}) {}

  inspect(callbackSessionId: string): DispatchCallbackInbox {
    return {
      callbacks: this.store.listUnresolvedCallbacks(callbackSessionId),
      wake: this.store.getWake(callbackSessionId),
      inboxFingerprint: this.store.getInboxFingerprint(callbackSessionId),
    };
  }

  migrateLegacyCallbacks(promptQueue: PromptQueueStore): { removedPromptRows: number; recoveredDispatches: number } {
    return {
      removedPromptRows: promptQueue.deletePromptsByType("dispatch_callback"),
      recoveredDispatches: this.store.migrateLegacyDeliveredCallbacks(),
    };
  }

  hasUnresolved(callbackSessionId: string): boolean {
    return this.store.getInboxFingerprint(callbackSessionId) !== null;
  }

  noteSessionBusy(callbackSessionId: string): void {
    const wake = this.store.getWake(callbackSessionId);
    if (!wake || wake.state !== "submitted" || wake.busyObservedAt) return;
    this.store.saveWake({ ...wake, busyObservedAt: this.now().toISOString() });
  }

  claimForStableSession(callbackSessionId: string): DispatchInboxWakeClaim | null {
    const now = this.now();
    const fingerprint = this.store.getInboxFingerprint(callbackSessionId);
    if (!fingerprint) {
      const wake = this.store.getWake(callbackSessionId);
      if (wake && wake.state !== "resolved") {
        this.store.saveWake({ ...wake, state: "resolved", claimedAt: null, submittedAt: null,
          busyObservedAt: null, leaseExpiresAt: null, nextRetryAt: null, lastError: null,
          updatedAt: now.toISOString() });
      }
      return null;
    }

    let wake = this.store.getWake(callbackSessionId);
    if (wake?.state === "claimed" && this.leaseExpired(wake, now)) {
      wake = this.recordFailedAttempt(wake, "Wake claim lease expired before submission", now);
    } else if (wake?.state === "submitted") {
      if (!wake.busyObservedAt && !this.leaseExpired(wake, now)) return null;
      wake = this.completeSubmittedTurn(wake, fingerprint, now);
    }

    if (wake?.state === "claimed" || wake?.state === "submitted") return null;
    if (wake?.state === "blocked" && wake.inboxFingerprint === fingerprint) return null;
    if (wake?.nextRetryAt && now < new Date(wake.nextRetryAt)) return null;

    const claimed = this.store.claimWake(callbackSessionId, fingerprint, now.toISOString(),
      this.addMs(now, this.value("leaseMs")).toISOString());
    return claimed ? { callbackSessionId, inboxFingerprint: fingerprint,
      attemptCount: claimed.attemptCount, prompt: DISPATCH_INBOX_WAKE_PROMPT } : null;
  }

  markSubmitted(claim: DispatchInboxWakeClaim): void {
    const wake = this.store.getWake(claim.callbackSessionId);
    if (!wake || wake.state !== "claimed" || wake.inboxFingerprint !== claim.inboxFingerprint) return;
    this.store.saveWake({ ...wake, state: "submitted", submittedAt: this.now().toISOString(), lastError: null });
  }

  markSubmissionFailed(claim: DispatchInboxWakeClaim, error: string): void {
    const wake = this.store.getWake(claim.callbackSessionId);
    if (!wake || wake.state !== "claimed" || wake.inboxFingerprint !== claim.inboxFingerprint) return;
    this.recordFailedAttempt(wake, error, this.now());
  }

  private completeSubmittedTurn(wake: CallbackWakeRecord, currentFingerprint: string, now: Date): CallbackWakeRecord {
    if (wake.inboxFingerprint !== currentFingerprint) {
      return this.store.saveWake({ ...wake, inboxFingerprint: currentFingerprint, state: "pending",
        attemptCount: 0, claimedAt: null, submittedAt: null, busyObservedAt: null,
        leaseExpiresAt: null, nextRetryAt: null, lastError: null, updatedAt: now.toISOString() });
    }
    if (wake.attemptCount >= this.value("maxAttempts")) {
      return this.store.saveWake({ ...wake, state: "blocked", leaseExpiresAt: null, nextRetryAt: null,
        lastError: `Inbox remained unchanged after ${wake.attemptCount} wake turns`, updatedAt: now.toISOString() });
    }
    return this.store.saveWake({ ...wake, state: "pending", claimedAt: null, submittedAt: null,
      busyObservedAt: null, leaseExpiresAt: null,
      nextRetryAt: this.addMs(now, this.retryDelayMs(wake.attemptCount)).toISOString(),
      lastError: "Previous wake turn made no inbox progress", updatedAt: now.toISOString() });
  }

  private recordFailedAttempt(wake: CallbackWakeRecord, error: string, now: Date): CallbackWakeRecord {
    if (wake.attemptCount >= this.value("maxAttempts")) {
      return this.store.saveWake({ ...wake, state: "blocked", leaseExpiresAt: null, nextRetryAt: null,
        lastError: error, updatedAt: now.toISOString() });
    }
    return this.store.saveWake({ ...wake, state: "pending", claimedAt: null, submittedAt: null,
      busyObservedAt: null, leaseExpiresAt: null,
      nextRetryAt: this.addMs(now, this.retryDelayMs(wake.attemptCount)).toISOString(),
      lastError: error, updatedAt: now.toISOString() });
  }

  private retryDelayMs(attempts: number): number {
    return Math.min(this.value("retryInitialMs") * (2 ** Math.max(0, attempts - 1)), this.value("retryMaxMs"));
  }

  private leaseExpired(wake: CallbackWakeRecord, now: Date): boolean {
    return Boolean(wake.leaseExpiresAt && now >= new Date(wake.leaseExpiresAt));
  }

  private value(key: keyof typeof DEFAULT_POLICY): number {
    return this.policy[key] ?? DEFAULT_POLICY[key];
  }

  private now(): Date {
    return this.policy.now?.() ?? new Date();
  }

  private addMs(date: Date, milliseconds: number): Date {
    return new Date(date.getTime() + milliseconds);
  }
}
