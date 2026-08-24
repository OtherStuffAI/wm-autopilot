import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./terminal-view.js", import.meta.url), "utf8");

describe("terminal-view composition", () => {
  test("masks the PIN placeholder instead of showing the default PIN", () => {
    expect(source).toContain('pinInput.placeholder = "*****";');
    expect(source).not.toContain('pinInput.placeholder = "44444";');
  });

  test("fails closed in the view when terminal setup is incomplete", () => {
    expect(source).toContain('state.config?.terminalConfigured !== true');
    expect(source).toContain('Set a terminal PIN in System settings');
  });
});
