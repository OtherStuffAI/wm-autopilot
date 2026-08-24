import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./queue-modal.js", import.meta.url), "utf8");

describe("prompt queue Dexie projection", () => {
  test("keeps Dexie synchronized across add, reload, edit, delete, and release", () => {
    expect(source).toContain("PromptQueueStore.upsert(sessionId, result.prompt)");
    expect(source).toContain("PromptQueueStore.replaceSession(sessionId, queue.prompts)");
    expect(source).toContain("PromptQueueStore.updateContent(sessionId, promptId, newContent)");
    expect(source).toContain("PromptQueueStore.remove(sessionId, promptId)");
    expect(source).toContain("PromptQueueStore.remove(sessionId, result.sentPrompt.id)");
  });

  test("does not delete a failed dispatch from the retained queue", () => {
    const failedBlock = source.slice(source.indexOf("if (data.failedPrompt)"), source.indexOf("const result = await response.json()"));
    expect(failedBlock).not.toContain("queue.prompts = queue.prompts.filter");
    expect(failedBlock).not.toContain("PromptQueueStore.remove");
  });
});
