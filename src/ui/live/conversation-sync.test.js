import { describe, expect, test } from "bun:test";

import {
  areConversationMessagesEqual,
  isUserMessageCoveredBySnapshot,
  normalizeConversationMessage,
  normalizeConversationMessages,
} from "./conversation-sync.js";

describe("conversation-sync", () => {
  test("normalizes mixed message shapes into the canonical conversation contract", () => {
    const createdAt = "2026-04-06T10:00:00.000Z";

    expect(normalizeConversationMessage({
      id: "server-message-7",
      type: "user",
      message: "hello",
      created_at: createdAt,
    })).toEqual({
      messageId: "server-message-7",
      role: "user",
      content: "hello",
      createdAt,
    });
  });

  test("normalizes arrays without mutating the source payload", () => {
    const source = [{ role: "assistant", content: "done" }];
    const normalized = normalizeConversationMessages(source, "2026-04-06T11:00:00.000Z");

    expect(normalized).toEqual([{
      role: "assistant",
      content: "done",
      createdAt: "2026-04-06T11:00:00.000Z",
    }]);
    expect(source).toEqual([{ role: "assistant", content: "done" }]);
  });

  test("treats equivalent legacy and canonical message shapes as equal", () => {
    expect(areConversationMessagesEqual(
      [{ type: "assistant", message: "hi", created_at: "2026-04-06T12:00:00.000Z" }],
      [{ role: "assistant", content: "hi", createdAt: "2026-04-06T12:00:00.000Z" }],
    )).toBe(true);
  });

  test("preserves speech attachments in normalized messages", () => {
    const speech = {
      publicPath: "/uploads/files/user/codex/speech/response.mp3",
      mimeType: "audio/mpeg",
    };

    expect(normalizeConversationMessage({
      id: "message-1",
      role: "assistant",
      content: "Ready",
      createdAt: "2026-04-06T13:00:00.000Z",
      speech,
    })).toEqual({
      messageId: "message-1",
      role: "assistant",
      content: "Ready",
      createdAt: "2026-04-06T13:00:00.000Z",
      speech,
    });

    expect(areConversationMessagesEqual(
      [{ role: "assistant", content: "Ready", createdAt: "2026-04-06T13:00:00.000Z" }],
      [{ role: "assistant", content: "Ready", createdAt: "2026-04-06T13:00:00.000Z", speech }],
    )).toBe(false);
  });

  test("does not treat Dexie numeric ids as server message ids", () => {
    expect(normalizeConversationMessage({
      id: 7,
      role: "assistant",
      content: "Ready",
      createdAt: "2026-04-06T14:00:00.000Z",
    })).toEqual({
      role: "assistant",
      content: "Ready",
      createdAt: "2026-04-06T14:00:00.000Z",
    });
  });

  test("preserves ACP turn identity and deterministic order through hydration", () => {
    expect(normalizeConversationMessage({
      id: "sqlite-row",
      role: "agent-working",
      content: "Thinking",
      createdAt: "2026-08-04T02:47:58.000Z",
      messageId: "acp-turn-2-working",
      turnId: "acp-turn-2",
      order: 1001,
    })).toEqual({
      role: "agent-working",
      content: "Thinking",
      createdAt: "2026-08-04T02:47:58.000Z",
      messageId: "acp-turn-2-working",
      turnId: "acp-turn-2",
      order: 1001,
    });
  });
});

describe("canonical conversation snapshot watermark", () => {
  const snapshot = [
    { role: "user", content: "first", createdAt: "2026-08-10T01:07:14.272Z", messageId: "user-1" },
    { role: "agent", content: "answer", createdAt: "2026-08-10T01:08:13.663Z", messageId: "agent-1" },
  ];

  test("removes an unmatched confirmed user echo behind the snapshot", () => {
    expect(isUserMessageCoveredBySnapshot({
      role: "user",
      content: "first",
      createdAt: "2026-08-10T01:07:15.000Z",
      messageId: "duplicate-transport-id",
    }, snapshot)).toBe(true);
  });

  test("preserves a newer confirmed user turn while the snapshot catches up", () => {
    expect(isUserMessageCoveredBySnapshot({
      role: "user",
      content: "latest prompt",
      createdAt: "2026-08-10T01:09:00.000Z",
      messageId: "latest-user",
    }, snapshot)).toBe(false);
  });

  test("preserves pending and optimistic rows regardless of timestamp", () => {
    expect(isUserMessageCoveredBySnapshot({
      role: "user",
      content: "pending",
      createdAt: "2026-08-10T01:07:15.000Z",
      pending: true,
    }, snapshot)).toBe(false);
    expect(isUserMessageCoveredBySnapshot({
      role: "user",
      content: "optimistic",
      createdAt: "2026-08-10T01:07:15.000Z",
      optimistic: true,
    }, snapshot)).toBe(false);
  });
});
