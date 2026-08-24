import { describe, expect, test } from "bun:test";

import { findCommentAnchorRange } from "./comment-highlight.js";

function createMockEditor(text, nodes = [{ text, pos: 0 }]) {
  const blockNode = {
    isTextblock: true,
    textContent: text,
    descendants(callback) {
      for (const node of nodes) {
        callback({ isText: true, text: node.text }, node.pos);
      }
    },
  };
  return {
    state: {
      doc: {
        descendants(callback) {
          callback(blockNode, 0);
        },
      },
    },
  };
}

describe("comment-highlight", () => {
  test("finds a quote anchor range in the editor document", () => {
    const editor = createMockEditor("Intro anchored phrase outro");

    expect(findCommentAnchorRange(editor, { text: "anchored phrase" })).toEqual({
      from: 7,
      to: 22,
    });
  });

  test("returns null when the quote is no longer present", () => {
    expect(findCommentAnchorRange(createMockEditor("Intro outro"), { text: "missing" })).toBeNull();
  });

  test("finds a quote anchor split across inline text nodes", () => {
    const editor = createMockEditor("Intro anchored phrase outro", [
      { text: "Intro anchored", pos: 0 },
      { text: " phrase outro", pos: 14 },
    ]);

    expect(findCommentAnchorRange(editor, { text: "anchored phrase" })).toEqual({
      from: 7,
      to: 22,
    });
  });
});
