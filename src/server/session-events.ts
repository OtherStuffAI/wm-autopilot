/**
 * SSE proxy for session events from AgentAPI or native adapters.
 * Proxies /api/sessions/:id/events to either the agent's /events endpoint
 * or an adapter-native event subscription.
 */

import type { AgentAdapter } from "../agents/agent-adapter";
import type { ProcessManager } from "../agents/process-manager";

export interface SessionEventsOptions {
  manager: ProcessManager;
  agentHost: string;
  /** Interval in ms for sending SSE keepalive comments (default: 30000) */
  sseKeepaliveIntervalMs?: number;
  upstreamConnectTimeoutMs?: number;
  subscribeToMessageUpdates?: (sessionId: string, listener: () => void) => () => void;
}

interface SseControllerState {
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  encoder: TextEncoder;
}

const DEFAULT_KEEPALIVE_INTERVAL_MS = 30000;
const DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS = 5000;
const UPSTREAM_RETRY_BASE_DELAY_MS = 1000;
const UPSTREAM_RETRY_MAX_DELAY_MS = 10000;
const SESSION_POLL_INTERVAL_MS = 2000;
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createSseWriters(state: SseControllerState) {
  function writeComment(comment: string) {
    if (!state.controller) {
      return;
    }
    state.controller.enqueue(state.encoder.encode(`: ${comment}\n\n`));
  }

  function writeEvent(event: string, payload: Record<string, unknown>) {
    if (!state.controller) {
      return;
    }
    state.controller.enqueue(
      state.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
    );
  }

  return { writeComment, writeEvent };
}

function createSseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { headers: SSE_HEADERS });
}

function createHeartbeatOnlyStream(
  sessionId: string,
  request: Request,
  manager: ProcessManager,
  keepaliveMs: number,
  subscribeToMessageUpdates?: SessionEventsOptions["subscribeToMessageUpdates"],
): Response {
  const state: SseControllerState = {
    controller: null,
    encoder: new TextEncoder(),
  };
  const { writeComment, writeEvent } = createSseWriters(state);
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeMessageUpdates: (() => void) | null = null;

  function cleanup() {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    unsubscribeMessageUpdates?.();
    unsubscribeMessageUpdates = null;
    if (state.controller) {
      try {
        state.controller.close();
      } catch {}
      state.controller = null;
    }
  }

  request.signal.addEventListener("abort", cleanup, { once: true });

  return createSseResponse(
    new ReadableStream({
      start(controller) {
        state.controller = controller;
        writeComment("connected (native-sdk)");
        writeEvent("transport", { mode: "heartbeat-only" });
        unsubscribeMessageUpdates = subscribeToMessageUpdates?.(sessionId, () => {
          writeEvent("refresh", { sessionId, reason: "messages-updated" });
        }) ?? null;

        keepaliveTimer = setInterval(() => {
          try {
            writeEvent("heartbeat", { ts: Date.now() });
          } catch {
            cleanup();
          }
        }, keepaliveMs);

        pollTimer = setInterval(() => {
          const session = manager.getSession(sessionId);
          if (!session || session.status !== "running") {
            try {
              writeEvent("status", { type: "session_stopped", sessionId });
            } catch {}
            cleanup();
          }
        }, SESSION_POLL_INTERVAL_MS);
      },
      cancel() {
        cleanup();
      },
    }),
  );
}

