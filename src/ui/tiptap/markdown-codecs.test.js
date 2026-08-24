import { describe, expect, test } from "bun:test";

import {
  inspectMarkdownForRichEditing,
  markdownToProseMirrorDoc,
  proseMirrorDocToMarkdown,
} from "./markdown-codecs.js";

describe("markdown-codecs", () => {
  test("round-trips common markdown blocks", () => {
    const markdown = [
      "# Title",
      "",
      "Hello **bold** and [link](https://example.com).",
      "",
      "- one",
      "- two",
      "",
      "- [x] done",
      "- [ ] later",
      "",
      "```js",
      "console.log('hi');",
      "```",
      "",
      "![Alt](image.png)",
      "",
    ].join("\n");

    const doc = markdownToProseMirrorDoc(markdown);
    const next = proseMirrorDocToMarkdown(doc);

    expect(next).toContain("# Title");
    expect(next).toContain("**bold**");
    expect(next).toContain("[link](https://example.com)");
    expect(next).toContain("- one");
    expect(next).toContain("- [x] done");
    expect(next).toContain("```js");
    expect(next).toContain("console.log");
    expect(next).toContain("![Alt](image.png)");
  });

  test("flags markdown that should be reviewed in source mode", () => {
    const result = inspectMarkdownForRichEditing("---\ntitle: Hi\n---\n\n<!-- keep me -->");
    expect(result.risky).toBe(true);
    expect(result.reasons).toContain("frontmatter");
    expect(result.reasons).toContain("HTML comments");
  });

  test("does not treat a horizontal rule as frontmatter", () => {
    const result = inspectMarkdownForRichEditing("Intro\n\n---\n\nOutro");
    expect(result.reasons).not.toContain("frontmatter");
  });

  test("does not repeatedly escape ordinary punctuation", () => {
    const markdown = "Markdown files (`.md`, `.markdown`, `.mdx`) should stay file-backed.\n";
    const once = proseMirrorDocToMarkdown(markdownToProseMirrorDoc(markdown));
    const twice = proseMirrorDocToMarkdown(markdownToProseMirrorDoc(once));

    expect(once).toBe(markdown);
    expect(twice).toBe(markdown);
  });
});
