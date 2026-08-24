import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./tiptap-file-panel.js", import.meta.url), "utf8");

describe("tiptap-file-panel comments", () => {
  test("wires selected comment threads to document highlighting", () => {
    expect(source).toContain("highlightCommentAnchor");
    expect(source).toContain("markActiveCommentThread");
    expect(source).toContain("onSelectThread: selectCommentThread");
    expect(source).toContain("activeThreadId: activeCommentThreadId");
  });

  test("uses the TipTap callback editor during update events", () => {
    const onUpdateBlock = source.match(/onUpdate\(\{ editor: activeEditor \}\) \{[\s\S]*?\n      \},/);
    expect(source).toContain("function getEditorMarkdown(activeEditor = editor)");
    expect(source).toContain("activeEditor.getJSON()");
    expect(onUpdateBlock?.[0]).toContain("getEditorMarkdown(activeEditor)");
    expect(onUpdateBlock?.[0]).not.toContain("editor.getJSON()");
  });
});
