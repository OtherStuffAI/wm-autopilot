import { afterEach, describe, expect, test } from "bun:test";

import { OpenCodeAdapter } from "./opencode-adapter";

const context = {
  id: "wingman-session",
  port: 4096,
  agent: "opencode" as const,
  host: "127.0.0.1",
  workingDirectory: "/tmp/project",
  model: "openrouter/moonshotai/kimi-k3",
  opencodeSdkSessionId: "opencode-session",
};

function providerResponse(model = "moonshotai/kimi-k3"): Response {
  return Response.json({
    providers: [{ id: "openrouter", models: { [model]: { id: model } } }],
    default: {},
  });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
}

async function requestBody(input: string | URL | Request, init?: RequestInit): Promise<string> {
  if (typeof init?.body === "string") return init.body;
  if (input instanceof Request) return input.clone().text();
  return "";
}

describe("OpenCodeAdapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("reads structured message history from OpenCode", async () => {
    globalThis.fetch = (async (input) => {
      expect(new URL(requestUrl(input)).pathname).toBe("/session/opencode-session/message");
      return Response.json([
        {
          info: {
            id: "message-1",
            sessionID: "opencode-session",
            role: "assistant",
            time: { created: 1_750_000_000_000 },
          },
          parts: [
            { id: "part-1", sessionID: "opencode-session", messageID: "message-1", type: "text", text: "Structured response" },
            {
              id: "part-2",
              sessionID: "opencode-session",
              messageID: "message-1",
              type: "reasoning",
              text: "I inspected the project first.",
              time: { start: 1_750_000_001_000 },
            },
          ],
        },
      ]);
    }) as typeof fetch;

    const adapter = new OpenCodeAdapter(context);

    await expect(adapter.fetchMessages()).resolves.toEqual([
      {
        role: "assistant",
        content: "OpenCode SDK ready\n---\n\n- **Model:** `openrouter/moonshotai/kimi-k3`\n- **Directory:** `/tmp/project`",
        createdAt: "1970-01-01T00:00:00.000Z",
        messageId: "opencode-sdk-ready",
        turnId: "opencode-sdk-startup",
        order: -1000,
      },
      {
        role: "agent-working",
        content: "I inspected the project first.",
        createdAt: "2025-06-15T15:06:41.000Z",
        messageId: "part-2",
        turnId: "message-1",
        order: 0,
      },
      {
        role: "assistant",
        content: "Structured response",
        createdAt: "2025-06-15T15:06:40.000Z",
        messageId: "part-1",
        turnId: "message-1",
        order: 1,
      },
    ]);
  });

  test("keeps user turns before ordered reasoning and final output", async () => {
    globalThis.fetch = (async () => Response.json([
      {
        info: {
          id: "message-user",
          sessionID: "opencode-session",
          role: "user",
          time: { created: 1_750_000_000_000 },
        },
        parts: [
          { id: "part-user", sessionID: "opencode-session", messageID: "message-user", type: "text", text: "Question" },
        ],
      },
      {
        info: {
          id: "message-assistant",
          sessionID: "opencode-session",
          role: "assistant",
          time: { created: 1_750_000_000_100 },
        },
        parts: [
          { id: "part-final", sessionID: "opencode-session", messageID: "message-assistant", type: "text", text: "Answer" },
          {
            id: "part-thinking",
            sessionID: "opencode-session",
            messageID: "message-assistant",
            type: "reasoning",
            text: "Thinking",
            time: { start: 1_750_000_001_000 },
          },
        ],
      },
    ])) as typeof fetch;

    const adapter = new OpenCodeAdapter(context);
    const messages = await adapter.fetchMessages();

    expect(messages.map((message) => [message.role, message.content, message.order])).toEqual([
      [
        "assistant",
        "OpenCode SDK ready\n---\n\n- **Model:** `openrouter/moonshotai/kimi-k3`\n- **Directory:** `/tmp/project`",
        -1000,
      ],
      ["user", "Question", 0],
      ["agent-working", "Thinking", 1000],
      ["assistant", "Answer", 1001],
    ]);
  });

  test("reports a probed SDK server as stable and shows its model card before the first prompt", async () => {
    globalThis.fetch = (async (input) => {
      expect(new URL(requestUrl(input)).pathname).toBe("/session");
      return Response.json([]);
    }) as typeof fetch;

    const adapter = new OpenCodeAdapter({
      ...context,
      opencodeSdkSessionId: undefined,
    });

    await expect(adapter.fetchStatus()).resolves.toBe("stable");
    await expect(adapter.getPromptReadiness()).resolves.toMatchObject({
      state: "ready",
      reason: "opencode-server-ready",
    });
    await expect(adapter.fetchMessages()).resolves.toEqual([
      {
        role: "assistant",
        content: "OpenCode SDK ready\n---\n\n- **Model:** `openrouter/moonshotai/kimi-k3`\n- **Directory:** `/tmp/project`",
        createdAt: "1970-01-01T00:00:00.000Z",
        messageId: "opencode-sdk-ready",
        turnId: "opencode-sdk-startup",
        order: -1000,
      },
    ]);
  });

  test("sends the selected model through the prompt API and supports abort", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> | null }> = [];
    let releasePrompt: (() => void) | null = null;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(requestUrl(input));
      const bodyText = await requestBody(input, init);
      const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : null;
      requests.push({ path: url.pathname, body });
      if (url.pathname === "/config/providers") return providerResponse();
      if (url.pathname.endsWith("/abort")) return Response.json(true);
      if (url.pathname.endsWith("/message")) {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      }
      return Response.json({});
    }) as typeof fetch;

    const adapter = new OpenCodeAdapter(context);
    expect(adapter.deliversPromptsDirectly()).toBe(true);
    const sendPromise = adapter.sendMessage("Inspect the project");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests.find((request) => request.path.endsWith("/message"))?.body).toMatchObject({
      model: { providerID: "openrouter", modelID: "moonshotai/kimi-k3" },
      parts: [{ type: "text", text: "Inspect the project" }],
    });

    const interrupted = await adapter.interruptCurrentTurn();
    expect(interrupted).toBe(true);
    (releasePrompt as (() => void) | null)?.();
    await sendPromise;
  });

  test("fails with a useful reason before session creation or prompt execution when the model is unavailable", async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input) => {
      const path = new URL(requestUrl(input)).pathname;
      paths.push(path);
      if (path === "/config/providers") return providerResponse("another-model");
      return Response.json({});
    }) as typeof fetch;

    const adapter = new OpenCodeAdapter({
      ...context,
      opencodeSdkSessionId: undefined,
    });

    await expect(adapter.sendMessage("Do not send this"))
      .rejects.toThrow('OpenCode model "openrouter/moonshotai/kimi-k3" is unavailable before prompt execution');
    expect(paths).toEqual(["/config/providers"]);
  });

  test("surfaces and resolves OpenCode permission requests", async () => {
    let requestedBody: unknown = null;
    globalThis.fetch = (async (input, init) => {
      const bodyText = await requestBody(input, init);
      requestedBody = bodyText ? JSON.parse(bodyText) : null;
      return Response.json(true);
    }) as typeof fetch;

    const adapter = new OpenCodeAdapter(context);
    const events: unknown[] = [];
    const unsubscribe = adapter.subscribeToEvents((event) => events.push(event));
    await (adapter as unknown as {
      handleEvent(event: Record<string, unknown>): Promise<void>;
    }).handleEvent({
      type: "permission.updated",
      properties: {
        id: "permission-1",
        sessionID: "opencode-session",
        type: "file",
        title: "Write project file",
        pattern: "src/**",
        metadata: {},
        time: { created: 1_750_000_000_000 },
      },
    });

    expect(events).toHaveLength(1);
    expect(adapter.getPendingPermissions()).toHaveLength(1);
    await expect(adapter.respondToPermission("permission-1", "once")).resolves.toBe(true);
    expect(requestedBody).toEqual({ response: "once" });
    expect(adapter.getPendingPermissions()).toHaveLength(0);
    unsubscribe();
  });

  test("does not delete the persisted OpenCode session during adapter cleanup", async () => {
    let deleteCalled = false;
    globalThis.fetch = (async (input) => {
      if (requestUrl(input).endsWith("/opencode-session")) deleteCalled = true;
      return Response.json(true);
    }) as typeof fetch;

    const adapter = new OpenCodeAdapter(context);
    await adapter.dispose();

    expect(deleteCalled).toBe(false);
  });
});
