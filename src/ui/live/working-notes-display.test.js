import { describe, expect, test } from "bun:test";

import { shouldDefaultWorkingNotesOpen } from "./working-notes-display.js";

describe("working notes display defaults", () => {
  test("collapses an initial thinking message", () => {
    expect(shouldDefaultWorkingNotesOpen({ role: "agent-thinking" }, true)).toBe(false);
    expect(shouldDefaultWorkingNotesOpen({ role: "agent-working" }, true)).toBe(false);
    expect(shouldDefaultWorkingNotesOpen({ role: "agent-context" }, true)).toBe(false);
  });

  test("expands thinking messages that follow the first message", () => {
    expect(shouldDefaultWorkingNotesOpen({ role: "agent-thinking" }, false)).toBe(true);
    expect(shouldDefaultWorkingNotesOpen({ role: "agent-working" }, false)).toBe(true);
    expect(shouldDefaultWorkingNotesOpen({ role: "agent-context" }, false)).toBe(true);
  });

  test("keeps tool activity collapsed by default", () => {
    expect(shouldDefaultWorkingNotesOpen({ role: "agent-tools" }, false)).toBe(false);
  });
});
