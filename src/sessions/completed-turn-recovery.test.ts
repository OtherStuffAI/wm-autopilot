import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputRecords, messageRecords, completeRecord, completedItem } from "../agents/__tests__/native-turn-fixtures.ts";
import { nativeTurnCheckpoint, recoverNativeTurn } from "./completed-turn-recovery.ts";
import { readBoundTurnActivity } from "../agents/bound-turn-activity.ts";

test("real native file reader verifies conversation/directory and shared saved checkpoint across two modern turns", async () => {
  const home = mkdtempSync(join(tmpdir(), "native-checkpoint-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    mkdirSync(join(home, "sessions"));
    const path = join(home, "sessions", "rollout-native-conversation.jsonl");
    const context = { nativeSessionId: "native-conversation", directory: home };
    const meta = { type: "session_meta", payload: { id: context.nativeSessionId, cwd: home } };
    const first = [meta, ...inputRecords("modern", "same", "first"), ...messageRecords("modern", "Historical public", "first"),
      ...messageRecords("modern", "Old final", "first", "final_answer"), completeRecord("Old final", "first")];
    const save = (rows: unknown[]) => writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    save(first);
    const checkpoint = await nativeTurnCheckpoint(context);
    expect(checkpoint).toBe(1);
    const full = "Complete answer\n\n" + "details ".repeat(2000);
    const both = [...first, ...inputRecords("mixed", "same", "second"), ...messageRecords("mixed", "Current public", "second"),
      ...messageRecords("modern", full, "second", "final_answer"), completeRecord(full, "second")];
    save(both);
    expect(await nativeTurnCheckpoint(context)).toBe(2);
    expect(await recoverNativeTurn(context, checkpoint, "same")).toBe(full);
    expect((await readBoundTurnActivity(context, checkpoint, "same")).activities.map(item => item.content)).toEqual(["Current public"]);
    await expect(recoverNativeTurn(context, checkpoint, " same")).rejects.toThrow("exact bound");
    await expect(nativeTurnCheckpoint({ ...context, directory: join(home, "foreign") })).rejects.toThrow("unavailable");
    await expect(nativeTurnCheckpoint({ ...context, nativeSessionId: "foreign" })).rejects.toThrow("unavailable");
    const foreign = completedItem({ type: "UserMessage", content: [{ type: "text", text: "same" }] }, "second");
    foreign.payload.thread_id = "foreign-conversation";
    save([...both, foreign]);
    await expect(nativeTurnCheckpoint(context)).rejects.toThrow("conversation mismatch");
    await expect(readBoundTurnActivity(context, checkpoint, "same")).rejects.toThrow("conversation mismatch");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
