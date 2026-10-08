import { describe, expect, test } from "bun:test";
import { deriveConversationPresentation, getTurnWindowStart } from "./conversation-presentation.js";
import { getConversationWindowSnapshot } from "./conversation-window-state.js";
import { getWorkingNotesPanelKey } from "./working-notes-toggle.js";
import { renderWorkingNotesHtml } from "../rendering/chat-message-content.js";
import { findNativeTurnFinal } from "../../agents/native-sdk-contract.ts";

const row = (id, role, content = id) => ({ messageId: id, role, content, createdAt: "2026-10-08T04:00:00Z" });

describe("turn presentation", () => {
  test("groups interleaved activity without changing records, finals, errors or context", () => {
    const messages = [row("u1", "user"), row("call1", "agent-tools"),
      row("reason", "agent-thinking"), row("result1", "agent-tools"),
      row("work", "agent-working"), row("call2", "agent-tools"),
      row("context", "agent-context"), row("answer", "agent-streaming")];
    const original = JSON.stringify(messages);
    const display = deriveConversationPresentation(messages);
    expect(display.map((m) => m.role)).toEqual(["user", "agent-tools", "agent-thinking", "agent-context", "agent-streaming"]);
    expect(display[1].members).toEqual([messages[1], messages[3], messages[5]]);
    expect(display[2].members).toEqual([messages[2], messages[4]]);
    expect(findNativeTurnFinal(display)).toBeUndefined();
    expect(JSON.stringify(messages)).toBe(original);
    const final = { ...messages.at(-1), role: "assistant" };
    const complete = deriveConversationPresentation([...messages.slice(0, -1), final]);
    expect(complete[1].id).toBe(display[1].id);
    expect(findNativeTurnFinal(complete)).toBe(final);
    const failed = deriveConversationPresentation([...messages, row("error", "agent-error")]);
    expect(failed.at(-1).role).toBe("agent-error");
    expect(findNativeTurnFinal(failed)).toBeUndefined();
  });

  test("same timestamps and turn IDs cannot merge across prompts; empty groups disappear", () => {
    const messages = [row("u1", "user"), row("t1", "agent-tools"), row("empty", "agent-thinking", " "),
      row("u2", "user"), row("t2", "agent-tools"), row("w2", "agent-working")]
      .map((m) => ({ ...m, turnId: "shared" }));
    const display = deriveConversationPresentation(messages);
    expect(display.filter((m) => m.displayGroup).length).toBe(3);
    const groups = display.filter((m) => m.displayGroup);
    expect(new Set(groups.map((m) => getWorkingNotesPanelKey("session", m))).size).toBe(3);
    expect(groups[0].members.map((m) => m.messageId)).toEqual(["t1"]);
    expect(groups[1].members.map((m) => m.messageId)).toEqual(["t2"]);
    expect(deriveConversationPresentation([])).toEqual([]);
  });

  test("growing groups retain identity, all content and independently fenced Markdown", () => {
    const prompt = row("u", "user");
    const call = row("call", "agent-tools", "```json\n{\"input\":1}\n```");
    const before = deriveConversationPresentation([prompt, call])[1];
    const result = row("result:call", "agent-tools", "```\nresult\n```");
    const after = deriveConversationPresentation([prompt, call, result])[1];
    expect(after.id).toBe(before.id);
    expect(after.content).toContain(result.content);
    const html = renderWorkingNotesHtml(after.content, { workingNotesLabel: "Tools", workingNotesMembers: after.members });
    expect(html.match(/<pre>/g)?.length).toBe(2);
    expect(html).toContain('data-message-id="result:call"');
    expect(html).not.toContain(" open");
  });

  test("optimistic prompt reconciliation and reload retain the group identity", () => {
    const pending = { ...row("pending-user", "user"), id: 17, pending: true };
    const tool = row("tool", "agent-tools");
    const before = deriveConversationPresentation([pending, tool])[1];
    const canonical = { ...pending, messageId: "native-turn:user", pending: false, createdAt: "2026-10-08T04:00:01Z" };
    const after = deriveConversationPresentation([canonical, tool])[1];
    expect(after.id).toBe(before.id);
    expect(deriveConversationPresentation(JSON.parse(JSON.stringify([canonical, tool])))[1].id).toBe(before.id);
  });

  test("windowing derives the whole turn before cutting and reveals complete turns", () => {
    const messages = [];
    for (let turn = 0; turn < 30; turn++) {
      messages.push(row(`u${turn}`, "user"));
      for (let call = 0; call < 100; call++) messages.push(row(`t${turn}:${call}`, "agent-tools"));
      messages.push(row(`a${turn}`, "assistant"));
    }
    const snapshot = getConversationWindowSnapshot(new Map(), "session", messages);
    expect(snapshot.totalCount).toBe(90);
    expect(snapshot.visibleMessages[0].role).toBe("user");
    expect(snapshot.visibleMessages.filter((m) => m.displayGroup).every((m) => m.members.length === 100)).toBe(true);
    expect(snapshot.visibleCount + snapshot.hiddenCount).toBe(snapshot.totalCount);
    const display = deriveConversationPresentation(messages);
    expect(getTurnWindowStart(display, 1)).toBe(87);
    expect(getTurnWindowStart([], 80)).toBe(0);
  });
});
