import { appendFile, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  clearCodexSessionMessageCaches,
  getCodexSessionMessageCacheMetrics,
  readCodexSessionMessages,
  readCodexSessionMessagesFromFile,
  readLatestCodexUserVisibleActivity,
} from "./codex-session-messages";

describe("Codex session message importer", () => {
  test("coalesces concurrent parses and reuses unchanged transcript hydration", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-message-cache-"));
    const filePath = join(root, "rollout-cache.jsonl");
    clearCodexSessionMessageCaches();
    try {
      await writeFile(filePath, JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-24T09:00:00.000Z",
        payload: { type: "user_message", message: "First" },
      }));

      const reads = await Promise.all(Array.from({ length: 6 }, () =>
        readCodexSessionMessagesFromFile(filePath)));
      expect(reads.every((messages) => messages.length === 1)).toBe(true);
      expect(getCodexSessionMessageCacheMetrics().parses).toBe(1);
      expect(getCodexSessionMessageCacheMetrics().maxConcurrentParses).toBe(1);

      await readCodexSessionMessagesFromFile(filePath);
      expect(getCodexSessionMessageCacheMetrics().hits).toBe(1);

      await appendFile(filePath, `\n${JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-24T09:00:01.000Z",
        payload: { type: "agent_message", phase: "final_answer", message: "Second" },
      })}`);
      expect(await readCodexSessionMessagesFromFile(filePath, { minimumRefreshIntervalMs: 0 })).toHaveLength(2);
      expect(getCodexSessionMessageCacheMetrics().parses).toBe(2);
    } finally {
      clearCodexSessionMessageCaches();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("streams an oversized rollout found by its exact native session id", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codex-oversized-messages-"));
    const sessionId = "oversized-native-session";
    const sessionDir = join(codexHome, "sessions", "2026", "08", "20");
    const filePath = join(sessionDir, `rollout-2026-08-20T00-00-00-${sessionId}.jsonl`);
    await mkdir(sessionDir, { recursive: true });
    const handle = await open(filePath, "w");
    try {
      await handle.write(`${JSON.stringify({
        type: "session_meta", timestamp: "2026-08-20T00:00:00.000Z",
        payload: { id: sessionId, cwd: "/repo" },
      })}\n`);
      const padding = `${JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-20T00:00:00.500Z",
        payload: { type: "ignored_padding", content: "x".repeat(1024 * 1024) },
      })}\n`;
      for (let index = 0; index < 51; index += 1) {
        await handle.write(padding);
      }
      await handle.write([
        JSON.stringify({ type: "event_msg", timestamp: "2026-08-20T00:00:01.000Z",
          payload: { type: "user_message", message: "Fix the transcript" } }),
        JSON.stringify({ type: "event_msg", timestamp: "2026-08-20T00:00:02.000Z",
          payload: { type: "agent_message", phase: "commentary", message: "Inspecting." } }),
        JSON.stringify({ type: "response_item", timestamp: "2026-08-20T00:00:03.000Z",
          payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: "{}" } }),
        JSON.stringify({ type: "event_msg", timestamp: "2026-08-20T00:00:04.000Z",
          payload: { type: "agent_message", phase: "final_answer", message: "Fixed." } }),
      ].join("\n"));
    } finally {
      await handle.close();
    }

    try {
      expect(Bun.file(filePath).size).toBeGreaterThan(50 * 1024 * 1024);
      const messages = await readCodexSessionMessages({ codexHome, sessionId, workingDirectory: "/repo" });
      expect(messages.map((message) => message.role)).toEqual([
        "user", "agent-thinking", "agent-tools", "agent",
      ]);
      expect(messages.at(-1)?.content).toBe("Fixed.");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("selects only explicit commentary for cross-suite activity", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codex-activity-"));
    const sessionId = "activity-session";
    const sessionDir = join(codexHome, "sessions", "2026", "07", "24");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, `rollout-${sessionId}.jsonl`), [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-24T00:00:00Z", payload: { id: sessionId, cwd: "/repo" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-24T00:00:01Z", payload: { type: "reasoning", summary: [{ text: "hidden" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-24T00:00:02Z", payload: { type: "function_call", name: "exec_command", arguments: "{\\\"cmd\\\":\\\"secret\\\"}" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-24T00:00:03Z", payload: { type: "agent_message", phase: "commentary", message: "Running focused validation." } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-24T00:00:04Z", payload: { type: "agent_message", phase: "commentary", message: "Checking the production build." } }),
    ].join("\n"));
    expect(await readLatestCodexUserVisibleActivity({ codexHome, sessionId, workingDirectory: "/repo" })).toEqual({
      content: "Checking the production build.", createdAt: "2026-07-24T00:00:04.000Z",
    });
    await rm(codexHome, { recursive: true, force: true });
  });

  test("does not reuse commentary from the preceding turn", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codex-activity-turn-"));
    const sessionId = "adjacent-turn-session";
    const sessionDir = join(codexHome, "sessions", "2026", "07", "24");
    await mkdir(sessionDir, { recursive: true });
    const filePath = join(sessionDir, `rollout-${sessionId}.jsonl`);
    await writeFile(filePath, [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-24T00:00:00Z", payload: { id: sessionId, cwd: "/repo" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-24T00:00:01Z", payload: { type: "user_message", message: "First turn" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-24T00:00:02Z", payload: { type: "agent_message", phase: "commentary", message: "Old commentary" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-24T00:00:03Z", payload: { type: "agent_message", phase: "final_answer", message: "Done" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-24T00:00:04Z", payload: { type: "user_message", message: "Second turn" } }),
    ].join("\n"));
    expect(await readLatestCodexUserVisibleActivity({ codexHome, sessionId, workingDirectory: "/repo" })).toBeNull();
    await writeFile(filePath, `${await Bun.file(filePath).text()}\n${JSON.stringify({
      type: "event_msg", timestamp: "2026-07-24T00:00:05Z",
      payload: { type: "agent_message", phase: "commentary", message: "New commentary" },
    })}`);
    expect(await readLatestCodexUserVisibleActivity({ codexHome, sessionId, workingDirectory: "/repo" })).toEqual({
      content: "New commentary", createdAt: "2026-07-24T00:00:05.000Z",
    });
    await rm(codexHome, { recursive: true, force: true });
  });
  test("groups commentary as working notes before final answers", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-messages-test-"));
    const filePath = join(root, "rollout.jsonl");
    try {
      await writeFile(filePath, [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-26T00:00:00.000Z",
          payload: { id: "native-1", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:01.000Z",
          payload: { type: "user_message", message: "What next?" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-26T00:00:02.000Z",
          payload: { type: "message", role: "assistant", content: [{ text: "duplicate" }] },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:03.000Z",
          payload: { type: "agent_message", phase: "commentary", message: "Checking files." },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-26T00:00:03.250Z",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call-1",
            arguments: JSON.stringify({ cmd: "bun test src/agents/codex-session-messages.test.ts" }),
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-26T00:00:03.500Z",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "Chunk ID: abc\nProcess exited with code 0\nOutput:\npass",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-26T00:00:03.750Z",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "call-2",
            input: [
              "*** Begin Patch",
              "*** Update File: src/agents/codex-session-messages.ts",
              "@@",
              "+changed",
              "*** End Patch",
            ].join("\n"),
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:03.900Z",
          payload: {
            type: "patch_apply_end",
            call_id: "call-2",
            success: true,
            changes: {
              "/repo/src/agents/codex-session-messages.ts": { type: "update" },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:04.000Z",
          payload: { type: "agent_message", phase: "commentary", message: "Running tests." },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:05.000Z",
          payload: { type: "agent_message", phase: "final_answer", message: "Ship the small fix." },
        }),
      ].join("\n"));

      const messages = await readCodexSessionMessagesFromFile(filePath);

      expect(messages).toHaveLength(4);
      expect(messages[0]).toEqual({ role: "user", content: "What next?", createdAt: "2026-06-26T00:00:01.000Z" });
      expect(messages[1]?.role).toBe("agent-thinking");
      expect(messages[1]?.createdAt).toBe("2026-06-26T00:00:03.000Z");
      expect(messages[1]?.content).toContain("Checking files.");
      expect(messages[1]?.content).toContain("Running tests.");
      expect(messages[2]?.role).toBe("agent-tools");
      expect(messages[2]?.content).toContain("Tool call: exec_command `bun test src/agents/codex-session-messages.test.ts`");
      expect(messages[2]?.content).toContain("Tool result: exec_command exit 0");
      expect(messages[2]?.content).toContain("Tool call: apply_patch src/agents/codex-session-messages.ts");
      expect(messages[2]?.content).toContain("Patch applied: /repo/src/agents/codex-session-messages.ts");
      expect(messages[3]).toEqual({ role: "agent", content: "Ship the small fix.", createdAt: "2026-06-26T00:00:05.000Z" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps commentary as working output when there is no final answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-messages-test-"));
    const filePath = join(root, "rollout.jsonl");
    try {
      await writeFile(filePath, [
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:01.000Z",
          payload: { type: "user_message", message: "Status?" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-26T00:00:02.000Z",
          payload: { type: "agent_message", phase: "commentary", message: "Still checking." },
        }),
      ].join("\n"));

      await expect(readCodexSessionMessagesFromFile(filePath)).resolves.toEqual([
        { role: "user", content: "Status?", createdAt: "2026-06-26T00:00:01.000Z" },
        { role: "agent-thinking", content: "Still checking.", createdAt: "2026-06-26T00:00:02.000Z" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("imports terminal Codex failures as visible error messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-error-message-test-"));
    const filePath = join(root, "rollout.jsonl");
    try {
      await writeFile(filePath, [
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-31T07:29:43.895Z",
          payload: { type: "user_message", message: "Continue the work" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-31T07:29:49.735Z",
          payload: {
            type: "task_complete",
            error: {
              message: "Selected model is at capacity. Please try a different model.",
              codex_error_info: "server_overloaded",
            },
          },
        }),
      ].join("\n"));

      await expect(readCodexSessionMessagesFromFile(filePath)).resolves.toEqual([
        { role: "user", content: "Continue the work", createdAt: "2026-08-31T07:29:43.895Z" },
        {
          role: "agent-error",
          content: [
            "**Codex could not complete this turn.**",
            "Selected model is at capacity. Please try a different model.",
            "Error code: `server_overloaded`",
          ].join("\n\n"),
          createdAt: "2026-08-31T07:29:49.735Z",
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("imports current Codex response-item user and assistant messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-response-messages-test-"));
    const filePath = join(root, "rollout.jsonl");
    try {
      await writeFile(filePath, [
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-13T08:09:15.000Z",
          payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Internal instructions" }] },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-13T08:09:16.000Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Why are sessions empty?" }] },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-13T08:09:17.000Z",
          payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking the importer." }] },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-13T08:09:18.000Z",
          payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "The importer needs the new record format." }] },
        }),
      ].join("\n"));

      await expect(readCodexSessionMessagesFromFile(filePath)).resolves.toEqual([
        { role: "user", content: "Why are sessions empty?", createdAt: "2026-08-13T08:09:16.000Z" },
        { role: "agent-thinking", content: "Checking the importer.", createdAt: "2026-08-13T08:09:17.000Z" },
        { role: "agent", content: "The importer needs the new record format.", createdAt: "2026-08-13T08:09:18.000Z" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("classifies injected AGENTS.md instructions as collapsible agent context", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-agent-context-test-"));
    const filePath = join(root, "rollout.jsonl");
    try {
      await writeFile(filePath, [
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-13T08:09:15.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nInternal context\n</INSTRUCTIONS>",
            }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-13T08:09:16.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Please fix the transcript." }],
          },
        }),
      ].join("\n"));

      await expect(readCodexSessionMessagesFromFile(filePath)).resolves.toEqual([
        {
          role: "agent-context",
          content: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nInternal context\n</INSTRUCTIONS>",
          createdAt: "2026-08-13T08:09:15.000Z",
        },
        {
          role: "user",
          content: "Please fix the transcript.",
          createdAt: "2026-08-13T08:09:16.000Z",
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