function createNativeAdapterStream(
  sessionId: string,
  request: Request,
  manager: ProcessManager,
  adapter: AgentAdapter,
  keepaliveMs: number,
  subscribeToMessageUpdates?: SessionEventsOptions["subscribeToMessageUpdates"],
): Response {
  const state: SseControllerState = {
    controller: null,
    encoder: new TextEncoder(),
  };
  const { writeComment, writeEvent } = createSseWriters(state);
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeMessageUpdates: (() => void) | null = null;

  function cleanup() {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    unsubscribeMessageUpdates?.();
    unsubscribeMessageUpdates = null;
    if (state.controller) {
      try {
        state.controller.close();
      } catch {}
      state.controller = null;
    }
  }

  request.signal.addEventListener("abort", cleanup, { once: true });

  return createSseResponse(
    new ReadableStream({
      start(controller) {
        state.controller = controller;
        writeComment("connected (native-adapter)");
        writeEvent("transport", { mode: "event-stream" });
        unsubscribeMessageUpdates = subscribeToMessageUpdates?.(sessionId, () => {
          writeEvent("refresh", { sessionId, reason: "messages-updated" });
        }) ?? null;

        unsubscribe = adapter.subscribeToEvents?.((event) => {
          if (event.type === "message") {
            writeEvent("message", event.message as unknown as Record<string, unknown>);
            return;
          }
          if (event.type === "permission") {
            writeEvent("permission", event.permission as unknown as Record<string, unknown>);
            return;
          }
          writeEvent("status", {
            status: event.status,
            agent_status: event.status,
          });
        }) ?? null;

        keepaliveTimer = setInterval(() => {
          try {
            writeEvent("heartbeat", { ts: Date.now() });
          } catch {
            cleanup();
          }
        }, keepaliveMs);

        pollTimer = setInterval(() => {
          const session = manager.getSession(sessionId);
          if (!session || session.status !== "running") {
            try {
              writeEvent("status", { type: "session_stopped", sessionId });
            } catch {}
            cleanup();
          }
        }, SESSION_POLL_INTERVAL_MS);
      },
      cancel() {
        cleanup();
      },
    }),
  );
}

