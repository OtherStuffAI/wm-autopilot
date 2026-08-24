import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./header-fullscreen-toggle.js", import.meta.url), "utf8");

describe("live header fullscreen toggle", () => {
  test("uses accessible labels for both header states", () => {
    expect(source).toContain('collapsed ? "Show header" : "Hide header"');
    expect(source).toContain('button.setAttribute("aria-pressed", collapsed ? "true" : "false")');
    expect(source).toContain('button.setAttribute("data-testid", "live-header-fullscreen-toggle")');
  });

  test("renders corner paths for fullscreen and restore states", () => {
    expect(source).toContain("M8 4H4v4");
    expect(source).toContain("M9 4v5H4");
  });
});
