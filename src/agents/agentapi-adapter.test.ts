import { afterEach, describe, expect, test } from "bun:test";

import { AgentApiAdapter } from "./agentapi-adapter";

const context = {
  id: "session-1",
  port: 3700,
  agent: "codex" as const,
  host: "127.0.0.1",
};

describe("AgentApiAdapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rejects status from a different agent type on the same port", async () => {
    const adapter = new AgentApiAdapter(context);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ status: "stable", agent_type: "opencode" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await expect(adapter.fetchStatus()).rejects.toThrow(
      "agentapi type mismatch: expected codex, got opencode",
    );
  });

  test("validates the agent type once before fetching messages", async () => {
    const adapter = new AgentApiAdapter(context);
    const requestedUrls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/status")) {
        return new Response(JSON.stringify({ status: "stable", agent_type: "codex" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ messages: [{ role: "agent", content: "ready" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const messages = await adapter.fetchMessages();
    await adapter.fetchMessages();

    expect(messages).toEqual([
      expect.objectContaining({
        role: "agent",
        content: "ready",
      }),
    ]);
    expect(requestedUrls.map((url) => new URL(url).pathname)).toEqual([
      "/status",
      "/messages",
      "/messages",
    ]);
  });
});
