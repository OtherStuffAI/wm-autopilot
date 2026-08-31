import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./chat-component.js", import.meta.url), "utf8");
const legacySource = readFileSync(new URL("./conversation-window.js", import.meta.url), "utf8");

describe("agent error presentation", () => {
  test("renders provider failures as accessible live alerts", () => {
    expect(source).toContain('return role === "agent-error";');
    expect(source).toContain(':role="$store.chat.isErrorMessage(message) ? \'alert\' : null"');
    expect(source).toContain(':aria-live="$store.chat.isErrorMessage(message) ? \'assertive\' : null"');
    expect(source).toContain("agent-error-message");
  });

  test("keeps accessible error alerts in the legacy renderer", () => {
    expect(legacySource).toContain('bubble.setAttribute("role", "alert")');
    expect(legacySource).toContain('bubble.setAttribute("aria-live", "assertive")');
    expect(legacySource).toContain('bubble.dataset.testid = "agent-error-message"');
  });
});
