import { expect, test } from "bun:test";
import { parseNativeCodexResult } from "./native-codex-result.ts";
const id = "11111111-2222-3333-4444-555555555555";
const started = { type: "thread.started", thread_id: id };
const message = { type: "item.completed", item: { type: "agent_message", text: "Done" } };
const completed = { type: "turn.completed" };
const lines = (...events: object[]) => events.map((event) => JSON.stringify(event)).join("\n");
test("requires native completion and the same resume reference", () => {
  expect(parseNativeCodexResult(lines(started, message, completed), id)).toEqual({ nativeReference: id, reply: "Done" });
  for (const events of [[started, message], [started, message, { type: "turn.failed" }],
    [started, message, completed, { type: "error" }], [started, message, completed, completed],
    [started, completed], [{ ...started, thread_id: "-".repeat(36) }, message, completed]]) {
    expect(() => parseNativeCodexResult(lines(...events))).toThrow();
  }
  expect(() => parseNativeCodexResult(lines(started, message, completed), "aaaaaaaa-2222-3333-4444-555555555555")).toThrow();
});
