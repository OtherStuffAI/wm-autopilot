import { describe, expect, test } from "bun:test";

import type { AdapterStreamEvent } from "./agent-adapter";
import type { AcpRequestOptions } from "./acp-process-client";
import type { GooseAcpEvent, GooseAcpResponse } from "./goose-acp-client";
import { GooseAdapter } from "./goose-adapter";

const context = {
  id: "wingman-goose",
  port: 3702,
  agent: "goose" as const,
  host: "127.0.0.1",
  workingDirectory: "/tmp/project",
  gooseSessionId: "goose-session",
};

interface TestableGooseAdapter {
  client: {
    request(
      method: string,
      params?: Record<string, unknown>,
      options?: AcpRequestOptions,
    ): Promise<GooseAcpResponse>;
  };
  state: "initializing" | "ready" | "busy" | "disposed";
  handleEvent(event: GooseAcpEvent): void;
}

function testable(adapter: GooseAdapter): TestableGooseAdapter {
  return adapter as unknown as TestableGooseAdapter;
}

function update(adapter: GooseAdapter, value: Record<string, unknown>): void {
  testable(adapter).handleEvent({
    method: "session/update",
    params: { sessionId: "goose-session", update: value },
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

describe("GooseAdapter ACP stream boundary", () => {
  test("normalizes interleaved thought, tool, and final events without completing on chunks", async () => {
    let completePrompt!: (response: GooseAcpResponse) => void;
    const adapter = new GooseAdapter(context);
    const internal = testable(adapter);
    internal.state = "ready";
    internal.client = {
      request: async () => await new Promise<GooseAcpResponse>((resolve) => {
        completePrompt = resolve;
      }),
    };
    const events: AdapterStreamEvent[] = [];
    adapter.subscribeToEvents((event) => events.push(event));

    const prompt = adapter.sendMessage("Inspect the adapter");
    await waitUntil(() => internal.state === "busy");
    update(adapter, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking " } });
    update(adapter, {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Read adapter",
      kind: "read",
      status: "pending",
      rawInput: { path: "src/agents/goose-adapter.ts" },
    });
    update(adapter, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "events." } });
    update(adapter, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" });
    update(adapter, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The stream " } });
    update(adapter, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      rawOutput: "adapter read",
    });
    update(adapter, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "is normalized." } });

    expect(internal.state as string).toBe("busy");
    expect(events.filter((event) => event.type === "status")).toEqual([{ type: "status", status: "running" }]);
    completePrompt({ result: { stopReason: "end_turn" } });
    await prompt;

    expect(events.filter((event) => event.type === "status")).toEqual([
      { type: "status", status: "running" },
      { type: "status", status: "stable" },
    ]);
    const messages = await adapter.fetchMessages();
    expect(messages).toHaveLength(4);
    expect(messages.find((message) => message.role === "user")?.content)
      .toBe("Inspect the adapter");
    const thinking = messages.find((message) => message.role === "agent-thinking");
    expect(thinking?.messageId).toBe("acp-turn-1-thinking");
    expect(thinking?.content).toContain("Checking events.");
    const tools = messages.find((message) => message.role === "agent-tools");
    expect(tools?.messageId).toBe("acp-turn-1-tools");
    expect(tools?.content).toContain("Tool call: Read adapter (completed)");
    expect(messages.find((message) => message.role === "assistant")?.content)
      .toBe("The stream is normalized.");
    expect(messages.find((message) => message.role === "assistant")?.content).not.toContain("Checking");
  });

  test("uses prompt responses as the completion boundary and releases the next queued send", async () => {
    const resolvers: Array<(response: GooseAcpResponse) => void> = [];
    const prompts: string[] = [];
    const requestOptions: Array<AcpRequestOptions | undefined> = [];
    const adapter = new GooseAdapter(context);
    const internal = testable(adapter);
    internal.state = "ready";
    internal.client = {
      request: async (_method, params, options) => {
        const prompt = Array.isArray(params?.prompt) ? params.prompt[0] : null;
        if (prompt && typeof prompt === "object" && "text" in prompt) prompts.push(String(prompt.text));
        requestOptions.push(options);
        return await new Promise<GooseAcpResponse>((resolve) => resolvers.push(resolve));
      },
    };

    const first = adapter.sendMessage("first");
    await waitUntil(() => prompts.length === 1);
    expect(requestOptions).toEqual([{ timeoutMs: null }]);
    const second = adapter.sendMessage("second");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prompts).toEqual(["first"]);
    expect(internal.state as string).toBe("busy");

    resolvers[0]!({ result: { stopReason: "end_turn" } });
    await first;
    await waitUntil(() => prompts.length === 2);
    expect(prompts).toEqual(["first", "second"]);
    expect(requestOptions).toEqual([{ timeoutMs: null }, { timeoutMs: null }]);
    expect(internal.state as string).toBe("busy");

    resolvers[1]!({ result: { stopReason: "end_turn" } });
    await second;
    expect(internal.state).toBe("ready");
  });

  test("does not emit normalized messages for unknown or malformed updates", () => {
    const adapter = new GooseAdapter(context);
    const internal = testable(adapter);
    internal.state = "busy";
    const events: AdapterStreamEvent[] = [];
    adapter.subscribeToEvents((event) => events.push(event));

    update(adapter, { sessionUpdate: "available_commands_update", availableCommands: [] });
    update(adapter, { sessionUpdate: "tool_call_update", toolCallId: "unknown", status: "completed" });
    update(adapter, { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "..." } });

    expect(events).toEqual([]);
  });
});
