import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { readCodexSessionMessagesFromFile } from "./codex-session-messages";

describe("Codex session message mirrors", () => {
  test("deduplicates mirrored Codex message record formats", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-mirrored-messages-test-"));
    const filePath = join(root, "rollout.jsonl");
    try {
      await writeFile(filePath, [
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-31T03:00:00.000Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Hello Kato" }] },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-31T03:00:00.001Z",
          payload: { type: "user_message", message: "Hello Kato" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-31T03:00:01.000Z",
          payload: { type: "agent_message", phase: "final_answer", message: "Hello! I can respond now." },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-31T03:00:01.001Z",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Hello! I can respond now." }],
          },
        }),
      ].join("\n"));

      await expect(readCodexSessionMessagesFromFile(filePath)).resolves.toEqual([
        { role: "user", content: "Hello Kato", createdAt: "2026-08-31T03:00:00.000Z" },
        { role: "agent", content: "Hello! I can respond now.", createdAt: "2026-08-31T03:00:01.000Z" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves repeated messages that are not cross-format mirrors", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-repeated-messages-test-"));
    const filePath = join(root, "rollout.jsonl");
    try {
      await writeFile(filePath, [
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-31T03:00:00.000Z",
          payload: { type: "user_message", message: "Repeat this" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-31T03:00:00.001Z",
          payload: { type: "user_message", message: "Repeat this" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-31T03:00:02.000Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Repeat this" }] },
        }),
      ].join("\n"));

      const messages = await readCodexSessionMessagesFromFile(filePath);
      expect(messages).toHaveLength(3);
      expect(messages.every((message) => message.content === "Repeat this")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
