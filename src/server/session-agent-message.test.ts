import { describe, expect, mock, test } from "bun:test";

import type { AgentAdapter } from "../agents/agent-adapter";
import { deliverSessionAgentMessage, type SessionAgentMessageInput } from "./session-agent-message";

function buildAdapter(overrides: Partial<AgentAdapter>): AgentAdapter {
  return {
    fetchStatus: async () => "stable",
    sendMessage: async () => {},
    fetchMessages: async () => [],
    interruptCurrentTurn: async () => false,
    getEventsUrl: () => null,
    waitForReady: async () => {},
    dispose: async () => {},
    ...overrides,
  };
}

const baseInput: Omit<SessionAgentMessageInput, "adapter" | "agent"> = {
  agentHost: "127.0.0.1",
  buildAgentUrl: (host, port, path) => `http://${host}:${port}${path}`,
  port: 3700,
  content: "hello",
  type: "user",
};

describe("deliverSessionAgentMessage adapter routing", () => {
  test("routes prompts to the adapter when it delivers prompts directly", async () => {
    const sent: string[] = [];
    let httpCalled = false;
    const adapter = buildAdapter({
      deliversPromptsDirectly: () => true,
      sendMessage: async (content) => {
        sent.push(content);
      },
    });

    const result = await deliverSessionAgentMessage({
      ...baseInput,
      agent: "codex",
      adapter,
      // Any fetch here would indicate the HTTP path was taken.
      buildAgentUrl: () => {
        httpCalled = true;
        return "http://unused";
      },
    });

    expect(result.ok).toBe(true);
    expect(sent).toEqual(["hello"]);
    expect(httpCalled).toBe(false);
  });

  test("does not use the adapter for raw delivery even when it delivers directly", async () => {
    let adapterSendCalled = false;
    const adapter = buildAdapter({
      deliversPromptsDirectly: () => true,
      sendMessage: async () => {
        adapterSendCalled = true;
      },
    });

    // Raw delivery must fall through to the HTTP path; point buildAgentUrl at a
    // closed port so the request fails fast without the adapter being used.
    const result = await deliverSessionAgentMessage({
      ...baseInput,
      agent: "codex",
      type: "raw",
      adapter,
      port: 1,
    });

    expect(adapterSendCalled).toBe(false);
    expect(result.ok).toBe(false);
  });

  test("surfaces adapter delivery failures as 502", async () => {
    const adapter = buildAdapter({
      deliversPromptsDirectly: () => true,
      sendMessage: async () => {
        throw new Error("thread crashed");
      },
    });

    const result = await deliverSessionAgentMessage({
      ...baseInput,
      agent: "codex",
      adapter,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.message).toContain("thread crashed");
  });

  test("returns a queueable busy result without waiting or sending to a direct adapter", async () => {
    const waitForReady = mock(async () => undefined);
    const sendMessage = mock(async () => undefined);
    const adapter = buildAdapter({
      deliversPromptsDirectly: () => true,
      getPromptReadiness: async () => ({
        state: "busy",
        reason: "goose-waiting-permission",
        retryAfterMs: 1000,
        observedAt: Date.now(),
      }),
      waitForReady,
      sendMessage,
    });

    const result = await deliverSessionAgentMessage({
      ...baseInput,
      agent: "goose",
      adapter,
    });

    expect(result).toEqual({ ok: false, status: 409, message: "Agent working" });
    expect(waitForReady).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("preserves actionable Pi ACP model errors through the message route", async () => {
    const adapter = buildAdapter({
      deliversPromptsDirectly: () => true,
      sendMessage: async () => {
        throw new Error(
          'Pi ACP model "openrouter/google/missing" is not advertised by this session; provider "openrouter" is not authenticated',
        );
      },
    });

    const result = await deliverSessionAgentMessage({
      ...baseInput,
      agent: "pi",
      adapter,
    });

    expect(result).toEqual({
      ok: false,
      status: 502,
      message: 'Failed to contact agent: Pi ACP model "openrouter/google/missing" is not advertised by this session; provider "openrouter" is not authenticated',
    });
  });
});
