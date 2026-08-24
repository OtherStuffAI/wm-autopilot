import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./comments-panel.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("comments-panel mobile ergonomics", () => {
  test("keeps comment and reply textareas collapsed until explicitly opened", () => {
    expect(source).toContain("body.hidden = !defaultOpen;");
    expect(source).toContain("form.hidden = true;");
    expect(source).toContain("replyForm.hidden = true;");
  });

  test("does not auto-focus textareas when disclosure buttons are tapped", () => {
    expect(source).not.toContain(".focus()");
  });

  test("supports image upload and markdown rendering for comment bodies", () => {
    expect(source).toContain("uploadPastedImage");
    expect(source).toContain("renderMarkdownToHtml");
    expect(source).toContain("![${savedName}](${savedName})");
  });

  test("captures the selected anchor before the mobile comment form takes focus", () => {
    expect(source).toContain("onPrepareThread");
    expect(source).toContain("pendingThreadAnchor = onPrepareThread?.() ?? null;");
    expect(source).toContain("onAddThread?.(textarea.value, pendingThreadAnchor);");
  });

  test("supports selecting a thread to highlight its document anchor", () => {
    expect(source).toContain("onSelectThread");
    expect(source).toContain("item.dataset.active");
    expect(source).toContain("item.dataset.threadId");
    expect(source).toContain("deps.onSelectThread?.(thread.id);");
  });

  test("keeps the comments body scrollable when the rail overflows", () => {
    const panelRule = styles.match(/\.wm-tiptap-comments\s*\{(?<body>[^}]+)\}/);
    const bodyRule = styles.match(/\.wm-tiptap-comments__body\s*\{(?<body>[^}]+)\}/);
    const listRule = styles.match(/\.wm-tiptap-comments__list\s*\{(?<body>[^}]+)\}/);

    expect(panelRule?.groups?.body).toContain("grid-template-rows: auto minmax(0, 1fr);");
    expect(bodyRule?.groups?.body).toContain("overflow-y: auto;");
    expect(bodyRule?.groups?.body).toContain("min-height: 0;");
    expect(listRule?.groups?.body).toContain("align-content: start;");
  });

  test("renders mobile comments as a bounded bottom drawer", () => {
    const mobileRule = styles.match(/@media \(max-width: 768px\) \{[\s\S]+?\.wm-artifact-file-selector/);

    expect(mobileRule?.[0]).toContain("position: sticky;");
    expect(mobileRule?.[0]).toContain("bottom: 0;");
    expect(mobileRule?.[0]).toContain("max-height: min(46vh, 28rem);");
    expect(mobileRule?.[0]).toContain("max-height: 8rem;");
  });
});
