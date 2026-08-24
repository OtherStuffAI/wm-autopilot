import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterStreamEvent } from "./agent-adapter";
import { CodexAcpAdapter, buildCodexAcpMcpServers, buildCodexAcpRuntimeEnv } from "./codex-acp-adapter";

let testDir = "";
let fakeCli = "";
let rpcLog = "";
const adapters: CodexAcpAdapter[] = [];

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "wingman-codex-acp-"));
  fakeCli = join(testDir, "codex-acp");
  rpcLog = join(testDir, "rpc.jsonl");
  writeFileSync(fakeCli, FAKE_ACP_SERVER);
  chmodSync(fakeCli, 0o755);
});

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
  rmSync(testDir, { recursive: true, force: true });
});

function createAdapter(overrides: Record<string, unknown> = {}): CodexAcpAdapter {
  const adapter = new CodexAcpAdapter({
    id: "wingman-session",
    port: 3700,
    agent: "codex",
    host: "127.0.0.1",
    workingDirectory: testDir,
    codexAcpCli: fakeCli,
    env: { TEST_ACP_LOG: rpcLog },
    ...overrides,
  });
  adapters.push(adapter);
  return adapter;
}

function readRpcLog(): Array<Record<string, unknown>> {
  try {
    return readFileSync(rpcLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error("Timed out waiting for test condition");
}

describe("CodexAcpAdapter", () => {
  test("starts, initializes, creates a session, injects MCP, and selects model/reasoning", async () => {
    const nativeIds: string[] = [];
    const adapter = createAdapter({
      model: "gpt-test",
      codexCli: "/custom/codex",
      codexConfig: {
        model_reasoning_effort: "high",
        mcp_servers: {
          wingman: { command: "bun", args: ["run", "/mcp.ts"], env: { SESSION_ID: "wingman-session" } },
        },
      },
      onNativeSessionId: (id: string) => nativeIds.push(id),
    });

    await adapter.waitForReady();

    const requests = readRpcLog();
    expect(requests.map((entry) => entry.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
    ]);
    expect(requests[1]?.params).toMatchObject({
      cwd: testDir,
      mcpServers: [{ name: "wingman", command: "bun", args: ["run", "/mcp.ts"] }],
    });
    expect(requests[2]?.params).toMatchObject({ configId: "model", value: "gpt-test" });
    expect(requests[3]?.params).toMatchObject({ configId: "reasoning_effort", value: "high" });
    expect(nativeIds).toEqual(["codex-thread-1"]);
    expect(adapter.getSessionId()).toBe("codex-thread-1");
  });

  test("streams separate thoughts/final output and stable tool updates until prompt completion", async () => {
    const adapter = createAdapter();
    const events: AdapterStreamEvent[] = [];
    adapter.subscribeToEvents((event) => events.push(event));

    await adapter.sendMessage("stream");

    const messages = await adapter.fetchMessages();
    expect(messages.map((message) => [message.role, message.messageId, message.content])).toEqual([
      ["user", "acp-turn-1-user", "stream"],
      ["agent-thinking", "acp-turn-1-thinking", "thinking"],
      ["agent-tools", "acp-turn-1-tools", "Tool call: Read file (completed)\n\nOutput: done"],
      ["assistant", "acp-turn-1-message-answer-1", "final"],
    ]);
    expect((await adapter.getPromptReadiness()).state).toBe("ready");
  });

  test("surfaces permission requests and returns the selected response", async () => {
    const adapter = createAdapter();
    const events: AdapterStreamEvent[] = [];
    adapter.subscribeToEvents((event) => events.push(event));

    await adapter.sendMessage("permission");
    await waitUntil(() => adapter.getPendingPermissions().length === 1);
    expect(events.some((event) => event.type === "permission")).toBe(true);
    expect(await adapter.respondToPermission("700", "once")).toBe(true);
    await waitUntil(() => readRpcLog().some((entry) => entry.id === 700 && entry.result !== undefined));
    expect(readRpcLog().find((entry) => entry.id === 700 && entry.result)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
  });

  test("uses the shared ACP auto-approval policy with runtime option IDs", async () => {
    const adapter = createAdapter({ acpPermissionPolicy: "auto_approve" });
    await adapter.sendMessage("permission");
    await waitUntil(() => readRpcLog().some((entry) => entry.id === 700 && entry.result));

    expect(readRpcLog().find((entry) => entry.id === 700 && entry.result)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow_always" },
    });
    expect((await adapter.fetchMessages()).filter((message) => message.messageId === "acp-permission-700-auto-approved"))
      .toHaveLength(1);
  });

  test("cancels with an ACP notification and releases the next queued prompt", async () => {
    const adapter = createAdapter();
    const held = adapter.sendMessage("hold");
    await waitUntil(() => readRpcLog().some((entry) => entry.method === "session/prompt"));
    expect((await adapter.getPromptReadiness()).state).toBe("busy");

    expect(await adapter.interruptCurrentTurn()).toBe(true);
    await held;
    await adapter.sendMessage("after-cancel");

    expect(readRpcLog().filter((entry) => entry.method === "session/cancel")).toHaveLength(1);
    expect((await adapter.getPromptReadiness()).state).toBe("ready");
  });

  test("loads native resume metadata only when the capability is advertised", async () => {
    const adapter = createAdapter({ codexThreadId: "existing-thread" });
    await adapter.waitForReady();
    expect(readRpcLog().some((entry) => entry.method === "session/load" && (entry.params as Record<string, unknown>).sessionId === "existing-thread")).toBe(true);

    const unsupported = createAdapter({
      codexThreadId: "unsupported-thread",
      env: { TEST_ACP_LOG: join(testDir, "unsupported.jsonl"), TEST_ACP_NO_LOAD: "1" },
    });
    await expect(unsupported.waitForReady()).rejects.toThrow("does not advertise session/load support");
  });

  test("fails visibly on missing binaries, protocol errors, runtime errors, and dispose", async () => {
    const missing = createAdapter({ codexAcpCli: join(testDir, "missing-codex-acp") });
    await expect(missing.waitForReady()).rejects.toThrow("failed to start");

    const protocolError = createAdapter({
      env: { TEST_ACP_LOG: join(testDir, "protocol.jsonl"), TEST_ACP_BAD_PROTOCOL: "1" },
    });
    await expect(protocolError.waitForReady()).rejects.toThrow("unsupported protocol");

    const authError = createAdapter({
      env: { TEST_ACP_LOG: join(testDir, "auth.jsonl"), TEST_ACP_AUTH_ERROR: "1" },
    });
    await expect(authError.waitForReady()).rejects.toThrow("authentication required");

    const runtimeError = createAdapter();
    await expect(runtimeError.sendMessage("exit")).rejects.toThrow("exited with code 7");
    expect((await runtimeError.getPromptReadiness()).state).toBe("unreachable");

    const disposed = createAdapter();
    await disposed.waitForReady();
    await disposed.dispose();
    expect(await disposed.fetchStatus()).toBeNull();
    await expect(disposed.waitForReady()).rejects.toThrow("disposed");
  });
});

describe("Codex ACP profile helpers", () => {
  test("merges CODEX_CONFIG and maps ACP MCP environment entries", () => {
    const env = buildCodexAcpRuntimeEnv({
      id: "session",
      port: 3700,
      agent: "codex",
      host: "localhost",
      env: { CODEX_CONFIG: JSON.stringify({ service_tier: "fast", nested: { a: 1 } }) },
      codexConfig: { model_reasoning_effort: "low", nested: { b: 2 } },
    });
    expect(JSON.parse(env.CODEX_CONFIG!)).toEqual({
      service_tier: "fast",
      model_reasoning_effort: "low",
      nested: { a: 1, b: 2 },
    });
    expect(buildCodexAcpMcpServers({
      mcp_servers: { wingman: { command: "bun", args: ["mcp.ts"], env: { SESSION_ID: "session" } } },
    })).toEqual([{
      name: "wingman",
      command: "bun",
      args: ["mcp.ts"],
      env: [{ name: "SESSION_ID", value: "session" }],
    }]);
  });

  test("rejects malformed CODEX_CONFIG instead of hiding it", () => {
    expect(() => buildCodexAcpRuntimeEnv({
      id: "session",
      port: 3700,
      agent: "codex",
      host: "localhost",
      env: { CODEX_CONFIG: "not-json" },
    })).toThrow("CODEX_CONFIG must be valid JSON");
    expect(() => buildCodexAcpMcpServers({
      mcp_servers: { wingman: { args: ["missing-command"] } },
    })).toThrow("requires a command");
  });
});

const FAKE_ACP_SERVER = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.TEST_ACP_LOG;
const pending = new Map();
const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify(message) + "\\n");
  const { id, method, params } = message;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: process.env.TEST_ACP_BAD_PROTOCOL ? 999 : 1,
      agentCapabilities: { loadSession: !process.env.TEST_ACP_NO_LOAD },
    } });
    return;
  }
  if (method === "session/new") {
    if (process.env.TEST_ACP_AUTH_ERROR) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "authentication required" } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { sessionId: "codex-thread-1", configOptions: [] } });
    return;
  }
  if (method === "session/load") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id, result: { configOptions: [] } });
    return;
  }
  if (method === "session/cancel") {
    for (const [promptId] of pending) {
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
      pending.delete(promptId);
    }
    return;
  }
  if (method !== "session/prompt") return;
  const text = params.prompt[0].text;
  if (text === "exit") process.exit(7);
  if (text === "hold") {
    pending.set(id, true);
    return;
  }
  if (text === "permission") {
    send({ jsonrpc: "2.0", id: 700, method: "session/request_permission", params: {
      sessionId: params.sessionId,
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    } });
  }
  send({ jsonrpc: "2.0", method: "session/update", params: { update: {
    sessionUpdate: "agent_thought_chunk", messageId: "thought-1", content: { type: "text", text: "thinking" },
  } } });
  send({ jsonrpc: "2.0", method: "session/update", params: { update: {
    sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read file", status: "in_progress",
  } } });
  send({ jsonrpc: "2.0", method: "session/update", params: { update: {
    sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", rawOutput: "done",
  } } });
  send({ jsonrpc: "2.0", method: "session/update", params: { update: {
    sessionUpdate: "agent_message_chunk", messageId: "answer-1", content: { type: "text", text: "final" },
  } } });
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
});
`;
