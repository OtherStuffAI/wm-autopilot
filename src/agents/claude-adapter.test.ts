import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Query, SDKMessage, WarmQuery, startup } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "./claude-adapter";
import type { AdapterSessionContext } from "./agent-adapter";
import { findNativeTurnFinal } from "./native-sdk-contract";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function controlledQuery() {
  const queued: SDKMessage[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const query = {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (queued.length) yield queued.shift()!;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
    close() { closed = true; wake?.(); },
  } as unknown as Query;
  return { query, emit(message: unknown) { queued.push(message as SDKMessage); wake?.(); } };
}

function fixture(overrides: Partial<AdapterSessionContext> = {}) {
  const root = mkdtempSync(join(tmpdir(), "claude-sdk-test-")); roots.push(root);
  const path = join(root, "mcp.json");
  writeFileSync(path, JSON.stringify({ mcpServers: { wingman: { type: "stdio", command: "bun", args: ["stdio.ts"] } } }));
  const context: AdapterSessionContext = { id: "wingman-test", agent: "claude", port: 3700, host: "127.0.0.1",
    workingDirectory: root, claudeMcpConfigPath: path, claudeSessionId: "preallocated", model: "sonnet",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "saved-token", WINGMAN_CAPABILITY: "private-capability" }, ...overrides };
  const calls: Options[] = [];
  const prompts: string[] = [];
  const streams: ReturnType<typeof controlledQuery>[] = [];
  const start = (async ({ options }: { options: Options }) => {
    calls.push(options);
    const stream = controlledQuery(); streams.push(stream);
    return { query(prompt: string) { prompts.push(prompt); return stream.query; }, close() { stream.query.close(); } } as WarmQuery;
  }) as typeof startup;
  const adapter = new ClaudeAdapter(context, start);
  return { adapter, context, calls, prompts, streams };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
const assistant = (id: string, content: unknown[]) => ({ type: "assistant", message: { id, content }, parent_tool_use_id: null });
const success = (result = "**Done**\n\n```ts\nconst ok = true;\n```") => ({ type: "result", subtype: "success", is_error: false, result, session_id: "native-id" });
const streamEvent = (event: unknown) => ({ type: "stream_event", event, parent_tool_use_id: null });

describe("Claude SDK lifecycle and conversation", () => {
  test("prewarms with scoped auth/MCP/instructions/model and streams one terminal final", async () => {
    const ids: string[] = [];
    const f = fixture({ onNativeSessionId: (id) => { ids.push(id); } });
    const events: unknown[] = [];
    f.adapter.subscribeToEvents((event) => { events.push(event); });
    await f.adapter.waitForReady();
    expect(f.calls[0]).toMatchObject({ cwd: f.context.workingDirectory, model: "sonnet", sessionId: "preallocated",
      env: { SESSION_ID: "wingman-test", CLAUDE_CODE_OAUTH_TOKEN: "saved-token", WINGMAN_CAPABILITY: "private-capability" },
      includePartialMessages: true, strictMcpConfig: true, persistSession: true,
      systemPrompt: { preset: "claude_code" }, settingSources: ["user", "project", "local"] });
    expect(await f.adapter.getPromptReadiness()).toMatchObject({ state: "ready" });
    const turn = f.adapter.sendMessage("Inspect");
    await flush();
    const stream = f.streams[0]!;
    stream.emit({ type: "system", subtype: "init", session_id: "native-id", model: "claude-sonnet", mcp_servers: [{ name: "wingman", status: "connected" }] });
    stream.emit(streamEvent({ type: "message_start", message: { id: "message-1" } }));
    stream.emit(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }));
    stream.emit(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Visible reasoning" } }));
    stream.emit(streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-1", name: "Read", input: {} } }));
    stream.emit(streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"README.md"}' } }));
    stream.emit(assistant("message-1", [{ type: "thinking", thinking: "Visible reasoning" }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }]));
    stream.emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "File contents" }] }, parent_tool_use_id: null });
    stream.emit(streamEvent({ type: "message_start", message: { id: "message-2" } }));
    stream.emit(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "Partial" } }));
    await flush();
    const running = await f.adapter.fetchMessages();
    expect(running.filter((message) => message.role === "agent-streaming")).toHaveLength(1);
    expect(running.some((message) => message.role === "assistant")).toBe(false);
    expect(running.filter((message) => message.role === "agent-tools")).toHaveLength(2);
    expect(running.find((message) => message.role === "agent-thinking")?.content).toBe("Visible reasoning");
    expect(await f.adapter.getPromptReadiness()).toMatchObject({ state: "busy" });
    await expect(f.adapter.sendMessage("Concurrent")).rejects.toThrow("active turn");
    stream.emit(assistant("message-2", [{ type: "text", text: "Complete" }]));
    stream.emit(success());
    stream.emit(success("duplicate ignored"));
    await turn;
    const done = await f.adapter.fetchMessages();
    expect(done.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(done.at(-1)?.content).toContain("**Done**");
    expect(f.adapter.getSessionId()).toBe("native-id");
    expect(f.adapter.getRunningModel()).toBe("claude-sonnet");
    expect(ids).toContain("native-id");
    expect(JSON.stringify(events)).not.toContain("saved-token");
    expect(await f.adapter.fetchStatus()).toBe("stable");
    const followUp = f.adapter.sendMessage("Follow up");
    await flush();
    expect(f.calls[1]).toMatchObject({ resume: "native-id" });
    expect(f.calls[1]?.sessionId).toBeUndefined();
    f.streams[1]!.emit(success("Follow-up final")); await followUp;
    expect(f.prompts).toEqual(["Inspect", "Follow up"]);
    await f.adapter.dispose();
    expect(await f.adapter.fetchStatus()).toBeNull();
    await expect(f.adapter.sendMessage("Disposed")).rejects.toThrow("disposed");
  });

  test.each(["interrupt", "error", "eof"])("%s never publishes partial text as a final", async (mode) => {
    const f = fixture();
    await f.adapter.waitForReady();
    const turn = f.adapter.sendMessage("Work");
    const outcome = turn.then(() => null, (error: Error) => error);
    await flush();
    f.streams[0]!.emit(assistant("partial", [{ type: "text", text: "Incomplete saved-token private-capability" }]));
    await flush();
    if (mode === "interrupt") expect(await f.adapter.interruptCurrentTurn()).toBe(true);
    else if (mode === "error") f.streams[0]!.emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "native-id", errors: ["saved-token private-capability"] });
    else f.streams[0]!.query.close();
    expect((await outcome)?.message).toContain(mode === "interrupt" ? "interrupted" : mode === "error" ? "redacted" : "missing");
    const messages = await f.adapter.fetchMessages();
    expect(messages.some((message) => message.role === "assistant")).toBe(false);
    expect(messages.at(-1)?.role).toBe("agent-error");
    expect(JSON.stringify(messages)).not.toContain("saved-token");
    expect(JSON.stringify(messages)).not.toContain("private-capability");
    expect(await f.adapter.fetchStatus()).toBe("stable");
    await f.adapter.dispose();
  });

  test("startup failures are explicit and redacted", async () => {
    const f = fixture({ claudeMcpConfigPath: undefined });
    await expect(f.adapter.waitForReady()).rejects.toThrow("session-private MCP");
    expect(await f.adapter.getPromptReadiness()).toMatchObject({ state: "unreachable" });
    const valid = fixture();
    const adapter = new ClaudeAdapter(valid.context, (async () => { throw new Error("saved-token"); }) as typeof startup);
    await expect(adapter.waitForReady()).rejects.toThrow("[redacted]");
    await valid.adapter.dispose();
  });

  test("resumed history remains available across reload snapshots", async () => {
    const history = [{ role: "user", content: "Previous", createdAt: "2026-01-01T00:00:00Z" },
      { role: "assistant", content: "Previous final", createdAt: "2026-01-01T00:00:01Z" }];
    const f = fixture({ claudeResume: true, claudeSessionId: "persisted-native", nativeSdkHistory: history });
    await f.adapter.waitForReady();
    expect(f.calls[0]).toMatchObject({ resume: "persisted-native" });
    expect(await f.adapter.fetchMessages()).toEqual(history);
    const turn = f.adapter.sendMessage("Next");
    await flush(); f.streams[0]!.emit(success("Next final")); await turn;
    expect((await f.adapter.fetchMessages()).slice(0, 2)).toEqual(history);
    await f.adapter.dispose();
  });

  test("crash-rehydrated streams stay ineligible when the new SDK becomes idle", async () => {
    const history = [{ role: "user", content: "Crashed prompt", createdAt: "2026-01-01T00:00:00Z" },
      { role: "agent-streaming", content: "Unfinished answer", messageId: "partial", createdAt: "2026-01-01T00:00:01Z" }];
    const f = fixture({ claudeResume: true, claudeSessionId: "persisted-native", nativeSdkHistory: history });
    await f.adapter.waitForReady();
    expect(await f.adapter.fetchStatus()).toBe("stable");
    expect(findNativeTurnFinal(await f.adapter.fetchMessages())).toBeUndefined();
    expect(await f.adapter.fetchMessages()).toEqual(history);
    await f.adapter.dispose();
  });

  test("stop during an active turn disposes only the owned query and prevents a final", async () => {
    const f = fixture(); await f.adapter.waitForReady();
    const outcome = f.adapter.sendMessage("Work").then(() => null, (error: Error) => error);
    await flush(); await f.adapter.dispose();
    expect((await outcome)?.message).toContain("interrupted");
    expect(await f.adapter.fetchStatus()).toBeNull();
    expect(findNativeTurnFinal(await f.adapter.fetchMessages())).toBeUndefined();
    expect(await f.adapter.interruptCurrentTurn()).toBe(false);
  });
});
