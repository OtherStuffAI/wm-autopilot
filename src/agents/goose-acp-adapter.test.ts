import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterStreamEvent } from "./agent-adapter";
import { GooseAdapter } from "./goose-adapter";

let testDir = "";
let fakeCli = "";
let rpcLog = "";
const adapters: GooseAdapter[] = [];

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "wingman-goose-acp-"));
  fakeCli = join(testDir, "goose");
  rpcLog = join(testDir, "rpc.jsonl");
  writeFileSync(fakeCli, FAKE_GOOSE_ACP_SERVER);
  chmodSync(fakeCli, 0o755);
});

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
  rmSync(testDir, { recursive: true, force: true });
});

function createAdapter(overrides: Record<string, unknown> = {}): GooseAdapter {
  const adapter = new GooseAdapter({
    id: "wingman-goose-session",
    port: 3700,
    agent: "goose",
    host: "127.0.0.1",
    workingDirectory: testDir,
    gooseCli: fakeCli,
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

describe("Goose ACP profile", () => {
  test("negotiates protocol 0 and creates a ready native session", async () => {
    const nativeIds: string[] = [];
    const adapter = createAdapter({ onNativeSessionId: (id: string) => nativeIds.push(id) });

    await adapter.waitForReady();

    const requests = readRpcLog();
    expect(requests.map((entry) => entry.method)).toEqual(["initialize", "session/new"]);
    expect(requests[0]?.params).toMatchObject({ protocolVersion: 0 });
    expect(requests[1]?.params).toMatchObject({ cwd: testDir, mcpServers: [] });
    expect(nativeIds).toEqual(["goose-session-1"]);
    expect(adapter.getSessionId()).toBe("goose-session-1");
    expect((await adapter.getPromptReadiness()).state).toBe("ready");
  });

  test("normalizes thought, tool, and final events before releasing queued work", async () => {
    const adapter = createAdapter();
    const events: AdapterStreamEvent[] = [];
    adapter.subscribeToEvents((event) => events.push(event));
    await adapter.waitForReady();

    const held = adapter.sendMessage("hold");
    await waitUntil(() => readRpcLog().some((entry) => entry.method === "session/prompt"));
    expect((await adapter.getPromptReadiness()).state).toBe("busy");
    const queued = adapter.sendMessage("queued");
    await Promise.all([held, queued]);

    const messages = await adapter.fetchMessages();
    expect(messages.map((message) => [message.role, message.messageId, message.content])).toEqual([
      ["user", "acp-turn-1-user", "hold"],
      ["agent-thinking", "acp-turn-1-thinking", "thinking"],
      ["agent-tools", "acp-turn-1-tools", "Tool call: Read file (completed)\n\nOutput: done"],
      ["assistant", "acp-turn-1-message-answer-1", "final"],
      ["user", "acp-turn-2-user", "queued"],
      ["agent-thinking", "acp-turn-2-thinking", "thinking"],
      ["agent-tools", "acp-turn-2-tools", "Tool call: Read file (completed)\n\nOutput: done"],
      ["assistant", "acp-turn-2-message-answer-1", "final"],
    ]);
    expect((await adapter.fetchMessages()).filter((message) => message.role === "user").map((message) => message.content))
      .toEqual(["hold", "queued"]);
    const prompts = readRpcLog().filter((entry) => entry.method === "session/prompt");
    expect(prompts.map((entry) => ((entry.params as Record<string, unknown>).prompt as Array<Record<string, unknown>>)[0]?.text))
      .toEqual(["hold", "queued"]);
    expect((await adapter.getPromptReadiness()).state).toBe("ready");
  });

  test("resumes with session/load when Goose advertises native loading", async () => {
    const adapter = createAdapter({ gooseSessionId: "existing-goose-session" });
    await adapter.waitForReady();

    expect(readRpcLog().some((entry) => entry.method === "session/load"
      && (entry.params as Record<string, unknown>).sessionId === "existing-goose-session")).toBe(true);
    expect(readRpcLog().some((entry) => entry.method === "session/new")).toBe(false);
    expect((await adapter.fetchMessages()).map((message) => [message.role, message.content])).toEqual([
      ["user", "Persist me"],
      ["assistant", "Persisted response"],
    ]);
  });

  test("retains a submitted user prompt when Goose rejects the turn", async () => {
    const adapter = createAdapter();

    await expect(adapter.sendMessage("fail")).rejects.toThrow("prompt rejected");
    expect((await adapter.fetchMessages()).map((message) => [message.role, message.content])).toEqual([
      ["user", "fail"],
    ]);
  });

  test("retains one user prompt when an active Goose turn is cancelled", async () => {
    const adapter = createAdapter();
    const held = adapter.sendMessage("hold");
    await waitUntil(() => readRpcLog().some((entry) => entry.method === "session/prompt"));

    expect(await adapter.interruptCurrentTurn()).toBe(true);
    await held;
    expect((await adapter.fetchMessages()).filter((message) => message.role === "user").map((message) => message.content))
      .toEqual(["hold"]);
    expect(readRpcLog().filter((entry) => entry.method === "session/cancel")).toHaveLength(1);
  });

  test("maps allow once, always allow, and reject to exposed Goose option IDs", async () => {
    const adapter = createAdapter();

    for (const [prompt, response] of [
      ["permission-once", "once"],
      ["permission-always", "always"],
      ["permission-reject", "reject"],
    ] as const) {
      const turn = adapter.sendMessage(prompt);
      await waitUntil(() => adapter.getPendingPermissions().length === 1);
      expect(await adapter.getPromptReadiness()).toMatchObject({
        state: "busy",
        reason: "goose-waiting-permission",
      });
      expect(adapter.getPendingPermissions()[0]?.options).toEqual([
        { optionId: "goose-temporary", label: "Allow once", response: "once" },
        { optionId: "goose-persist", label: "Always allow", response: "always" },
        { optionId: "goose-no", label: "Reject", response: "reject" },
      ]);
      expect(await adapter.respondToPermission("700", response)).toBe(true);
      await turn;
    }

    const selectedIds = readRpcLog()
      .filter((entry) => entry.id === 700 && entry.result)
      .map((entry) => (((entry.result as Record<string, unknown>).outcome as Record<string, unknown>).optionId));
    expect(selectedIds).toEqual(["goose-temporary", "goose-persist", "goose-no"]);
  });

  test("auto-approves with the offered persistent option and records one audit activity", async () => {
    const adapter = createAdapter({ acpPermissionPolicy: "auto_approve" });
    await adapter.sendMessage("permission-always");

    const permissionResponses = readRpcLog().filter((entry) => entry.id === 700 && entry.result);
    expect(permissionResponses).toHaveLength(1);
    expect(permissionResponses[0]?.result).toEqual({
      outcome: { outcome: "selected", optionId: "goose-persist" },
    });
    expect(adapter.getPendingPermissions()).toHaveLength(0);
    expect((await adapter.fetchMessages()).filter((message) => message.messageId === "acp-permission-700-auto-approved"))
      .toEqual([expect.objectContaining({
        role: "agent-tools",
        content: "ACP permission auto-approved: Goose runtime request (Always allow).",
      })]);
  });

  test("falls back to an offered allow-once ID and asks when no allow option exists", async () => {
    const adapter = createAdapter({ acpPermissionPolicy: "auto_approve" });
    await adapter.sendMessage("permission-limited");
    expect(readRpcLog().find((entry) => entry.id === 700 && entry.result)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "goose-temporary" },
    });

    const askTurn = adapter.sendMessage("permission-reject-only");
    await waitUntil(() => adapter.getPendingPermissions().length === 1);
    expect(readRpcLog().filter((entry) => entry.id === 700 && entry.result)).toHaveLength(1);
    expect(await adapter.respondToPermission("700", "reject")).toBe(true);
    await askTurn;
  });

  test("keeps ask policy interactive without materializing an auto-approval", async () => {
    const adapter = createAdapter({ acpPermissionPolicy: "ask" });
    const turn = adapter.sendMessage("permission-always");
    await waitUntil(() => adapter.getPendingPermissions().length === 1);

    expect(readRpcLog().some((entry) => entry.id === 700 && entry.result)).toBe(false);
    expect((await adapter.fetchMessages()).some((message) => message.messageId?.includes("auto-approved"))).toBe(false);
    expect(await adapter.respondToPermission("700", "once")).toBe(true);
    await turn;
  });

  test("retains a visible permission when Goose does not expose the requested option", async () => {
    const adapter = createAdapter();
    const turn = adapter.sendMessage("permission-limited");
    await waitUntil(() => adapter.getPendingPermissions().length === 1);

    await expect(adapter.respondToPermission("700", "always")).rejects.toThrow(
      "Goose ACP permission does not offer Always allow",
    );
    expect(adapter.getPendingPermissions()).toHaveLength(1);

    expect(await adapter.respondToPermission("700", "reject")).toBe(true);
    await turn;
  });

  test("cancels an outstanding permission before cancelling the active Goose turn", async () => {
    const adapter = createAdapter();
    const turn = adapter.sendMessage("permission-cancel");
    await waitUntil(() => adapter.getPendingPermissions().length === 1);

    expect(await adapter.interruptCurrentTurn()).toBe(true);
    await turn;

    const permissionResponse = readRpcLog().find((entry) => entry.id === 700 && entry.result);
    expect(permissionResponse?.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(adapter.getPendingPermissions()).toHaveLength(0);
    expect(readRpcLog().filter((entry) => entry.method === "session/cancel")).toHaveLength(1);
  });

  test("rejects an unexpected negotiated protocol visibly", async () => {
    const badLog = join(testDir, "bad-protocol.jsonl");
    const adapter = createAdapter({
      env: { TEST_ACP_LOG: badLog, TEST_ACP_BAD_PROTOCOL: "1" },
    });

    await expect(adapter.waitForReady()).rejects.toThrow("Goose ACP negotiated unsupported protocol 1");
    expect((await adapter.getPromptReadiness()).state).toBe("unreachable");
    expect(readRpcLog(badLog).map((entry) => entry.method)).toEqual(["initialize"]);
  });
});

const FAKE_GOOSE_ACP_SERVER = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.TEST_ACP_LOG;
const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
const lines = createInterface({ input: process.stdin });
let permissionPromptId = null;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify(message) + "\\n");
  const { id, method, params } = message;
  if (id === 700 && !method && message.result?.outcome) {
    if (permissionPromptId !== null) {
      send({ jsonrpc: "2.0", id: permissionPromptId, result: { stopReason: "end_turn" } });
      permissionPromptId = null;
    }
    return;
  }
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: process.env.TEST_ACP_BAD_PROTOCOL ? 1 : 0,
      agentCapabilities: { loadSession: true },
    } });
    return;
  }
  if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId: "goose-session-1" } });
    return;
  }
  if (method === "session/load") {
    send({ jsonrpc: "2.0", method: "session/update", params: { update: {
      sessionUpdate: "user_message_chunk", messageId: "loaded-user-1", content: { type: "text", text: "Persist me" },
    } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { update: {
      sessionUpdate: "agent_message_chunk", messageId: "loaded-answer-1", content: { type: "text", text: "Persisted response" },
    } } });
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "session/cancel") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method !== "session/prompt") return;
  if (params.prompt[0].text === "fail") {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "prompt rejected" } });
    return;
  }
  if (params.prompt[0].text.startsWith("permission-")) {
    permissionPromptId = id;
    const options = params.prompt[0].text === "permission-limited"
      ? [
          { optionId: "goose-temporary", name: "Allow once", kind: "allow_once" },
          { optionId: "goose-no", name: "Reject", kind: "reject_once" },
        ]
      : params.prompt[0].text === "permission-reject-only"
        ? [
            { optionId: "goose-no", name: "Reject", kind: "reject_once" },
          ]
      : [
          { optionId: "goose-temporary", name: "Allow once", kind: "allow_once" },
          { optionId: "goose-persist", name: "Always allow", kind: "allow_always" },
          { optionId: "goose-no", name: "Reject", kind: "reject_once" },
        ];
    send({ jsonrpc: "2.0", id: 700, method: "session/request_permission", params: {
      sessionId: params.sessionId,
      toolCall: { toolCallId: "tool-permission", title: "Run shell command" },
      options,
    } });
    return;
  }
  send({ jsonrpc: "2.0", method: "session/update", params: { update: {
    sessionUpdate: "user_message_chunk", messageId: "echo-user", content: { type: "text", text: params.prompt[0].text },
  } } });
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
  const respond = () => send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  if (params.prompt[0].text === "hold") setTimeout(respond, 75);
  else respond();
});
`;
