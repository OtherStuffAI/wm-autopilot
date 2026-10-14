import { expect, test } from "bun:test";
import { NativeTurnRecords } from "./native-turn-records.ts";
import { BoundTurnActivity } from "./bound-turn-activity.ts";
import { NativeTurnRecovery } from "../sessions/completed-turn-recovery.ts";
import { completeRecord, completedItem, inputRecords, messageRecords, nativeRecord, nativeUser, toolRecords } from "./__tests__/native-turn-fixtures.ts";

test.each(["modern", "mixed", "legacy"] as const)("%s logical checkpoint excludes bootstrap, deduplicates user mirrors and counts repeated requests", format => {
  const records = new NativeTurnRecords();
  const stream = [
    ...inputRecords(format, "  inspect\nexample  ", "first"), ...messageRecords(format, "old answer", "first", "final_answer"), completeRecord("old answer", format === "legacy" ? undefined : "first"),
    ...inputRecords(format, "  inspect\nexample  ", "second"), ...toolRecords("second"), ...messageRecords(format, "new answer", "second", "final_answer"), completeRecord("new answer", format === "legacy" ? undefined : "second"),
  ];
  stream.forEach(record => records.visit(record));
  expect(records.count).toBe(2);
  const recovery = new NativeTurnRecovery(1, "  inspect\nexample  ");
  stream.forEach(record => recovery.visit(record));
  expect(recovery.reply).toBe("new answer");
});

test("legacy history followed by modern input has the same exact boundary in all three readers", () => {
  const stream = [
    ...inputRecords("legacy", "same", "first"), ...messageRecords("legacy", "old", "first", "final_answer"), completeRecord("old"),
    ...inputRecords("mixed", "same", "second"), ...messageRecords("mixed", "Checking example files", "second"), ...toolRecords("second"),
    ...messageRecords("mixed", "current", "second", "final_answer"), completeRecord("current", "second"),
  ];
  const checkpoint = new NativeTurnRecords(), projection = new BoundTurnActivity(1, "same"), recovery = new NativeTurnRecovery(1, "same");
  stream.forEach(record => { checkpoint.visit(record); projection.visit(record); recovery.visit(record); });
  expect(checkpoint.count).toBe(2);
  expect(projection.activities.map(item => item.content)).toEqual(["Checking example files", "Using tools"]);
  expect(projection.finalResponse).toBe("current");
  expect(recovery.reply).toBe("current");
});

test("replayed old user blocks and foreign turn items cannot select or complete the bound request", () => {
  const stream = [
    ...inputRecords("modern", "same", "old"), completeRecord("old", "old"),
    ...inputRecords("modern", "same", "bound"),
    nativeUser("same", "old"),
    completedItem({ type: "AgentMessage", id: "foreign", phase: "commentary", content: [{ type: "Text", text: "foreign public" }] }, "other"),
    completedItem({ type: "AgentMessage", id: "foreign-final", phase: "final_answer", content: [{ type: "Text", text: "foreign final" }] }, "other"),
    completeRecord("foreign final", "other"),
    ...messageRecords("modern", "Bound public", "bound"), ...toolRecords("bound"),
    ...messageRecords("modern", "Bound final", "bound", "final_answer"), completeRecord("Bound final", "bound"),
    ...messageRecords("modern", "late", "bound"),
  ];
  const records = new NativeTurnRecords(), projection = new BoundTurnActivity(1, "same"), recovery = new NativeTurnRecovery(1, "same");
  stream.forEach(record => { records.visit(record); projection.visit(record); recovery.visit(record); });
  expect(records.count).toBe(2);
  expect(projection.activities.map(item => item.content)).toEqual(["Bound public", "Using tools"]);
  expect(recovery.reply).toBe("Bound final");
  expect(JSON.stringify(projection.activities)).not.toMatch(/foreign|PRIVATE|late/);
});

test("next native turn closes selection before its bootstrap or final; prompt mismatch never searches ahead", () => {
  const projection = new BoundTurnActivity(0, "exact"), recovery = new NativeTurnRecovery(0, "exact");
  const stream = [...inputRecords("modern", "exact", "first"), ...messageRecords("modern", "first public", "first"),
    ...inputRecords("modern", "exact", "second"), ...messageRecords("modern", "wrong final", "second", "final_answer"), completeRecord("wrong final", "second")];
  stream.forEach(record => { projection.visit(record); recovery.visit(record); });
  expect(projection.activities.map(item => item.content)).toEqual(["first public"]);
  expect(recovery.reply).toBeNull();
  for (const reader of [new BoundTurnActivity(0, "expected"), new NativeTurnRecovery(0, "expected")]) {
    expect(() => inputRecords("modern", "different", "first").forEach(record => reader.visit(record))).toThrow("exact bound prompt/request");
  }
});

