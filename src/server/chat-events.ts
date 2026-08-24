/**
 * SSE streaming for chat responses from Maple Proxy.
 * Handles streaming chat completions to the client via Server-Sent Events.
 */

import type { WingmanConfig } from "../config";
import {
  getChatSession,
  sendChatMessage,
  canAccessChatSession,
} from "../chat/chat-session-manager";

export interface ChatEventsOptions {
  config: WingmanConfig;
  /** Interval in ms for sending SSE keepalive comments (default: 30000) */
  sseKeepaliveIntervalMs?: number;
  /** Optional callback to record token usage for billing/analytics */
  recordUsage?: (data: { sessionId: string; model: string; inputTokens: number; outputTokens: number }) => Promise<void>;
}

const DEFAULT_KEEPALIVE_INTERVAL_MS = 30000;

/**
 * Creates a handler for streaming chat message responses.
 */
export function createChatMessageStreamHandler(options: ChatEventsOptions) {
  const { config, sseKeepaliveIntervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS, recordUsage } = options;

  return async function handleChatMessageStream(
    chatId: string,
    userContent: string,
    npub: string | null,
    isAdmin: boolean,
    request: Request
  ): Promise<Response> {
    const session = getChatSession(chatId);
    if (!session) {
      return Response.json({ error: "Chat not found" }, { status: 404 });
    }

    if (!canAccessChatSession(session, npub, isAdmin)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    // Abort controller for cleanup
    const abortController = new AbortController();

    // Handle client disconnect
    request.signal.addEventListener("abort", () => {
      abortController.abort();
    });

    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

    // Background pump function - streams from Maple to client
    async function pumpData() {
      if (!streamController) return;

      try {
        const generator = sendChatMessage(
          config,
          chatId,
          userContent,
          abortController.signal,
          recordUsage
        );

        for await (const event of generator) {
          if (!streamController) break;

          const sseData = JSON.stringify(event);
          const sseMessage = `data: ${sseData}\n\n`;

          try {
            streamController.enqueue(encoder.encode(sseMessage));
          } catch {
            // Controller was closed (client disconnected)
            break;
          }
        }

        // Send done signal
        if (streamController) {
          try {
            streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
            streamController.close();
          } catch {
            // Ignore close errors
          }
        }
      } catch (error) {
        console.error(`[chat-events] Stream error for chat ${chatId}:`, error);
        if (streamController) {
          try {
            const errorEvent = JSON.stringify({
              type: "error",
              content: error instanceof Error ? error.message : "Stream error",
            });
            streamController.enqueue(encoder.encode(`data: ${errorEvent}\n\n`));
            streamController.close();
          } catch {
            // Ignore cleanup errors
          }
        }
      } finally {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      }
    }

    return new Response(
      new ReadableStream({
        start(controller) {
          streamController = controller;

          // Send initial keepalive comment (SSE format)
          controller.enqueue(encoder.encode(": connected\n\n"));

          // Set up periodic keepalive to prevent idle timeout
          keepaliveTimer = setInterval(() => {
            try {
              if (streamController) {
                streamController.enqueue(encoder.encode(": keepalive\n\n"));
              }
            } catch {
              // Controller closed, clear the timer
              if (keepaliveTimer) {
                clearInterval(keepaliveTimer);
                keepaliveTimer = null;
              }
            }
          }, sseKeepaliveIntervalMs);

          // Start background pump - DO NOT await, must return immediately
          pumpData();
        },
        cancel() {
          // Clear keepalive timer
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          streamController = null;
          abortController.abort();
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no", // Disable proxy buffering
        },
      }
    );
  };
}

/**
 * Creates a handler for chat event subscriptions (general updates).
 * This can be used to subscribe to all events for a chat session.
 */
export function createChatEventsHandler(options: ChatEventsOptions) {
  const { sseKeepaliveIntervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS } = options;

  return async function handleChatEvents(
    chatId: string,
    npub: string | null,
    isAdmin: boolean,
    request: Request
  ): Promise<Response> {
    const session = getChatSession(chatId);
    if (!session) {
      return Response.json({ error: "Chat not found" }, { status: 404 });
    }

    if (!canAccessChatSession(session, npub, isAdmin)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    const encoder = new TextEncoder();
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

    // For now, this is a simple keepalive stream.
    // Future: could broadcast updates when messages are added by other sources.
    return new Response(
      new ReadableStream({
        start(controller) {
          // Send initial connection message
          controller.enqueue(encoder.encode(": connected\n\n"));

          // Send initial session state
          const initEvent = JSON.stringify({
            type: "init",
            session: {
              id: session.id,
              name: session.name,
              model: session.model,
              messageCount: session.messages.length,
            },
          });
          controller.enqueue(encoder.encode(`data: ${initEvent}\n\n`));

          // Set up keepalive
          keepaliveTimer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            } catch {
              if (keepaliveTimer) {
                clearInterval(keepaliveTimer);
                keepaliveTimer = null;
              }
            }
          }, sseKeepaliveIntervalMs);
        },
        cancel() {
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      }
    );
  };
}
