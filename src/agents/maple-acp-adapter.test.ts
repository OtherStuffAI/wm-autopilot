import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MapleAcpAdapter,
  buildMapleAcpEnvironment,
  formatMapleStartupError,
  resolveMapleAcpCli,
} from "./maple-acp-adapter";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

describe("MapleAcpAdapter", () => {
  test("uses protocol v1, literal acp argv, no MCP servers, and no model config RPC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wingman-maple-acp-"));
    const executable = join(dir, "maple");
    const log = join(dir, "rpc.jsonl");
    writeFileSync(executable, FAKE_MAPLE);
    chmodSync(executable, 0o755);
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const adapter = new MapleAcpAdapter({
      id: "maple-test", port: 3700, agent: "maple", host: "127.0.0.1",
      workingDirectory: dir, mapleAcpCli: executable, model: "DeepSeek V4 Flash",
    });
    cleanup.unshift(() => adapter.dispose());

    await adapter.waitForReady();
    const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(requests.map((entry) => entry.method)).toEqual(["initialize", "session/new"]);
    expect(requests[0].params.protocolVersion).toBe(1);
    expect(requests[1].params.mcpServers).toEqual([]);
  });

  test("collapses intermediate narration and auto-approved permissions by turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wingman-maple-acp-"));
    const executable = join(dir, "maple");
    writeFileSync(executable, FAKE_MAPLE);
    chmodSync(executable, 0o755);
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const adapter = new MapleAcpAdapter({
      id: "maple-test", port: 3700, agent: "maple", host: "127.0.0.1",
      workingDirectory: dir, mapleAcpCli: executable, acpPermissionPolicy: "auto_approve",
    });
    cleanup.unshift(() => adapter.dispose());

    await adapter.sendMessage("exercise-collapse");
    const messages = await adapter.fetchMessages();
    const thinking = messages.filter((message) => message.role === "agent-thinking");
    const tools = messages.filter((message) => message.role === "agent-tools");
    const assistant = messages.filter((message) => message.role === "assistant");

    expect(thinking).toEqual([expect.objectContaining({
      messageId: "acp-turn-1-thinking",
      content: "Checking the route.",
    })]);
    expect(tools).toEqual([expect.objectContaining({
      messageId: "acp-turn-1-tools",
      content: expect.stringContaining("ACP permission auto-approved"),
    })]);
    expect(tools[0]?.content).toContain("Tool call: Edit file (completed)");
    expect(assistant).toEqual([expect.objectContaining({
      messageId: "acp-turn-1-message",
      content: "Done.",
    })]);
  });

  test("loads a persisted native Maple session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wingman-maple-acp-"));
    const executable = join(dir, "maple");
    const log = join(dir, "rpc.jsonl");
    writeFileSync(executable, FAKE_MAPLE);
    chmodSync(executable, 0o755);
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const adapter = new MapleAcpAdapter({
      id: "maple-resume", port: 3700, agent: "maple", host: "127.0.0.1",
      workingDirectory: dir, mapleAcpCli: executable, mapleSessionId: "maple-existing-session",
    });
    cleanup.unshift(() => adapter.dispose());

    await adapter.waitForReady();
    const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(requests.map((entry) => entry.method)).toEqual(["initialize", "session/load"]);
    expect(requests[1].params).toMatchObject({
      sessionId: "maple-existing-session",
      cwd: dir,
      mcpServers: [],
    });
    expect(adapter.getSessionId()).toBe("maple-existing-session");
  });

  test("passes only connector runtime environment values", () => {
    const env = buildMapleAcpEnvironment({
      HOME: "/Users/maple",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/tmp/maple",
      XDG_RUNTIME_DIR: "/run/user/501",
      WINGMAN_CAPABILITY: "capability-secret",
      SESSION_ID: "wingman-session",
      NOSTR_PRIVATE_KEY: "nostr-secret",
      TOWER_NSEC: "tower-secret",
      OPENAI_API_KEY: "provider-secret",
      CASHU_TOKEN: "wallet-secret",
    }, {
      PATH: "/custom/bin",
      WINGMAN_OPERATOR_NSEC: "operator-secret",
      ANTHROPIC_API_KEY: "provider-secret",
    });

    expect(env).toEqual({
      HOME: "/Users/maple",
      TMPDIR: "/tmp/maple",
      PATH: "/custom/bin",
      XDG_RUNTIME_DIR: "/run/user/501",
    });
  });

  test("requires an absolute configured executable and fails visibly when it is missing", async () => {
    expect(() => resolveMapleAcpCli({
      id: "maple-test", port: 3700, agent: "maple", host: "127.0.0.1", mapleAcpCli: "maple",
    })).toThrow("absolute path");
    const adapter = new MapleAcpAdapter({
      id: "maple-test", port: 3700, agent: "maple", host: "127.0.0.1",
      workingDirectory: process.cwd(), mapleAcpCli: "/definitely/missing/maple",
    });
    cleanup.push(() => adapter.dispose());
    await expect(adapter.waitForReady()).rejects.toThrow("failed to start");
  });

  test("distinguishes Desktop service, sign-in, connection-limit, and protocol failures", () => {
    expect(formatMapleStartupError(new Error("service is unavailable at socket: No such file")))
      .toHaveProperty("message", expect.stringContaining("service is stopped or unavailable"));
    expect(formatMapleStartupError(new Error("authentication required")))
      .toHaveProperty("message", expect.stringContaining("signed out"));
    expect(formatMapleStartupError(new Error("connection limit reached")))
      .toHaveProperty("message", expect.stringContaining("connection limit"));
    expect(formatMapleStartupError(new Error("negotiated unsupported protocol 2")))
      .toHaveProperty("message", expect.stringContaining("requires ACP version 1"));
  });
});

const FAKE_MAPLE = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv.slice(2).join(" ") !== "acp") process.exit(9);
const lines = createInterface({ input: process.stdin });
let promptRequestId = null;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync("rpc.jsonl", JSON.stringify(message) + "\\n");
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "maple-session-1" } });
  if (message.method === "session/load") send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/prompt") {
    promptRequestId = message.id;
    send({ jsonrpc: "2.0", method: "session/update", params: { update: {
      sessionUpdate: "agent_message_chunk", messageId: "progress-1", content: { type: "text", text: "Checking the route." },
    } } });
    send({ jsonrpc: "2.0", id: 700, method: "session/request_permission", params: {
      sessionId: message.params.sessionId,
      toolCall: { toolCallId: "tool-permission", title: "Edit file" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    } });
  }
  if (message.id === 700 && message.result) {
    send({ jsonrpc: "2.0", method: "session/update", params: { update: {
      sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Edit file", status: "completed",
    } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { update: {
      sessionUpdate: "agent_message_chunk", messageId: "final-1", content: { type: "text", text: "Done." },
    } } });
    send({ jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } });
  }
});
`;
