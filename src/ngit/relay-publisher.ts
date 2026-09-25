/** Shared NIP-01 relay publication and query helpers. */

import { SimplePool } from "nostr-tools";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignedEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface PublishResult {
  successes: number;
  failures: number;
  results: RelayResult[];
}

export type RelayPublishState = "accepted" | "rejected" | "connection_failure" | "timeout" | "protocol_failure";

export interface RelayResult {
  relay: string;
  ok: boolean;
  state: RelayPublishState;
  message?: string;
  error?: string;
  acknowledgedEventId?: string;
}

export interface PublishOptions {
  timeoutMs?: number;
  WebSocketClass?: typeof WebSocket;
}

export const DEFAULT_PUBLISH_ACK_TIMEOUT_MS = 60_000;

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === "string" && value.length > 0 ? value : "Unknown error";
}

export function publishToRelayWithAcknowledgement(
  event: SignedEvent,
  relay: string,
  options: PublishOptions = {},
): Promise<RelayResult> {
  const WebSocketClass = options.WebSocketClass ?? WebSocket;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PUBLISH_ACK_TIMEOUT_MS;

  return new Promise((resolve) => {
    let socket: WebSocket | null = null;
    let opened = false;
    let settled = false;

    const finish = (result: RelayResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // The constructor may have failed before a socket existed.
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({
      relay,
      ok: false,
      state: "timeout",
      error: `Timed out waiting ${timeoutMs}ms for matching NIP-01 OK`,
    }), timeoutMs);

    try {
      socket = new WebSocketClass(relay);
    } catch (error) {
      finish({ relay, ok: false, state: "connection_failure", error: errorMessage(error) });
      return;
    }

    socket.addEventListener("open", () => {
      opened = true;
      try {
        socket.send(JSON.stringify(["EVENT", event]));
      } catch (error) {
        finish({ relay, ok: false, state: "connection_failure", error: errorMessage(error) });
      }
    });
    socket.addEventListener("message", (message) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!Array.isArray(frame) || frame[0] !== "OK") return;
      const acknowledgedEventId = typeof frame[1] === "string" ? frame[1] : "";
      const accepted = frame[2] === true;
      const relayMessage = typeof frame[3] === "string" ? frame[3] : "";
      if (acknowledgedEventId !== event.id) {
        finish({
          relay,
          ok: false,
          state: "protocol_failure",
          acknowledgedEventId,
          error: `Relay acknowledged mismatched event id ${acknowledgedEventId || "<missing>"}`,
        });
      } else if (!accepted) {
        finish({
          relay,
          ok: false,
          state: "rejected",
          acknowledgedEventId,
          message: relayMessage,
          error: relayMessage || "Relay rejected the event",
        });
      } else {
        finish({ relay, ok: true, state: "accepted", acknowledgedEventId, message: relayMessage });
      }
    });
    socket.addEventListener("error", () => {
      finish({ relay, ok: false, state: "connection_failure", error: "WebSocket connection failed" });
    });
    socket.addEventListener("close", () => {
      if (!settled) {
        finish({
          relay,
          ok: false,
          state: "connection_failure",
          error: opened ? "Relay closed before sending a matching NIP-01 OK" : "WebSocket connection failed",
        });
      }
    });
  });
}

export async function publishToRelays(
  event: SignedEvent,
  relays: string[],
  options: PublishOptions = {},
): Promise<PublishResult> {
  const results = await Promise.all(relays.map((relay) => publishToRelayWithAcknowledgement(event, relay, options)));
  const successes = results.filter((result) => result.ok).length;
  return { successes, failures: results.length - successes, results };
}

/**
 * Query relays for events matching a filter.
 *
 * Thin wrapper around SimplePool.querySync for reading NIP-34 events.
 */
export async function queryRelays(
  relays: string[],
  filter: { ids?: string[]; kinds?: number[]; authors?: string[]; "#d"?: string[]; "#a"?: string[]; limit?: number },
  maxWaitMs?: number,
): Promise<SignedEvent[]> {
  if (relays.length === 0) return [];

  const pool = new SimplePool();
  try {
    const events = await pool.querySync(relays, filter, maxWaitMs ? { maxWait: maxWaitMs } : undefined);
    return events as unknown as SignedEvent[];
  } finally {
    pool.close(relays);
  }
}
