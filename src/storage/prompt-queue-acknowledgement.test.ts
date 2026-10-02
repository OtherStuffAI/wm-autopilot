import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PromptQueueStore } from "./prompt-queue-store";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "queue-ack-"));
  roots.push(root);
  const path = join(root, "queue.db");
  return { path, store: new PromptQueueStore(path) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("atomic prompt queue acknowledgement", () => {
  test("retains durable handled history and identical retries without releasing another item", () => {
    const { store, path } = fixture();
    const first = store.addPrompt("session", { content: "already acted" })!;
    const second = store.addPrompt("session", { content: "later request" })!;
    const read = store.getSessionQueue("session")[0]!;
    expect(read).toMatchObject({ id: first.id, revision: "1", state: "pending" });
    const handled = store.acknowledgePrompt("session", read.id, read.revision, "session:session", "handled this turn");
    const reopened = new PromptQueueStore(path);
    expect(reopened.acknowledgePrompt("session", read.id, read.revision, "session:session", "handled this turn")).toEqual(handled);
    expect(handled.handledAt).toBeTruthy();
    expect(reopened.getHandledPrompts("session")).toEqual([handled]);
    expect(reopened.getQueueCount("session")).toBe(1);
    expect(reopened.claimNextPrompt("session")?.id).toBe(second.id);
    expect(() => reopened.acknowledgePrompt("session", first.id, "1", "session:session", "different reason")).toThrow("already handled");
    expect(() => reopened.acknowledgePrompt("session", first.id, "1", "another actor", "handled this turn")).toThrow("already handled");
  });

  test("revision changes on every edit including change back to original content", () => {
    const { store, path } = fixture();
    const prompt = store.addPrompt("session", { content: "original" })!;
    const editor = new PromptQueueStore(path);
    editor.updatePromptContent("session", prompt.id, "edited");
    editor.updatePromptContent("session", prompt.id, "original");
    expect(store.getSessionQueue("session")[0]?.revision).toBe("3");
    expect(() => store.acknowledgePrompt("session", prompt.id, prompt.revision, "actor", "handled")).toThrow("revision changed");
    expect(store.getQueueCount("session")).toBe(1);
  });

  test("dispatcher winning prevents acknowledgement, edit, delete and duplicate claims", () => {
    const { store, path } = fixture();
    const prompt = store.addPrompt("session", { content: "first" })!;
    const other = new PromptQueueStore(path);
    const claimed = store.claimNextPrompt("session")!;
    expect(other.claimNextPrompt("session")).toBeNull();
    expect(() => other.acknowledgePrompt("session", prompt.id, prompt.revision, "actor", "handled")).toThrow("already claimed");
    expect(other.updatePromptContent("session", prompt.id, "edit")).toBeFalse();
    expect(other.deletePromptById("session", prompt.id)).toBeFalse();
    store.completeClaim("session", prompt.id, claimed.claimToken!);
    expect(() => other.acknowledgePrompt("session", prompt.id, prompt.revision, "actor", "handled")).toThrow("already dispatched");
    expect(store.getQueueCount("session")).toBe(0);
  });

  test("acknowledgement winning prevents dispatch from releasing the item", () => {
    const { store, path } = fixture();
    const dispatcher = new PromptQueueStore(path);
    const prompt = dispatcher.addPrompt("session", { content: "read elsewhere" })!;
    store.acknowledgePrompt("session", prompt.id, prompt.revision, "actor", "completed");
    expect(dispatcher.claimNextPrompt("session")).toBeNull();
    expect(dispatcher.removeNextPrompt("session")).toBeNull();
    expect(() => store.acknowledgePrompt("other-session", prompt.id, prompt.revision, "actor", "completed")).toThrow("not found");
  });

  test("releases only the exact rejected claim; preserves ambiguous claims across reopen", () => {
    const { store, path } = fixture();
    const prompt = store.addPrompt("session", { content: "prompt" })!;
    const claimed = store.claimNextPrompt("session")!;
    store.releaseRejectedClaim("session", prompt.id, "wrong claim");
    const reopened = new PromptQueueStore(path);
    expect(reopened.claimNextPrompt("session")).toBeNull();
    reopened.releaseRejectedClaim("session", prompt.id, claimed.claimToken!);
    expect(store.claimNextPrompt("session")?.id).toBe(prompt.id);
  });

  test("migrates legacy queue rows in place without changing IDs or payloads", () => {
    const { path } = fixture();
    const db = new Database(path);
    db.exec("DROP TABLE prompt_queue; CREATE TABLE prompt_queue (id TEXT PRIMARY KEY, session_id TEXT, content TEXT, timestamp TEXT, queue_order INTEGER)");
    db.query("INSERT INTO prompt_queue VALUES (?, ?, ?, ?, ?)").run("legacy-id", "session", "live user prompt", "2026-10-01T00:00:00Z", 1);
    db.close();
    const migrated = new PromptQueueStore(path);
    expect(migrated.getSessionQueue("session")[0]).toMatchObject({ id: "legacy-id", content: "live user prompt", revision: "1", state: "pending" });
    migrated.acknowledgePrompt("session", "legacy-id", "1", "actor", "handled");
    expect(new PromptQueueStore(path).getHandledPrompts("session")[0]?.id).toBe("legacy-id");
  });
});
