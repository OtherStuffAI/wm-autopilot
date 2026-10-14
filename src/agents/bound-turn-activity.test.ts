import { expect, test } from "bun:test";
import { BoundTurnActivity } from "./bound-turn-activity.ts";

const record = (type: string, payload: Record<string, unknown>, timestamp = "2026-10-14T00:00:01.000Z") => ({ type, payload, timestamp });
const user = (message: string) => record("event_msg", { type: "user_message", message });
const commentary = (message: string) => record("event_msg", { type: "agent_message", phase: "commentary", message });
const tool = () => record("response_item", { type: "function_call", name: "secret-tool", arguments: "PRIVATE ARGUMENTS" });

test("exact turn checkpoint excludes older identical prompts and stops at next user", () => {
  const projection = new BoundTurnActivity(1, "same prompt");
  [user("same prompt"), commentary("old"), tool(), user("same prompt"), commentary("current"), user("later"), commentary("future")].forEach(item => projection.visit(item));
  expect(projection.activities.map(item => item.content)).toEqual(["current"]);
  const mismatch = new BoundTurnActivity(1, "same prompt");
  mismatch.visit(user("old"));
  expect(() => mismatch.visit(user("foreign prompt"))).toThrow("exact bound prompt");
});

test("public mirrors deduplicate; consecutive tools coalesce without reasoning or args/output", () => {
  const projection = new BoundTurnActivity(0, "prompt");
  [user("prompt"), commentary("Checking the files"), record("response_item", { type: "message", role: "assistant", phase: "commentary", content: [{ text: "Checking the files" }] }),
    record("response_item", { type: "reasoning", summary: "PRIVATE REASONING" }), tool(), tool(),
    record("response_item", { type: "function_call_output", output: "PRIVATE OUTPUT" }), tool(), commentary("Applying the change"), tool(),
    record("event_msg", { type: "agent_message", phase: "final_answer", message: "Full final\n\nanswer" }),
    record("event_msg", { type: "task_complete" }), commentary("too late"), tool()].forEach(item => projection.visit(item));
  expect(projection.activities.map(item => [item.type, item.content])).toEqual([
    ["commentary", "Checking the files"], ["tools", "Using tools"], ["commentary", "Applying the change"], ["tools", "Using tools"],
  ]);
  expect(projection.finalResponse).toBe("Full final\n\nanswer");
  expect(JSON.stringify(projection.activities)).not.toContain("PRIVATE");
  expect(JSON.stringify(projection.activities)).not.toContain("secret-tool");
});

test("unlabelled assistant text stays private, event count/content are bounded", () => {
  const projection = new BoundTurnActivity(0, "prompt");
  projection.visit(user("prompt"));
  projection.visit(record("event_msg", { type: "agent_message", message: "unlabelled" }));
  for (let i = 0; i < 300; i++) projection.visit(commentary(`${i}${"x".repeat(5000)}`));
  expect(projection.activities).toHaveLength(256);
  expect(projection.activities.every(item => item.content.length <= 4000)).toBe(true);
});
