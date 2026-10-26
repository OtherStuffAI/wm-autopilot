import { describe, expect, test } from "bun:test";
import type { DirectChatMessage } from "./direct-chat-contract";
import { budgetDirectChatHistory } from "./direct-chat-history-budget";
import { buildInitialDirectChatEnvelope, buildRehydratedDirectChatEnvelope } from "./direct-chat-prompt-envelope";

function message(id: string, body: string): DirectChatMessage {
  return {
    messageId: id, message: body, createdAt: "2026-10-26T00:00:00Z",
    userId: null, userNpub: null, speakerLabel: "Participant", attachments: [],
    mentions: [], agentDirectRecipientNpub: null, inherited: false, owningThreadId: "thread",
  };
}

describe("Direct Chat historical prompt budget", () => {
  test("preserves ordinary history exactly", () => {
    const history = [message("old", "Original context"), message("recent", "Recent context")];
    expect(budgetDirectChatHistory(history)).toEqual({ messages: history, notice: null });
  });

  test("a historical four-megabyte crash dump cannot block a fresh request", () => {
    const crash = message("crash-report", "Crash header\n" + "stack trace\n".repeat(360_000) + "Crash footer");
    const history = [crash, message("recent", "Latest observation")];
    const prompts = [message("new", "Please investigate this crash")];
    for (const envelope of [
      buildInitialDirectChatEnvelope({ metadata: { source: { thread_id: "thread" } }, history, prompts }),
      buildRehydratedDirectChatEnvelope({ history, prompts }),
    ]) {
      expect(envelope.length).toBeLessThan(40_000);
      expect(envelope).toContain("Crash header");
      expect(envelope).toContain("Crash footer");
      expect(envelope).toContain("Retrieve message crash-report");
      expect(envelope).toContain("Latest observation");
      expect(envelope).toContain("# Prompt\n\nPlease investigate this crash");
      expect(envelope).toContain("original messages remain unchanged");
    }
    expect(crash.message.length).toBeGreaterThan(3_900_000);
  });

  test("bounds aggregate history and explicitly reports older omissions", () => {
    const history = Array.from({ length: 100 }, (_, index) => message(`history-${index}`, "x".repeat(20_000)));
    const result = budgetDirectChatHistory(history);
    expect(result.notice).toContain("older messages omitted");
    expect(result.messages.at(-1)?.messageId).toBe("history-99");
    const envelope = buildRehydratedDirectChatEnvelope({ history, prompts: [message("new", "New request")] });
    expect(envelope.length).toBeLessThan(270_000);
    expect(envelope).toContain("New request");
  });

  test("never excerpts newly actionable instructions", () => {
    const prompt = "Important instruction\n".repeat(3000);
    const envelope = buildRehydratedDirectChatEnvelope({ history: [], prompts: [message("new", prompt)] });
    expect(envelope).toContain(prompt);
    expect(envelope).not.toContain("Historical message excerpt");
  });
});
