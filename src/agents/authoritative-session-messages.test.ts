import { describe, expect, test } from "bun:test";

import type { SessionSnapshot } from "./process-manager";
import { resolveAuthoritativeSessionMessages } from "./authoritative-session-messages";

describe("resolveAuthoritativeSessionMessages", () => {
  test("hides Claude terminal output when native metadata or the file is unavailable", async () => {
    const live = [{ role: "agent", content: "PTY scrape", createdAt: "2026-10-02T00:00:00Z" }];
    for (const metadata of [undefined, { nativeAgentSession: {
      agent: "claude", sessionId: "missing-claude-test", workingDirectory: "/repo",
    } }]) {
      const session = { agent: "claude", metadata } as SessionSnapshot;
      await expect(resolveAuthoritativeSessionMessages(session, live)).resolves.toEqual([]);
    }
  });

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


test("Claude SDK sync keeps completion-aware live snapshots instead of partial JSONL", async () => {
  const session = { agent: "claude", metadata: { agentTransport: "claude-sdk", nativeAgentSession: {
    agent: "claude", sessionId: "missing-test-session", workingDirectory: "/repo",
  } } } as SessionSnapshot;
  const messages = [{ role: "user", content: "Question", createdAt: "2026-10-08T00:00:00Z" },
    { role: "agent-error", content: "Interrupted", createdAt: "2026-10-08T00:00:01Z" }];
  expect(await resolveAuthoritativeSessionMessages(session, messages)).toEqual(messages);
});
