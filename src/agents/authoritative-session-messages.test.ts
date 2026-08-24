import { describe, expect, test } from "bun:test";

import type { SessionSnapshot } from "./process-manager";
import { resolveAuthoritativeSessionMessages } from "./authoritative-session-messages";

describe("resolveAuthoritativeSessionMessages", () => {
  test("does not fall back to an AgentAPI PTY scrape when native Codex reading fails", async () => {
    const liveMessages = [
      { role: "user", content: "Fix this", createdAt: "2026-08-20T00:00:01.000Z" },
      { role: "agent", content: "thinking tools and final combined", createdAt: "2026-08-20T00:00:02.000Z" },
    ];
    const session = {
      id: "agentapi-session",
      agent: "codex",
      metadata: {
        agentTransport: "agentapi",
        nativeAgentSession: {
          agent: "codex",
          sessionId: "temporarily-missing",
          workingDirectory: "/repo",
          source: "agentapi",
        },
      },
    } as SessionSnapshot;

    await expect(resolveAuthoritativeSessionMessages(session, liveMessages)).resolves.toEqual([]);
  });
});
