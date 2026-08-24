/**
 * Session Broadcaster — SSE push for session lifecycle events.
 *
 * Browsers subscribe via GET /api/sessions/subscribe after login.
 * Events are scoped per-npub: a user only receives events for their
 * own sessions (start / stop / update).
 */

interface Subscriber {
  npub: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  createdAt: number;
}

export interface SessionEvent {
  type: "session-started" | "session-stopped" | "session-updated" | "session-deleted";
  sessionId: string;
  agent?: string;
  name?: string;
  status?: string;
  artifactIntent?: {
    action: "open";
    filePath: string;
    pinnedFiles: string[];
  };
}

const encoder = new TextEncoder();
const SSE_KEEPALIVE_INTERVAL_MS = 30_000;

class SessionBroadcaster {
  private subscribers = new Map<string, Subscriber[]>();

  /** Register a browser SSE subscriber for an npub. */
  add(npub: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (!this.subscribers.has(npub)) {
      this.subscribers.set(npub, []);
    }
    this.subscribers.get(npub)!.push({ npub, controller, createdAt: Date.now() });
    console.log(
      `[session-broadcast] Subscribed ${npub.slice(0, 20)}… (${this.countForNpub(npub)} active)`,
    );
  }

  /** Remove a subscriber when the SSE connection closes. */
  remove(npub: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
    const subs = this.subscribers.get(npub);
    if (!subs) return;
    const idx = subs.findIndex((s) => s.controller === controller);
    if (idx !== -1) subs.splice(idx, 1);
    if (subs.length === 0) this.subscribers.delete(npub);
    console.log(
      `[session-broadcast] Unsubscribed ${npub.slice(0, 20)}… (${this.countForNpub(npub)} active)`,
    );
  }

  /** Broadcast a session event to all subscribers for an npub. */
  broadcast(npub: string, event: SessionEvent): void {
    const subs = this.subscribers.get(npub);
    if (!subs || subs.length === 0) return;

    const data = `data: ${JSON.stringify(event)}\n\n`;
    const encoded = encoder.encode(data);

    for (const sub of subs) {
      try {
        sub.controller.enqueue(encoded);
      } catch {
        // subscriber disconnected — cleaned up on cancel
      }
    }
  }

  private countForNpub(npub: string): number {
    return this.subscribers.get(npub)?.length ?? 0;
  }
}

export const sessionBroadcaster = new SessionBroadcaster();

/**
 * Create an SSE Response for GET /api/sessions/subscribe.
 * Caller must validate authentication and pass the viewer npub.
 */
export function createSessionSubscribeResponse(npub: string): Response {
  let subscriberController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  return new Response(
    new ReadableStream({
      start(controller) {
        subscriberController = controller;
        sessionBroadcaster.add(npub, controller);

        controller.enqueue(encoder.encode(": connected\n\n"));

        keepaliveTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            if (keepaliveTimer) {
              clearInterval(keepaliveTimer);
              keepaliveTimer = null;
            }
          }
        }, SSE_KEEPALIVE_INTERVAL_MS);
      },
      cancel() {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        if (subscriberController) {
          sessionBroadcaster.remove(npub, subscriberController);
          subscriberController = null;
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
}
