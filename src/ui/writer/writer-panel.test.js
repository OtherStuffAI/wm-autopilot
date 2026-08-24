import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./writer-panel.js", import.meta.url), "utf8");

describe("writer-panel toolbar", () => {
  test("offers a chat collapse control before the width cycle", () => {
    expect(source).toContain("wm-writer-fullscreen-toggle");
    expect(source).toContain('"chat-collapsed"');
    expect(source).toContain('fullscreenBtn.innerHTML = createSideCollapseIcon("left")');
    expect(source).toContain("modeGroup.append(fullscreenBtn, viewSizeBtn)");
  });

  test("uses mirrored icons for left and right toolbar collapse controls", () => {
    expect(source).toContain("function createSideCollapseIcon(side)");
    expect(source).toContain('closeBtn.innerHTML = createSideCollapseIcon("right")');
    expect(source).not.toContain('textContent = "<-|"');
  });
});
