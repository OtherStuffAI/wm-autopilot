import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./db.js", import.meta.url), "utf8");

describe("live message speech persistence", () => {
  test("can update an existing Dexie message with generated speech audio", () => {
    expect(source).toContain("async updateMessageSpeech(sessionId, message, speech)");
    expect(source).toContain("normalizeConversationMessage(message)");
    expect(source).toContain("entry.messageId === normalized.messageId");
    expect(source).toContain("speech,");
  });

  test("preserves speech audio when stale message updates omit speech", () => {
    expect(source).toContain("normalized.speech ?? matchingMessage.speech ?? null");
    expect(source).toContain("normalized.speech ?? existing.speech ?? null");
    expect(source).toContain("speech: inc.speech ?? old.speech ?? null");
    expect(source).toContain("if (!message.speech && sameMessage && local.speech)");
    expect(source).toContain("return { ...message, speech: local.speech };");
  });
});
