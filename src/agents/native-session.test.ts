import { describe, expect, test } from "bun:test";

import {
  buildNativeAgentCommand,
  prepareNativeAgentSessionMetadata,
  supportsNativeSessionResume,
} from "./native-session";
import { normaliseSessionMetadata } from "../sessions/session-metadata";

describe("native agent session helpers", () => {
  test("supports ACP native session resume", () => {
    expect(supportsNativeSessionResume("goose")).toBe(true);
    expect(supportsNativeSessionResume("maple")).toBe(true);
    expect(supportsNativeSessionResume("pi")).toBe(true);
  });

  test("preallocates Claude session IDs and adds --session-id for fresh launches", () => {
    const metadata = prepareNativeAgentSessionMetadata(
      "claude",
      "/repo",
      normaliseSessionMetadata({ AGENT: false }),
    );
    expect(metadata.nativeAgentSession?.agent).toBe("claude");
    expect(metadata.nativeAgentSession?.workingDirectory).toBe("/repo");
    const nativeSessionId = metadata.nativeAgentSession?.sessionId;
    expect(nativeSessionId).toBeTruthy();

    const command = buildNativeAgentCommand(
      ["agentapi", "server", "--", "claude", "--dangerously-skip-permissions"],
      "claude",
      metadata,
    );
    expect(command).toEqual([
      "agentapi",
      "server",
      "--",
      "claude",
      "--session-id",
      nativeSessionId!,
      "--dangerously-skip-permissions",
    ]);
  });

  test("builds Codex native resume commands when metadata references a prior Wingman session", () => {
    const metadata = normaliseSessionMetadata({
      AGENT: false,
      resumedFromWingmanSessionId: "wingman-1",
      nativeAgentSession: {
        agent: "codex",
        sessionId: "codex-session-1",
        workingDirectory: "/repo",
        capturedAt: "2026-05-31T00:00:00.000Z",
        source: "manual",
      },
    });

    expect(buildNativeAgentCommand(
      ["agentapi", "server", "--", "codex", "--yolo"],
      "codex",
      metadata,
    )).toEqual([
      "agentapi",
      "server",
      "--",
      "codex",
      "resume",
      "codex-session-1",
      "--yolo",
    ]);
  });

  test("builds Codex native resume commands for conversation branches", () => {
    const metadata = normaliseSessionMetadata({
      AGENT: false,
      branchedFromWingmanSessionId: "wingman-source",
      branchConversationMode: "full",
      nativeAgentSession: {
        agent: "codex",
        sessionId: "codex-fork-session",
        workingDirectory: "/repo",
        capturedAt: "2026-06-26T00:00:00.000Z",
        source: "manual",
      },
    });

    expect(buildNativeAgentCommand(
      ["agentapi", "server", "--", "codex", "--yolo"],
      "codex",
      metadata,
    )).toEqual([
      "agentapi",
      "server",
      "--",
      "codex",
      "resume",
      "codex-fork-session",
      "--yolo",
    ]);
  });

  test("builds Claude native resume commands when metadata references a prior Wingman session", () => {
    const metadata = normaliseSessionMetadata({
      AGENT: false,
      resumedFromWingmanSessionId: "wingman-1",
      nativeAgentSession: {
        agent: "claude",
        sessionId: "11111111-1111-4111-8111-111111111111",
        workingDirectory: "/repo",
        capturedAt: "2026-05-31T00:00:00.000Z",
        source: "preallocated",
      },
    });

    expect(buildNativeAgentCommand(["claude"], "claude", metadata)).toEqual([
      "claude",
      "--resume",
      "11111111-1111-4111-8111-111111111111",
    ]);
  });
});
