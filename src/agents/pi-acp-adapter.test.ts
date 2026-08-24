import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterStreamEvent } from "./agent-adapter";
import { PiAcpAdapter, buildPiAcpRuntimeEnv } from "./pi-acp-adapter";

let testDir = "";
let fakeCli = "";
let rpcLog = "";
const adapters: PiAcpAdapter[] = [];

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "wingman-pi-acp-"));
  fakeCli = join(testDir, "pi-acp");
  rpcLog = join(testDir, "rpc.jsonl");
  writeFileSync(fakeCli, FAKE_ACP_SERVER);
  chmodSync(fakeCli, 0o755);
});

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
  rmSync(testDir, { recursive: true, force: true });
});

function createAdapter(overrides: Record<string, unknown> = {}): PiAcpAdapter {
  const adapter = new PiAcpAdapter({
    id: "wingman-pi-session",
    port: 3700,
    agent: "pi",
    host: "127.0.0.1",
    workingDirectory: testDir,
    piAcpCli: fakeCli,
    env: { TEST_ACP_LOG: rpcLog },
    ...overrides,
  });
  adapters.push(adapter);
  return adapter;
}

function readRpcLog(path = rpcLog): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error("Timed out waiting for test condition");
}

describe("PiAcpAdapter", () => {
  test("initializes ACP, creates a session, preserves Pi configuration, and selects a model", async () => {
    const nativeIds: string[] = [];
    const adapter = createAdapter({
      model: "openai-codex/gpt-5.3-codex",
      piCli: "/custom/pi",
      onNativeSessionId: (id: string) => nativeIds.push(id),
    });

    await adapter.waitForReady();

    const requests = readRpcLog();
    expect(requests.map((entry) => entry.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
    ]);
    expect(requests[0]?.params).toMatchObject({ protocolVersion: 1 });
    expect(requests[1]?.params).toMatchObject({ cwd: testDir, mcpServers: [] });
    expect(requests[2]?.params).toMatchObject({
      configId: "model",
      value: "openai-codex/gpt-5.3-codex",
    });
    expect(nativeIds).toEqual(["pi-session-1"]);
    expect(adapter.getSessionId()).toBe("pi-session-1");
  });

  test("rejects an unavailable selected model before calling session/set_config_option", async () => {
    const adapter = createAdapter({ model: "openrouter/google/unavailable" });
    await expect(adapter.waitForReady()).rejects.toThrow("not advertised by this session");
    expect(readRpcLog().map((entry) => entry.method)).toEqual(["initialize", "session/new"]);
  });

  test("uses the advertised default without sending a model override", async () => {
    const adapter = createAdapter();
    await adapter.waitForReady();
    expect(readRpcLog().map((entry) => entry.method)).toEqual(["initialize", "session/new"]);
  });

  test("normalizes thought, final output, and stable tool updates until prompt completion", async () => {
    const adapter = createAdapter();
    const events: AdapterStreamEvent[] = [];
    adapter.subscribeToEvents((event) => events.push(event));

    await adapter.sendMessage("stream");

    const messages = await adapter.fetchMessages();
    expect(messages.map((message) => [message.role, message.messageId, message.content])).toEqual([
      ["user", "acp-turn-1-user", "stream"],
      ["agent-thinking", "acp-turn-1-thinking", "thinking"],
      ["agent-tools", "acp-turn-1-tools", "Tool call: Read file (completed)\n\nOutput: done"],
      ["assistant", "acp-turn-1-message", "final"],
    ]);
    expect((await adapter.getPromptReadiness()).state).toBe("ready");
  });

  test("surfaces extension permission requests and returns the selected response", async () => {
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

  test("cancels with a notification and releases the next queued prompt", async () => {
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
    const adapter = createAdapter({ piSessionId: "existing-pi-session" });
    await adapter.waitForReady();
    await adapter.sendMessage("after-resume");
    expect(readRpcLog().some((entry) => entry.method === "session/load"
      && (entry.params as Record<string, unknown>).sessionId === "existing-pi-session")).toBe(true);
    expect(readRpcLog().some((entry) => entry.method === "session/prompt"
      && (entry.params as Record<string, unknown>).sessionId === "existing-pi-session")).toBe(true);

    const unsupportedLog = join(testDir, "unsupported.jsonl");
    const unsupported = createAdapter({
      piSessionId: "unsupported-session",
      env: { TEST_ACP_LOG: unsupportedLog, TEST_ACP_NO_LOAD: "1" },
    });
    await expect(unsupported.waitForReady()).rejects.toThrow("does not advertise session/load support");
  });

  test("fails visibly on missing binaries, auth, protocol, runtime errors, and dispose", async () => {
    const missing = createAdapter({ piAcpCli: join(testDir, "missing-pi-acp") });
    await expect(missing.waitForReady()).rejects.toThrow("failed to start");

    const auth = createAdapter({
      env: { TEST_ACP_LOG: join(testDir, "auth.jsonl"), TEST_ACP_AUTH_FAIL: "1" },
    });
    await expect(auth.waitForReady()).rejects.toThrow("authentication required");

    const protocol = createAdapter({
      env: { TEST_ACP_LOG: join(testDir, "protocol.jsonl"), TEST_ACP_BAD_PROTOCOL: "1" },
    });
    await expect(protocol.waitForReady()).rejects.toThrow("unsupported protocol");

    const runtime = createAdapter();
    await expect(runtime.sendMessage("exit")).rejects.toThrow("exited with code 7");
    expect((await runtime.getPromptReadiness()).state).toBe("unreachable");

    const disposed = createAdapter();
    await disposed.waitForReady();
    await disposed.dispose();
    expect(await disposed.fetchStatus()).toBeNull();
    await expect(disposed.waitForReady()).rejects.toThrow("disposed");
  });
});

describe("Pi ACP profile helpers", () => {
  test("passes inherited auth and identity env while configuring the Pi executable", () => {
    const env = buildPiAcpRuntimeEnv({
      id: "session",
      port: 3700,
      agent: "pi",
      host: "localhost",
      piCli: "/configured/pi",
      piOpenRouterApiKey: "stored-openrouter-key",
      env: {
        OPENROUTER_API_KEY: "stale-env-key",
        WINGMAN_NPUB: "npub-test",
        WINGMAN_MCP_SERVER: "/mcp.ts",
      },
    });
    expect(env).toMatchObject({
      PI_ACP_PI_COMMAND: "/configured/pi",
      OPENROUTER_API_KEY: "stored-openrouter-key",
      WINGMAN_NPUB: "npub-test",
      WINGMAN_MCP_SERVER: "/mcp.ts",
    });
  });
});

const FAKE_ACP_SERVER = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.TEST_ACP_LOG;
const pending = new Map();
let selectedModel = "openai-codex/gpt-5.3-codex";
const modelValues = (process.env.TEST_ACP_MODELS || "openai-codex/gpt-5.3-codex")
  .split(",").map((value) => value.trim()).filter(Boolean);
const configOptions = () => [{
  id: "model",
  currentValue: selectedModel,
  options: modelValues.map((value) => ({ value, name: value })),
}];
const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify(message) + "\\n");
  const { id, method, params } = message;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: process.env.TEST_ACP_BAD_PROTOCOL ? 2 : 1,
      authMethods: [{ id: "pi_terminal_login", type: "terminal" }],
      agentCapabilities: { loadSession: !process.env.TEST_ACP_NO_LOAD },
    } });
    return;
  }
  if (method === "session/new") {
    if (process.env.TEST_ACP_AUTH_FAIL) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "authentication required" } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { sessionId: "pi-session-1", configOptions: configOptions() } });
    return;
  }
  if (method === "session/load") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "session/set_config_option") {
    selectedModel = params.value;
    send({ jsonrpc: "2.0", id, result: { configOptions: configOptions() } });
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
    sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" },
  } } });
  send({ jsonrpc: "2.0", method: "session/update", params: { update: {
    sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read file", status: "in_progress",
  } } });
  send({ jsonrpc: "2.0", method: "session/update", params: { update: {
    sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", rawOutput: "done",
  } } });
  send({ jsonrpc: "2.0", method: "session/update", params: { update: {
    sessionUpdate: "agent_message_chunk", content: { type: "text", text: "final" },
  } } });
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
});
`;
