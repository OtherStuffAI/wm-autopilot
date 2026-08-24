import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./session-api-routes.ts", import.meta.url), "utf8");

describe("session speech route", () => {
  test("does not generate speech while the agent response is still running", () => {
    expect(source).toContain('liveOwnedSession?.agentRuntimeStatus === "running"');
    expect(source).toContain("Speech can only be generated after the agent response is complete");
    expect(source).toContain("Speech is only available for assistant messages");
  });
});
