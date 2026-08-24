/**
 * Browser SSE subscriber manager for NIP-98 signing.
 *
 * Browsers subscribe via GET /api/mcp/nip98/subscribe after login.
 * When a Tier 2 sign request comes in, we push the event template
 * to all active browser subscribers for that npub.
 */

interface Subscriber {
  npub: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  createdAt: number;
}

const encoder = new TextEncoder();

class BrowserSubscriberStore {
  private subscribers = new Map<string, Subscriber[]>();

  /** Register a new browser SSE subscriber for an npub. */
  add(npub: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (!this.subscribers.has(npub)) {
      this.subscribers.set(npub, []);
    }
    this.subscribers.get(npub)!.push({ npub, controller, createdAt: Date.now() });
    console.log(`[nip98-subscribe] Browser subscribed for ${npub.slice(0, 20)}… (${this.countForNpub(npub)} active)`);
  }

  /** Remove a subscriber when the SSE connection closes. */
  remove(npub: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
    const subs = this.subscribers.get(npub);
    if (!subs) return;
    const idx = subs.findIndex((s) => s.controller === controller);
    if (idx !== -1) subs.splice(idx, 1);
    if (subs.length === 0) this.subscribers.delete(npub);
    console.log(`[nip98-subscribe] Browser unsubscribed for ${npub.slice(0, 20)}… (${this.countForNpub(npub)} active)`);
  }

  /** Send an SSE event to all subscribers for an npub. Returns true if at least one received it. */
  send(npub: string, event: Record<string, unknown>): boolean {
    const subs = this.subscribers.get(npub);
    if (!subs || subs.length === 0) return false;

    const data = `data: ${JSON.stringify(event)}\n\n`;
    const encoded = encoder.encode(data);
    let delivered = false;

    for (const sub of subs) {
      try {
        sub.controller.enqueue(encoded);
        delivered = true;
      } catch {
        // subscriber disconnected — will be cleaned up on cancel
      }
    }

    return delivered;
  }

  /** Check whether any browser is listening for this npub. */
  hasSubscriber(npub: string): boolean {
    const subs = this.subscribers.get(npub);
    return Boolean(subs && subs.length > 0);
  }

  /** Count active subscribers for an npub. */
  private countForNpub(npub: string): number {
    return this.subscribers.get(npub)?.length ?? 0;
  }
}

export const browserSubscribers = new BrowserSubscriberStore();
