import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { ClaudeMessageImporter } from "./claude-message-importer";

import { findClaudeSessionFile, readClaudeSessionMessagesFromFile } from "./claude-session-messages";

describe("Claude session message importer", () => {
  test("groups thinking and tool activity before the final assistant text", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-messages-test-"));
    const filePath = join(root, "session.jsonl");
    try {
      await writeFile(filePath, [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-06-26T00:00:01.000Z",
          sessionId: "claude-native-1",
          cwd: "/repo",
          message: { role: "user", content: "What should I do?" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          parentUuid: "user-1",
          timestamp: "2026-06-26T00:00:02.000Z",
          sessionId: "claude-native-1",
          cwd: "/repo",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "Check the failing tests before editing.", signature: "signed" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-2",
          parentUuid: "assistant-1",
          timestamp: "2026-06-26T00:00:03.000Z",
          sessionId: "claude-native-1",
          cwd: "/repo",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I will inspect the tests first." }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-3",
          parentUuid: "assistant-2",
          timestamp: "2026-06-26T00:00:04.000Z",
          sessionId: "claude-native-1",
          cwd: "/repo",
          message: {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "bun test src/agents/claude-session-messages.test.ts" },
            }],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "tool-result-1",
          parentUuid: "assistant-3",
          timestamp: "2026-06-26T00:00:05.000Z",
          sessionId: "claude-native-1",
          cwd: "/repo",
          sourceToolAssistantUUID: "assistant-3",
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "pass",
              is_error: false,
            }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-4",
          parentUuid: "tool-result-1",
          timestamp: "2026-06-26T00:00:06.000Z",
          sessionId: "claude-native-1",
          cwd: "/repo",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "The tests pass. Ship it." }],
          },
        }),
      ].join("\n"));

      const messages = await readClaudeSessionMessagesFromFile(filePath);

      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({
        role: "user",
        content: "What should I do?",
        createdAt: "2026-06-26T00:00:01.000Z",
      });
      expect(messages[1]?.role).toBe("agent-working");
      expect(messages[1]?.content).toContain("Thinking:\nCheck the failing tests before editing.");
      expect(messages[1]?.content).toContain("Tool call: Bash `bun test src/agents/claude-session-messages.test.ts`");
      expect(messages[1]?.content).toContain("Tool result: Bash completed: pass");
      expect(messages[1]?.content).toContain("I will inspect the tests first.");
      expect(messages[1]?.content.indexOf("I will inspect")).toBeLessThan(messages[1]!.content.indexOf("Tool call:"));
      expect(messages[2]).toEqual({
        role: "agent",
        content: "The tests pass. Ship it.",
        createdAt: "2026-06-26T00:00:06.000Z",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps commentary as working while tools run and imports every parallel result", () => {
    const importer = new ClaudeMessageImporter();
    const timestamp = "2026-06-26T00:00:01.000Z";
    importer.addRecord({ type: "user", timestamp, message: { content: "Inspect" } });
    importer.addRecord({ type: "assistant", timestamp, message: { content: [
      { type: "text", text: "Inspecting files." },
      { type: "tool_use", id: "a", name: "Read", input: {} },
      { type: "tool_use", id: "b", name: "Bash", input: { command: "pwd" } },
    ] } });
    importer.addRecord({ type: "user", timestamp, message: { content: [
      { type: "tool_result", tool_use_id: "a", content: "file contents" },
      { type: "tool_result", tool_use_id: "b", content: "denied", is_error: true },
    ] } });
    importer.addRecord({ type: "assistant", isSidechain: true, timestamp,
      message: { content: [{ type: "text", text: "Subagent output" }] } });
    const messages = importer.finish();
    expect(messages.map((message) => message.role)).toEqual(["user", "agent-working"]);
    expect(messages[1]?.content).toBe("Inspecting files.\n\nTool call: Read\n\nTool call: Bash `pwd`\n\nTool result: Read completed: file contents\n\nTool result: Bash failed: denied");
  });

  test("finds a Claude session file by native id and working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-find-test-"));
    const claudeHome = join(root, ".claude");
    const filePath = join(claudeHome, "projects", "-repo", "claude-native-1.jsonl");
    try {
      await mkdir(join(claudeHome, "projects", "-repo"), { recursive: true });
      await writeFile(filePath, JSON.stringify({
        type: "user",
        sessionId: "claude-native-1",
        cwd: "/repo",
        promptSource: "typed",
        message: { role: "user", content: "Hello" },
      }));

      await expect(findClaudeSessionFile({
        claudeHome,
        sessionId: "claude-native-1",
        workingDirectory: "/repo",
      })).resolves.toBe(filePath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
