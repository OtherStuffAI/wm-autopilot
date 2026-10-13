import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectChatTurnStore, type DirectChatTurnRecord } from "./direct-chat-turn-store";
import { directChatPublicationIntegrityError } from "./direct-chat-publication-observation";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "direct-chat-store-"));
  const path = join(root, "turns.sqlite");
  const store = new DirectChatTurnStore(path);
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const at = "2026-09-28T00:00:00.000Z";
  const record: DirectChatTurnRecord = { turnId: "turn", routingKey: "route", sourceMessageIds: ["source"],
    clientRequestId: "request", replyBody: null, publishedMessageId: null, state: "awaiting_reply",
    createdAt: at, updatedAt: at, sessionId: "session", threadId: "thread", agentNpub: "agent" };
  store.save(record);
  return { store, path, record, at };
}

describe("Agent Direct immutable publication ownership", () => {
  test("identical and conflicting re-freezes preserve an in-flight lease and attempt", () => {
    const { store, at } = fixture();
    store.freezeReply("turn", "Final", at);
    const publishing = store.claim("turn", "publisher", at, 30_000)!;
    expect(store.freezeReply("turn", "Final", at)).toEqual(publishing);
    expect(() => store.freezeReply("turn", "Different final", at)).toThrow("publication payload is immutable");
    expect(store.get("turn")).toEqual(publishing);
    expect(store.claim("turn", "competitor", at, 30_000)).toBeNull();
    expect(store.markPublished("turn", "publisher", "message", at)?.state).toBe("published");
  });

  test("stale snapshots cannot rewrite frozen session/source IDs or retry scheduling", () => {
    const { store, record, at } = fixture();
    store.freezeReply("turn", "Final", at);
    store.claim("turn", "publisher", at, 30_000);
    store.markRetry("turn", "publisher", "2026-09-28T00:01:00.000Z", "Unavailable", "tower_503");
    const waiting = store.get("turn")!;
    store.save({ ...record, sessionId: "replacement", sourceMessageIds: ["new-source"], state: "failed" });
    expect(store.get("turn")).toEqual(waiting);
    expect(store.freezeReply("turn", "Final")).toEqual(waiting);
    expect(directChatPublicationIntegrityError(waiting)).toBeNull();
  });

  test("late failures and integrity halts cannot downgrade confirmed publication", () => {
    const { store, record, at } = fixture();
    store.freezeReply("turn", "Final", at);
    store.claim("turn", "publisher", at, 30_000);
    const published = store.markPublished("turn", "publisher", "message", at)!;
    store.markFailed("turn", "dispatch_failed", "Late waiter failure");
    store.markIntegrityHalt("turn", "immutable_payload_mismatch", "Late mismatch");
    store.save({ ...record, state: "awaiting_reply" });
    expect(() => store.freezeReply("turn", "Late different body")).toThrow();
    expect(store.get("turn")).toEqual(published);
  });

  test("an expired publisher cannot claim completion under a newer lease", () => {
    const { store, at } = fixture();
    store.freezeReply("turn", "Final", at);
    store.claim("turn", "old-publisher", at, 1_000);
    const newer = store.claim("turn", "new-publisher", "2026-09-28T00:00:02.000Z", 30_000)!;
    expect(store.markPublished("turn", "old-publisher", "message")).toBeNull();
    expect(store.get("turn")).toEqual(newer);
    expect(store.markPublished("turn", "new-publisher", "message")?.state).toBe("published");
  });

  test("detects actual stored body, session and source-ID corruption", () => {
    for (const [column, value] of [["session_id", "other-session"], ["source_message_ids_json", '["other-source"]'],
      ["publication_payload_json", '{"body":"tampered"}']] as const) {
      const { store, path, at } = fixture();
      store.freezeReply("turn", "Final", at);
      const db = new Database(path);
      db.query(`UPDATE agent_direct_chat_turns SET ${column}=?1 WHERE turn_id='turn'`).run(value);
      db.close();
      expect(directChatPublicationIntegrityError(store.get("turn")!)).not.toBeNull();
    }
  });
});

test("same-native recovery reopens interrupted ownership and cannot rewind a frozen final", () => {
  const f = fixture();
  f.store.markFailed("turn", "session_missing", "Archived without final", f.at);
  expect(f.store.getInterruptedSessionTurn("session", "route")?.turnId).toBe("turn");
  expect(f.store.rebindAcceptedSession("turn", "session", "replacement")).toMatchObject({ state: "awaiting_reply",
    sessionId: "replacement", clientRequestId: "request", replyBody: null });
  f.store.freezeReply("turn", "Verified final.");
  expect(f.store.rebindAcceptedSession("turn", "replacement", "another")).toBeNull();
  expect(f.store.get("turn")).toMatchObject({ state: "reply_ready", sessionId: "replacement", replyBody: "Verified final." });
});
