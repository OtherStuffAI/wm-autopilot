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
    expect(projected[1]).toMatchObject({ id: "queued:first", promptId: "first" });
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

test("handled prompts stay as historical events in an active conversation without queue controls", () => {
  const history = { id: "handled-id", sessionId: "busy", content: "already acted", timestamp: "2026-10-02T00:00:00Z",
    state: "handled", handledAt: "2026-10-02T00:01:00Z", handledBy: "session:busy", handledReason: "Completed this turn", order: 1 };
  const projected = mergeConversationWithQueuedPrompts([{ role: "user", content: "already acted", createdAt: "2026-10-02T00:00:30Z" }], [history]);
  expect(projected).toHaveLength(2);
  expect(projected[1]).toMatchObject({ handled: true, queued: false, handledReason: "Completed this turn", createdAt: history.handledAt });
});

test("authoritative pending queue rows are not hidden by matching conversation text", () => {
  const rows = mergeConversationWithQueuedPrompts([{ role: "user", content: "matching prompt", createdAt: "2026-10-02T00:01:00Z" }],
    [{ id: "pending", content: "matching prompt", state: "pending", timestamp: "2026-10-02T00:00:00Z", order: 1 }]);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ promptId: "pending", queued: true, handled: false });
});
