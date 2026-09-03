import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { formatMessageTimestamp } from "./message-timestamp.js";

const chatComponentSource = readFileSync(new URL("./chat-component.js", import.meta.url), "utf8");
const timestampSource = readFileSync(new URL("./message-timestamp.js", import.meta.url), "utf8");

describe("formatMessageTimestamp", () => {
  const options = { locale: "en-AU", timeZone: "UTC" };

  test("formats the server timestamp for user questions", () => {
    expect(formatMessageTimestamp({ role: "user", createdAt: "2026-09-03T12:34:56.000Z" }, options))
      .toBe("3 Sep 2026 - 12:34:56 pm");
  });

  test("formats assistant answers with legacy timestamp fields", () => {
    expect(formatMessageTimestamp({ type: "agent", created_at: "2026-09-03T02:04:05.000Z" }, options))
      .toBe("3 Sep 2026 - 02:04:05 am");
  });

  test("does not add timestamps to thinking, tools, or invalid messages", () => {
    expect(formatMessageTimestamp({ role: "agent-thinking", createdAt: "2026-09-03T12:34:56.000Z" }, options)).toBe("");
    expect(formatMessageTimestamp({ role: "agent-tools", createdAt: "2026-09-03T12:34:56.000Z" }, options)).toBe("");
    expect(formatMessageTimestamp({ role: "assistant", createdAt: "invalid" }, options)).toBe("");
  });

  test("keeps every message action to the right of the timestamp", () => {
    const template = chatComponentSource.slice(chatComponentSource.indexOf("export function getChatTemplate"));
    const timestampIndex = template.indexOf('class="wm-message-timestamp"');
    expect(timestampIndex).toBeLessThan(template.indexOf('class="wm-message-speech-play"'));
    expect(timestampIndex).toBeLessThan(template.indexOf('class="wm-message-copy"'));
    expect(timestampSource).toContain("actions.prepend(time)");
  });
});
