import { describe, expect, test } from "bun:test";

import { getFileExtension, shouldUseTiptapForFile } from "./editor-mode.js";

describe("editor-mode", () => {
  test("routes markdown files to TipTap", () => {
    expect(shouldUseTiptapForFile("/workspace/README.md")).toBe(true);
    expect(shouldUseTiptapForFile("/workspace/notes.markdown")).toBe(true);
    expect(shouldUseTiptapForFile("/workspace/page.mdx")).toBe(true);
  });

  test("keeps non-markdown files on the existing writer path", () => {
    expect(shouldUseTiptapForFile("/workspace/app.ts")).toBe(false);
    expect(shouldUseTiptapForFile("/workspace/data.json")).toBe(false);
  });

  test("extracts extensions from absolute paths", () => {
    expect(getFileExtension("/workspace/docs/tiptap-docs.md")).toBe(".md");
  });
});
