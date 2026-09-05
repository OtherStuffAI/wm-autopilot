import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./completion-notifications-section.js", import.meta.url), "utf8");

describe("completion notifications settings", () => {
  test("provides an accessible persistent sound toggle", () => {
    expect(source).toContain('section.dataset.testid = "completion-notifications-settings"');
    expect(source).toContain('checkbox.dataset.testid = "completion-sound-enabled"');
    expect(source).toContain('checkbox.setAttribute("aria-label", "Play a sound when a session completes")');
    expect(source).toContain('status.setAttribute("aria-live", "polite")');
    expect(source).toContain("soundController.setEnabled(enabled)");
    expect(source).toContain("soundController.preview()");
  });
});
