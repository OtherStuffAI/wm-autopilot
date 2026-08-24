import { afterEach, describe, expect, test } from "bun:test";

import { createSessionEventsHandler } from "./session-events";

const decoder = new TextDecoder();

const runningSession = {
  id: "session-1",
  status: "running",
};

function createManager(adapter: {
  getEventsUrl: () => URL | null;
  subscribeToEvents?: ((listener: (event: any) => void) => (() => void) | null) | undefined;
}) {
  return {
    getSession(id: string) {
      return id === "session-1" ? runningSession : null;
    },
    getAdapter() {
      return {
        fetchStatus: async () => "stable",
        ...adapter,
      };
    },
  } as any;
}

async function readUntil(response: Response, expectedText: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  let combined = "";
  for (let index = 0; index < 8; index += 1) {
    const { value, done } = await reader.read();
    if (value) {
      combined += decoder.decode(value);
    }
    if (combined.includes(expectedText) || done) {
      break;
    }
  }

  await reader.cancel();
  return combined;
}

describe("createSessionEventsHandler", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("announces event-stream transport for proxied SSE sessions", async () => {
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start() {
            // Keep the upstream open; the test only cares about the initial transport event.
          },
        }),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      )) as unknown as typeof fetch;

    const handler = createSessionEventsHandler({
      manager: createManager({
        getEventsUrl() {
          return new URL("http://127.0.0.1:3700/events");
        },
      }),
      agentHost: "127.0.0.1",
      sseKeepaliveIntervalMs: 1000,
    });

    const response = await handler("session-1", new Request("http://localhost/api/sessions/session-1/events"));
    const chunk = await readUntil(response, "event: transport");

    expect(chunk).toContain("event: transport");
    expect(chunk).toContain('"mode":"event-stream"');
  });

  test("announces event-stream transport for native adapter sessions", async () => {
    const handler = createSessionEventsHandler({
      manager: createManager({
        getEventsUrl() {
          return null;
        },
        subscribeToEvents(listener) {
          queueMicrotask(() => {
            listener({
              type: "message",
              message: {
                role: "assistant",
                content: "partial",
                createdAt: "2026-04-16T08:00:00.000Z",
              },
            });
            listener({
              type: "status",
              status: "running",
            });
            listener({
              type: "permission",
              permission: {
                id: "permission-1",
                sessionId: "session-1",
                type: "file",
                title: "Write file",
                metadata: {},
                createdAt: "2026-04-16T08:00:00.000Z",
              },
            });
          });
          return () => {};
        },
      }),
      agentHost: "127.0.0.1",
      sseKeepaliveIntervalMs: 1000,
    });

    const response = await handler("session-1", new Request("http://localhost/api/sessions/session-1/events"));
    const chunk = await readUntil(response, '"status":"running"');

    expect(chunk).toContain("event: transport");
    expect(chunk).toContain('"mode":"event-stream"');
    expect(chunk).toContain("event: message");
    expect(chunk).toContain('"content":"partial"');
    expect(chunk).toContain("event: status");
    expect(chunk).toContain('"status":"running"');
  });

  test("announces heartbeat-only transport when no stream source exists", async () => {
    const handler = createSessionEventsHandler({
      manager: createManager({
        getEventsUrl() {
          return null;
        },
      }),
      agentHost: "127.0.0.1",
      sseKeepaliveIntervalMs: 1000,
    });

    const response = await handler("session-1", new Request("http://localhost/api/sessions/session-1/events"));
    const chunk = await readUntil(response, "event: transport");

    expect(chunk).toContain("event: transport");
    expect(chunk).toContain('"mode":"heartbeat-only"');
  });

  test("publishes durable message refresh events to an open live view", async () => {
    let publish: (() => void) | null = null;
    const handler = createSessionEventsHandler({
      manager: createManager({ getEventsUrl: () => null }),
      agentHost: "127.0.0.1",
      subscribeToMessageUpdates: (_sessionId, listener) => {
        publish = listener;
        return () => {};
      },
    });

    const response = await handler("session-1", new Request("http://localhost/api/sessions/session-1/events"));
    publish?.();
    const chunk = await readUntil(response, "event: refresh");

    expect(chunk).toContain("event: refresh");
    expect(chunk).toContain('"reason":"messages-updated"');
  });

  test("backs off when an upstream stream ends instead of reconnecting in a hot loop", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response(new ReadableStream({ start(controller) { controller.close(); } }));
    }) as typeof fetch;
    const handler = createSessionEventsHandler({
      manager: createManager({ getEventsUrl: () => new URL("http://127.0.0.1:3700/events") }),
      agentHost: "127.0.0.1",
    });

    const response = await handler("session-1", new Request("http://localhost/api/sessions/session-1/events"));
    const chunk = await readUntil(response, "stream-ended");

    expect(chunk).toContain("stream-ended");
    expect(fetchCount).toBe(1);
  });
});
