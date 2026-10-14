import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PromptQueueStore } from "./prompt-queue-store.ts";
test("dedicated recovery preserves superseded unsent content with audit and never claims it handled", () => {
  const dir = mkdtempSync(join(tmpdir(), "dedicated-queue-"));
  try {
    const path = join(dir, "queue.db"),
      store = new PromptQueueStore(path),
      old = store.addPrompt("builder", { content: "old unsent instruction" })!;
    store.addPrompt("ordinary", { content: "unrelated work" });
    expect(store.supersedeDedicatedPending("builder", "owner-binding")).toBe(1);
    expect(store.supersedeDedicatedPending("builder", "owner-binding")).toBe(0);
    expect(store.getQueueCount("builder")).toBe(0);
    expect(store.getQueueCount("ordinary")).toBe(1);
    expect(store.getHandledPrompts("builder")).toEqual([]);
    const inspect = new Database(path);
    expect(inspect.query("SELECT state,content,handled_at FROM prompt_queue WHERE id=?").get(old.id)).toEqual({
      state: "superseded",
      content: "old unsent instruction",
      handled_at: null,
    });
    expect(inspect.query("SELECT resolution,actor,revision FROM prompt_queue_recovery").all()).toEqual([
      { resolution: "superseded", actor: "owner-binding", revision: "1" },
    ]);
    inspect.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("claimed or sending ordinary work prevents supersession atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "dedicated-claim-"));
  try {
    const store = new PromptQueueStore(join(dir, "queue.db"));
    store.addPrompt("builder", { content: "claimed" });
    store.addPrompt("builder", { content: "unsent" });
    const claimed = store.claimNextPrompt("builder")!;
    store.markClaimSending("builder", claimed.id, claimed.claimToken!);
    expect(() => store.supersedeDedicatedPending("builder", "binding")).toThrow("unresolved ordinary delivery");
    expect(store.getQueueCount("builder")).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
