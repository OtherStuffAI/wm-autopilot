import { describe, expect, test } from "bun:test";

import { buildCommentAnchor } from "./comment-anchor.js";

describe("comment-anchor", () => {
  test("builds resilient quote anchors from source selections", () => {
    const sourceEditor = {
      value: "# Intro\n\nAlpha beta gamma delta.\n",
      selectionStart: 9,
      selectionEnd: 19,
    };

    const anchor = buildCommentAnchor({
      markdown: sourceEditor.value,
      mode: "source",
      sourceEditor,
    });

    expect(anchor.text).toBe("Alpha beta");
    expect(anchor.blockHint).toBe("# Intro");
    expect(anchor.suffix).toContain("gamma");
  });
});