test("stable assistant item ID deduplicates a delayed mirror without suppressing distinct identical commentary", () => {
  const projection = new BoundTurnActivity(0, "inspect");
  inputRecords("modern", "inspect", "turn").forEach(record => projection.visit(record));
  const [item, mirror] = messageRecords("modern", "Inspecting example", "turn");
  projection.visit(item!);
  toolRecords("turn").forEach(record => projection.visit(record));
  projection.visit({ ...mirror!, timestamp: "2026-10-14T00:00:10.000Z" });
  projection.visit(nativeRecord("response_item", { ...mirror!.payload, id: "distinct-message" }, "2026-10-14T00:00:11.000Z"));
  toolRecords("turn").forEach(record => projection.visit(record));
  expect(projection.activities.map(item => item.content)).toEqual(["Inspecting example", "Using tools", "Inspecting example", "Using tools"]);
});

test("unsupported unscoped response users do not count; item-only modern events recognize explicit public phases", () => {
  const records = new NativeTurnRecords();
  records.visit(nativeRecord("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "replayed environment" }] }));
  expect(records.count).toBe(0);
  const projection = new BoundTurnActivity(0, "request");
  const recovery = new NativeTurnRecovery(0, "request");
  const stream = [nativeRecord("event_msg", { type: "task_started", turn_id: "turn" }),
    completedItem({ type: "UserMessage", id: "user", content: [{ type: "text", text: "request" }] }, "turn"),
    messageRecords("modern", "Public update", "turn")[0]!, ...toolRecords("turn"),
    messageRecords("modern", "Full final", "turn", "final_answer")[0]!, completeRecord("Full final", "turn")];
  stream.forEach(record => { projection.visit(record); recovery.visit(record); });
  expect(projection.activities.map(item => item.content)).toEqual(["Public update", "Using tools"]);
  expect(recovery.reply).toBe("Full final");
});

test("same native turn with inconsistent input fails clearly rather than shifting a checkpoint", () => {
  const records = new NativeTurnRecords();
  inputRecords("modern", "first", "turn").forEach(record => records.visit(record));
  expect(() => records.visit(nativeUser("substituted", "turn"))).toThrow("inconsistent user input");
});

test("modern history followed by a legacy request preserves logical ordinal and public isolation", () => {
  const stream = [...inputRecords("modern", "old", "first"), ...messageRecords("modern", "old final", "first", "final_answer"), completeRecord("old final", "first"),
    ...inputRecords("legacy", "new", "second"), ...messageRecords("legacy", "New public", "second"), ...messageRecords("legacy", "new final", "second", "final_answer"), completeRecord("new final")];
  const records = new NativeTurnRecords(), projection = new BoundTurnActivity(1, "new"), recovery = new NativeTurnRecovery(1, "new");
  stream.forEach(record => { records.visit(record); projection.visit(record); recovery.visit(record); });
  expect(records.count).toBe(2);
  expect(projection.activities.map(item => item.content)).toEqual(["New public"]);
  expect(recovery.reply).toBe("new final");
});

test("turn context does not authorize unannotated replayed users and switching context permanently closes selection", () => {
  const records = new NativeTurnRecords(), projection = new BoundTurnActivity(0, "actual"), recovery = new NativeTurnRecovery(0, "actual");
  const unknown = (text: string) => nativeRecord("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
  const stream = [nativeRecord("event_msg", { type: "task_started", turn_id: "bound" }), nativeRecord("turn_context", { turn_id: "bound" }),
    unknown("# AGENTS.md instructions"), unknown("<environment_context>Replay</environment_context>"), unknown("historical prompt"), unknown("actual"),
    completedItem({ type: "UserMessage", id: "actual-input", content: [{ type: "text", text: "actual" }] }, "bound"),
    ...messageRecords("modern", "Bound public", "bound"), nativeRecord("turn_context", { turn_id: "other" }),
    ...messageRecords("modern", "foreign public", "other"), nativeRecord("turn_context", { turn_id: "bound" }),
    ...messageRecords("modern", "late final", "bound", "final_answer"), completeRecord("late final", "bound")];
  stream.forEach(record => { records.visit(record); projection.visit(record); recovery.visit(record); });
  expect(records.count).toBe(1);
  expect(projection.activities.map(item => item.content)).toEqual(["Bound public"]);
  expect(projection.finalResponse).toBeNull();
  expect(recovery.reply).toBeNull();
});
