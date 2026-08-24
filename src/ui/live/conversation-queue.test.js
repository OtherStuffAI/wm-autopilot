import { describe, expect, test } from "bun:test";

import { mergeConversationWithQueuedPrompts } from "./conversation-queue.js";

describe("queued prompt conversation projection", () => {
  test("shows retained prompts once in queue order", () => {
    const projected = mergeConversationWithQueuedPrompts(
      [{ id: "active", role: "assistant", content: "Working", createdAt: "2026-08-04T02:00:00.000Z" }],
      [
        { id: "second", content: "Second", timestamp: "2026-08-04T02:00:02.000Z", order: 2 },
        { id: "first", content: "First", timestamp: "2026-08-04T02:00:01.000Z", order: 1 },
      ],
    );

    expect(projected.map((message) => [message.content, Boolean(message.queued)])).toEqual([
      ["Working", false],
      ["First", true],
      ["Second", true],
    ]);
  });

  test("does not mistake an earlier identical user turn for a released queued prompt", () => {
    const projected = mergeConversationWithQueuedPrompts(
      [{ id: "active", role: "user", content: "Repeat", createdAt: "2026-08-04T02:00:00.000Z" }],
      [{ id: "queued", content: "Repeat", timestamp: "2026-08-04T02:00:01.000Z", order: 1 }],
    );

    expect(projected).toHaveLength(2);
    expect(projected[1]).toMatchObject({ content: "Repeat", queued: true });
  });

  test("replaces each released queue projection with exactly one canonical user message", () => {
    const prompts = [
      { id: "first", content: "Repeat", timestamp: "2026-08-04T02:00:01.000Z", order: 1 },
      { id: "second", content: "Repeat", timestamp: "2026-08-04T02:00:02.000Z", order: 2 },
    ];
    const projected = mergeConversationWithQueuedPrompts([
      { id: "released", role: "user", content: "Repeat", createdAt: "2026-08-04T02:00:03.000Z" },
    ], prompts);

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({ id: "released" });
    expect(projected[0].queued).toBeUndefined();
    expect(projected[1]).toMatchObject({ id: "queued:second", queued: true });
  });
});
