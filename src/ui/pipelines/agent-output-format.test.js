import { describe, expect, test } from "bun:test";

import { cleanAgentOutputText } from "./agent-output-format.js";

describe("pipeline agent output formatting", () => {
  test("removes terminal padding and joins likely soft-wrapped prose", () => {
    const text = [
      "Cleartext should be                                           ",
      "  only what is required for relay discovery/filtering and safe public",
      "",
      "Kind 33355",
      "",
      "Recipient: Flight Deck app npub.",
    ].join("\n");

    expect(cleanAgentOutputText(text)).toBe([
      "Cleartext should be only what is required for relay discovery/filtering and safe public",
      "",
      "Kind 33355",
      "",
      "Recipient: Flight Deck app npub.",
    ].join("\n"));
  });

  test("joins split urls without inserting spaces", () => {
    const text = "See https://example.com/path/\nwith-query?foo=bar for details.";

    expect(cleanAgentOutputText(text)).toBe("See https://example.com/path/with-query?foo=bar for details.");
  });

  test("preserves code fences and list boundaries", () => {
    const text = [
      "Steps",
      "- First item",
      "- Second item",
      "```bash",
      "bun test \\",
      "  src/ui/pipelines/agent-output-format.test.js",
      "```",
    ].join("\n");

    expect(cleanAgentOutputText(text)).toBe(text);
  });
});
