import { describe, expect, test } from "bun:test";

import { TERMINAL_CONTROL_ACTIONS } from "../state/index.js";
import { resolveTerminalControlKeyAction } from "./terminal-controls.js";

function keyEvent(key, options = {}) {
  return {
    key,
    shiftKey: Boolean(options.shiftKey),
  };
}

describe("terminal control key handling", () => {
  test("maps empty composer navigation keys to raw terminal controls", () => {
    expect(resolveTerminalControlKeyAction(keyEvent("Enter"), "", TERMINAL_CONTROL_ACTIONS)?.id)
      .toBe("terminal-return");
    expect(resolveTerminalControlKeyAction(keyEvent("ArrowUp"), "", TERMINAL_CONTROL_ACTIONS)?.id)
      .toBe("terminal-up");
    expect(resolveTerminalControlKeyAction(keyEvent("ArrowDown"), "", TERMINAL_CONTROL_ACTIONS)?.id)
      .toBe("terminal-down");
    expect(resolveTerminalControlKeyAction(keyEvent("Escape"), "", TERMINAL_CONTROL_ACTIONS)?.id)
      .toBe("terminal-esc");
    expect(resolveTerminalControlKeyAction(keyEvent("Tab", { shiftKey: true }), "", TERMINAL_CONTROL_ACTIONS)?.id)
      .toBe("terminal-shift-tab");
  });

  test("does not steal keys while the composer contains text", () => {
    expect(resolveTerminalControlKeyAction(keyEvent("Enter"), "hello", TERMINAL_CONTROL_ACTIONS)).toBeNull();
    expect(resolveTerminalControlKeyAction(keyEvent("ArrowUp"), "hello", TERMINAL_CONTROL_ACTIONS)).toBeNull();
    expect(resolveTerminalControlKeyAction(keyEvent("Escape"), "hello", TERMINAL_CONTROL_ACTIONS)).toBeNull();
  });

  test("leaves shift-enter for multiline composer input", () => {
    expect(resolveTerminalControlKeyAction(keyEvent("Enter", { shiftKey: true }), "", TERMINAL_CONTROL_ACTIONS))
      .toBeNull();
  });
});
