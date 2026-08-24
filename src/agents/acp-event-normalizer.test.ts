import { describe, expect, test } from "bun:test";

import { AcpEventNormalizer } from "./acp-event-normalizer";

describe("AcpEventNormalizer", () => {
  test("keeps thought and final chunks separate while accumulating each message", () => {
    const normalizer = new AcpEventNormalizer(() => new Date("2026-07-29T01:00:00.000Z"));
    normalizer.beginTurn();

    expect(normalizer.normalize({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Inspecting " },
    })).toMatchObject({ kind: "message", message: { role: "agent-thinking", content: "Inspecting " } });
    expect(normalizer.normalize({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Answer " },
    })).toMatchObject({ kind: "message", message: { role: "assistant", content: "Answer " } });
    expect(normalizer.normalize({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "the adapter." },
    })).toMatchObject({ kind: "message", message: { role: "agent-thinking", content: "Inspecting the adapter." } });
    expect(normalizer.normalize({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "complete." },
    })).toMatchObject({ kind: "message", message: { role: "assistant", content: "Answer complete." } });
  });

  test("rolls earlier agent messages into thinking while keeping the latest response visible", () => {
    const normalizer = new AcpEventNormalizer(
      () => new Date("2026-08-22T08:00:00.000Z"),
      { rollIntermediateAgentMessages: true },
    );
    normalizer.beginTurn();

    expect(normalizer.normalize({
      sessionUpdate: "agent_message_chunk",
      messageId: "progress-1",
      content: { type: "text", text: "Checking the route" },
    })).toMatchObject({
      kind: "message",
      message: { role: "assistant", messageId: "acp-turn-1-message", content: "Checking the route" },
    });

    expect(normalizer.normalize({
      sessionUpdate: "agent_message_chunk",
      messageId: "progress-2",
      content: { type: "text", text: "Applying the fix" },
    })).toMatchObject({
      kind: "messages",
      messages: [
        { role: "agent-thinking", messageId: "acp-turn-1-thinking", content: "Checking the route" },
        { role: "assistant", messageId: "acp-turn-1-message", content: "Applying the fix" },
      ],
    });

    expect(normalizer.normalize({
      sessionUpdate: "agent_message_chunk",
      messageId: "progress-2",
      content: { type: "text", text: " now." },
    })).toMatchObject({
      kind: "message",
      message: { role: "assistant", messageId: "acp-turn-1-message", content: "Applying the fix now." },
    });
  });

  test("normalizes user chunks for transcript hydration", () => {
    const normalizer = new AcpEventNormalizer(() => new Date("2026-07-29T01:00:00.000Z"));
    normalizer.beginTurn();

    expect(normalizer.normalize({
      sessionUpdate: "user_message_chunk",
      messageId: "user-1",
      content: { type: "text", text: "Hello " },
    })).toMatchObject({ kind: "message", message: { role: "user", content: "Hello ", messageId: "acp-turn-2-user-user-1", turnId: "acp-turn-2" } });
    expect(normalizer.normalize({
      sessionUpdate: "user_message_chunk",
      messageId: "user-1",
      content: { type: "text", text: "Goose" },
    })).toMatchObject({ kind: "message", message: { role: "user", content: "Hello Goose", messageId: "acp-turn-2-user-user-1", turnId: "acp-turn-2" } });
  });

  test("merges tool updates into one stable normalized item", () => {
    const normalizer = new AcpEventNormalizer(() => new Date("2026-07-29T01:00:00.000Z"));
    normalizer.beginTurn();

    const initial = normalizer.normalize({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read source",
      kind: "read",
      status: "pending",
      rawInput: { path: "src/main.ts" },
    });
    const running = normalizer.normalize({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "in_progress",
    });
    const completed = normalizer.normalize({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "42 lines" } }],
      rawOutput: { lines: 42 },
    });

    expect(initial).toMatchObject({ kind: "message", message: { messageId: "acp-turn-1-tools", role: "agent-tools" } });
    expect(running).toMatchObject({ kind: "message", message: { messageId: "acp-turn-1-tools", content: expect.stringContaining("in progress") } });
    expect(completed).toMatchObject({
      kind: "message",
      message: {
        messageId: "acp-turn-1-tools",
        content: expect.stringContaining("Content: 42 lines"),
      },
    });
  });

  test("merges additional tool activity into the turn tools message", () => {
    const normalizer = new AcpEventNormalizer(() => new Date("2026-08-22T08:00:00.000Z"));
    normalizer.beginTurn();

    const permission = normalizer.upsertToolActivity(
      "permission:700",
      "ACP permission auto-approved: Maple Desktop runtime request (Allow once).",
    );
    const tool = normalizer.normalize({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Edit file",
      status: "completed",
    });

    expect(permission).toMatchObject({ role: "agent-tools", messageId: "acp-turn-1-tools" });
    expect(tool.kind).toBe("message");
    if (tool.kind !== "message") throw new Error("Expected normalized tool message");
    expect(tool.message).toMatchObject({
      role: "agent-tools",
      messageId: "acp-turn-1-tools",
    });
    expect(tool.message.content).toContain("ACP permission auto-approved");
    expect(tool.message.content).toContain("Tool call: Edit file (completed)");
  });

  test("derives stable boundaries for replayed turns before any local prompt", () => {
    const normalizer = new AcpEventNormalizer(() => new Date("2026-08-04T02:47:58.000Z"));
    const updates = [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hey Goose" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Reviewing" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello Example Operator" } },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "What next?" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking" } },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Third turn" } },
    ];
    const messages = updates.map((update) => normalizer.normalize(update))
      .filter((result) => result.kind === "message").map((result) => result.message);

    expect(messages.map((message) => [message.turnId, message.messageId, message.content])).toEqual([
      ["acp-turn-1", "acp-turn-1-user", "Hey Goose"],
      ["acp-turn-1", "acp-turn-1-thinking", "Reviewing"],
      ["acp-turn-1", "acp-turn-1-message", "Hello Example Operator"],
      ["acp-turn-2", "acp-turn-2-user", "What next?"],
      ["acp-turn-2", "acp-turn-2-thinking", "Checking"],
      ["acp-turn-3", "acp-turn-3-user", "Third turn"],
    ]);
  });

  test("namespaces reused upstream ids by replay turn", () => {
    const normalizer = new AcpEventNormalizer();
    const emit = (sessionUpdate: string, text: string) => normalizer.normalize({
      sessionUpdate, messageId: "reused", content: { type: "text", text },
    });
    const results = [emit("user_message_chunk", "One"), emit("agent_message_chunk", "First"),
      emit("user_message_chunk", "Two"), emit("agent_message_chunk", "Second")]
      .filter((result) => result.kind === "message").map((result) => result.message);
    expect(results.map((message) => message.messageId)).toEqual([
      "acp-turn-1-user-reused", "acp-turn-1-message-reused",
      "acp-turn-2-user-reused", "acp-turn-2-message-reused",
    ]);
  });

  test("replaying the same native history twice produces identical identity and order", () => {
    const replay = () => {
      const normalizer = new AcpEventNormalizer(() => new Date("2026-08-04T02:47:58.000Z"));
      return [
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "One" } },
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Think one" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First" } },
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Two" } },
      ].map((update) => normalizer.normalize(update))
        .filter((result) => result.kind === "message")
        .map((result) => ({ messageId: result.message.messageId, turnId: result.message.turnId, order: result.message.order }));
    };
    expect(replay()).toEqual(replay());
  });

  test("ignores unknown updates and rejects malformed or orphaned known updates", () => {
    const normalizer = new AcpEventNormalizer();
    normalizer.beginTurn();

    expect(normalizer.normalize({ sessionUpdate: "plan", entries: [] })).toEqual({ kind: "ignored" });
    expect(normalizer.normalize({ sessionUpdate: "agent_thought_chunk", content: { type: "image" } })).toEqual({
      kind: "invalid",
      reason: "agent_thought_chunk is missing text content",
    });
    expect(normalizer.normalize({ sessionUpdate: "tool_call_update", toolCallId: "missing" })).toEqual({
      kind: "invalid",
      reason: "tool_call_update references unknown toolCallId missing",
    });
    expect(normalizer.normalize({
      sessionUpdate: "tool_call",
      toolCallId: "malformed",
      title: "Run command",
      status: 42,
    })).toEqual({
      kind: "invalid",
      reason: "tool_call has invalid status",
    });
  });
});
