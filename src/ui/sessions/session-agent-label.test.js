import { describe, expect, test } from "bun:test";
import { getSessionAgentLabel } from "./session-agent-label.js";

describe("session agent label", () => {
  test("shows the pinned Codex transport and preserves other agent labels", () => {
    expect(getSessionAgentLabel({ agent: "codex", metadata: { agentTransport: "codex-sdk" } })).toBe("Codex (SDK)");
    expect(getSessionAgentLabel({ agent: "codex", metadata: { agentTransport: "agentapi" } })).toBe("Codex (Agent API)");
    expect(getSessionAgentLabel({ agent: "claude", metadata: { agentTransport: "agentapi" } })).toBeNull();
  });
});