function createUpstreamProxyStream(
  sessionId: string,
  request: Request,
  manager: ProcessManager,
  agentEventsUrl: URL,
  keepaliveMs: number,
  connectTimeoutMs: number,
  subscribeToMessageUpdates?: SessionEventsOptions["subscribeToMessageUpdates"],
): Response {
  const abortController = new AbortController();
  const state: SseControllerState = {
    controller: null,
    encoder: new TextEncoder(),
  };
  const { writeComment, writeEvent } = createSseWriters(state);
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeMessageUpdates: (() => void) | null = null;

  request.signal.addEventListener("abort", () => {
    abortController.abort();
  }, { once: true });

  async function readUpstreamStream(reader: any) {
    try {
      while (state.controller && !abortController.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        if (value && state.controller) {
          state.controller.enqueue(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  async function pumpUpstreamWithReconnect() {
    let attempt = 0;
    while (state.controller && !abortController.signal.aborted) {
      const currentSession = manager.getSession(sessionId);
      if (!currentSession || currentSession.status !== "running") {
        writeEvent("status", { type: "session_stopped", sessionId });
        break;
      }

      let cleanupAttempt = () => {};
      try {
        const attemptController = new AbortController();
        const abortAttempt = () => attemptController.abort();
        abortController.signal.addEventListener("abort", abortAttempt, { once: true });
        const connectTimeout = setTimeout(abortAttempt, connectTimeoutMs);
        cleanupAttempt = () => {
          clearTimeout(connectTimeout);
          abortController.signal.removeEventListener("abort", abortAttempt);
        };
        let agentResponse: Response;
        try {
          agentResponse = await fetch(agentEventsUrl.toString(), {
            signal: attemptController.signal,
            headers: { Accept: "text/event-stream" },
          });
        } finally {
          clearTimeout(connectTimeout);
        }

        if (!agentResponse.ok || !agentResponse.body) {
          const statusCode = agentResponse.status;
          attempt += 1;
          const delayMs = Math.min(
            UPSTREAM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
            UPSTREAM_RETRY_MAX_DELAY_MS,
          );
          console.warn(
            `[session-events] Upstream unavailable for ${sessionId} (status ${statusCode}), retry in ${delayMs}ms`,
          );
          writeEvent("status", {
            type: "upstream_unavailable",
            sessionId,
            status: statusCode,
            retryInMs: delayMs,
          });
          await sleep(delayMs);
          continue;
        }

        attempt = 0;
        writeComment("upstream-connected");
        writeEvent("transport", { mode: "event-stream", reconnected: true });
        await readUpstreamStream(agentResponse.body.getReader());
        writeComment("upstream-disconnected");
        attempt += 1;
        const delayMs = Math.min(
          UPSTREAM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          UPSTREAM_RETRY_MAX_DELAY_MS,
        );
        writeEvent("status", {
          type: "upstream_unavailable",
          sessionId,
          reason: "stream-ended",
          retryInMs: delayMs,
        });
        await sleep(delayMs);
      } catch (error: any) {
        if (error?.name === "AbortError" && abortController.signal.aborted) {
          break;
        }
        attempt += 1;
        const delayMs = Math.min(
          UPSTREAM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          UPSTREAM_RETRY_MAX_DELAY_MS,
        );
        console.error(`[session-events] Upstream stream error for ${sessionId}:`, error?.message || error);
        writeEvent("status", {
          type: "upstream_error",
          sessionId,
          message: error?.message || String(error),
          retryInMs: delayMs,
        });
        await sleep(delayMs);
      } finally {
        cleanupAttempt();
      }
    }
  }

  return createSseResponse(
    new ReadableStream({
      start(controller) {
        state.controller = controller;
        writeComment("connected");
        writeEvent("transport", { mode: "event-stream" });
        unsubscribeMessageUpdates = subscribeToMessageUpdates?.(sessionId, () => {
          writeEvent("refresh", { sessionId, reason: "messages-updated" });
        }) ?? null;

        keepaliveTimer = setInterval(() => {
          try {
            writeEvent("heartbeat", { ts: Date.now() });
          } catch {
            if (keepaliveTimer) {
              clearInterval(keepaliveTimer);
              keepaliveTimer = null;
            }
          }
        }, keepaliveMs);

        pumpUpstreamWithReconnect().finally(() => {
          if (state.controller) {
            try {
              state.controller.close();
            } catch {}
            state.controller = null;
          }
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          unsubscribeMessageUpdates?.();
          unsubscribeMessageUpdates = null;
        });
      },
      cancel() {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        state.controller = null;
        unsubscribeMessageUpdates?.();
        unsubscribeMessageUpdates = null;
        abortController.abort();
      },
    }),
  );
}

export function createSessionEventsHandler(options: SessionEventsOptions) {
  const {
    manager,
    sseKeepaliveIntervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS,
    upstreamConnectTimeoutMs = DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS,
    subscribeToMessageUpdates,
  } = options;

  return async function handleSessionEvents(
    sessionId: string,
    request: Request,
  ): Promise<Response> {
    const session = manager.getSession(sessionId);
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    if (session.status !== "running") {
      return Response.json({ error: "Session not running" }, { status: 400 });
    }

    const adapter = manager.getAdapter(sessionId);
    const agentEventsUrl = adapter?.getEventsUrl() ?? null;
    if (agentEventsUrl) {
      try {
        await adapter!.fetchStatus(3000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: `Agent stream unavailable: ${message}` }, { status: 502 });
      }
      return createUpstreamProxyStream(
        sessionId,
        request,
        manager,
        agentEventsUrl,
        sseKeepaliveIntervalMs,
        upstreamConnectTimeoutMs,
        subscribeToMessageUpdates,
      );
    }

    if (adapter?.subscribeToEvents) {
      return createNativeAdapterStream(
        sessionId,
        request,
        manager,
        adapter,
        sseKeepaliveIntervalMs,
        subscribeToMessageUpdates,
      );
    }

    return createHeartbeatOnlyStream(
      sessionId,
      request,
      manager,
      sseKeepaliveIntervalMs,
      subscribeToMessageUpdates,
    );
  };
}
