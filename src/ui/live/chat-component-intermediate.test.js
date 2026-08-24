import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./chat-component.js", import.meta.url), "utf8");

describe("ACP intermediate output presentation", () => {
  test("labels assistant output as intermediate only while runtime status is running", () => {
    expect(source).toContain("if (!this.isBusy || !isReadableAgentMessage(message)) return false;");
    expect(source).toContain("return messageIndex > latestUserIndex;");
    expect(source).toContain("Intermediate · agent loop still running");
    expect(source).toContain('data-testid="intermediate-agent-output"');
    expect(source).toContain('return this.status === "running";');
  });
});
