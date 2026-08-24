import { describe, expect, test } from "bun:test";

import {
  appendCommentMessage,
  combineMarkdownAndComments,
  createCommentThread,
  parseAutopilotCommentEndmatter,
} from "./comment-endmatter.js";

describe("comment-endmatter", () => {
  test("writes and parses autopilot comment threads at the end of markdown", () => {
    const thread = createCommentThread({
      anchor: { type: "quote", text: "important sentence", prefix: "An", suffix: "here", blockHint: "## Notes" },
      body: "Please clarify this.",
      author: "Example Operator",
    });
    const markdown = combineMarkdownAndComments("Body text\n", [thread]);

    expect(markdown).toContain("<!-- autopilot-comments:start");
    expect(markdown).toContain("autopilot-comments:end -->");

    const parsed = parseAutopilotCommentEndmatter(markdown);
    expect(parsed.body).toBe("Body text\n");
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.threads[0].anchor.text).toBe("important sentence");
    expect(parsed.threads[0].messages[0].body).toBe("Please clarify this.");
  });

  test("appends replies without dropping existing messages", () => {
    const thread = createCommentThread({
      anchor: { type: "quote", text: "alpha" },
      body: "First",
    });
    const next = appendCommentMessage(thread, "Second");
    expect(next.messages.map((message) => message.body)).toEqual(["First", "Second"]);
  });

  test("surfaces invalid comment JSON without stripping the source", () => {
    const markdown = "Body\n\n<!-- autopilot-comments:start\nnot json\nautopilot-comments:end -->\n";
    const parsed = parseAutopilotCommentEndmatter(markdown);
    expect(parsed.body).toBe(markdown);
    expect(parsed.threads).toEqual([]);
    expect(parsed.error).toContain("invalid JSON");
  });
});
