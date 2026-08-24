/**
 * In-memory store for pending Tier 2 NIP-98 sign requests.
 *
 * When an agent requests a Tier 2 signature, we create a pending request
 * and park the HTTP response until the browser signs and posts back.
 */

import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 60_000; // 60 seconds

interface PendingRequest {
  requestId: string;
  npub: string;
  resolve: (signedEvent: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  createdAt: number;
}

class PendingSignRequestStore {
  private requests = new Map<string, PendingRequest>();

  /** Create a pending request and return a promise that resolves when the browser signs it. */
  create(
    npub: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): { requestId: string; promise: Promise<Record<string, unknown>> } {
    const requestId = randomUUID();

    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.requests.delete(requestId);
        reject(new Error("Browser signing request timed out — no active browser session or user did not respond"));
      }, timeoutMs);

      this.requests.set(requestId, {
        requestId,
        npub,
        resolve,
        reject,
        timeout,
        createdAt: Date.now(),
      });
    });

    return { requestId, promise };
  }

  /** Resolve a pending request with a signed event. Returns false if not found. */
  resolve(requestId: string, signedEvent: Record<string, unknown>): boolean {
    const pending = this.requests.get(requestId);
    if (!pending) return false;

    clearTimeout(pending.timeout);
    this.requests.delete(requestId);
    pending.resolve(signedEvent);
    return true;
  }

  /** Reject a pending request with an error. Returns false if not found. */
  reject(requestId: string, error: string): boolean {
    const pending = this.requests.get(requestId);
    if (!pending) return false;

    clearTimeout(pending.timeout);
    this.requests.delete(requestId);
    pending.reject(new Error(error));
    return true;
  }

  /** Check if any browser is needed for a given npub. */
  hasPendingForNpub(npub: string): boolean {
    for (const req of this.requests.values()) {
      if (req.npub === npub) return true;
    }
    return false;
  }
}

export const pendingSignRequests = new PendingSignRequestStore();
