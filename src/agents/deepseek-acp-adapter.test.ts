import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekAcpAdapter, buildDeepSeekEnvironment, buildDeepSeekMcpServers, resolveDeepSeekRuntime, DEEPSEEK_ACP_PATCH, redactDeepSeekError } from "./deepseek-acp-adapter";
import type { AdapterSessionContext } from "./agent-adapter";
import { resolveAgentTransport } from "./agent-adapter";
import { supportsNativeSessionResume } from "./native-session";
import { transportRequiresEagerReadiness, transportSkipsAgentApiSpawn, transportUsesAcpPermissionPolicy } from "./process-manager";
import { ProcessManager } from "./process-manager";
import type { WingmanConfig } from "../config";
import { createSessionSchema } from "../mcp/tools/create-session";
import { sessionDispatchSchema } from "../mcp/tools/session-dispatch";
import { resolveAgentModelCatalogue } from "../server/agent-model-catalogue";
import { isAgentType, AGENT_TYPE_LABELS } from "../agent-types";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function setup(overrides: Partial<AdapterSessionContext> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wingman-deepseek-test-"));
  const cli = join(dir, "dsh");
  writeFileSync(cli, FAKE_DSH);
  chmodSync(cli, 0o755);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const context: AdapterSessionContext = {
    id: "wingman-session", port: 3700, agent: "deepseek", host: "127.0.0.1", workingDirectory: dir,
    deepseekAcpCli: cli, deepseekApiKey: "test-provider-secret",
    env: { DSH_HOME: dir, WINGMAN_MCP_SERVER: "/tmp/stdio-server.ts", WINGMAN_URL: "http://localhost:3600", WINGMAN_BROKER_URL: "http://127.0.0.1:3600", WINGMAN_CAPABILITY: "test-opaque-capability", SESSION_ID: "wingman-session" },
    ...overrides,
  };
  const adapter = new DeepSeekAcpAdapter(context);
  cleanups.unshift(() => adapter.dispose());
  return { adapter, context, dir, requests: () => readFileSync(join(dir, "rpc.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
}

test("registers DeepSeek with native ACP readiness and resume", () => {
  expect(isAgentType("deepseek")).toBe(true);
  expect(createSessionSchema.agent.parse("deepseek")).toBe("deepseek");
  expect(sessionDispatchSchema.agent.parse("deepseek")).toBe("deepseek");
  expect(resolveAgentModelCatalogue({ deepseek: { label: "DeepSeek Harness", modelOptions: ["default"] } }, { modelProviders: null, harnessModels: null })).toEqual([{ id: "deepseek", label: "DeepSeek Harness", modelOptions: ["default"] }]);
  expect(AGENT_TYPE_LABELS.deepseek).toBe("DeepSeek Harness");
  expect(resolveAgentTransport("deepseek", "agentapi")).toBe("deepseek-acp");
  expect(transportSkipsAgentApiSpawn("deepseek-acp")).toBe(true);
  expect(transportRequiresEagerReadiness("deepseek-acp")).toBe(true);
  expect(transportUsesAcpPermissionPolicy("deepseek-acp")).toBe(true);
  expect(supportsNativeSessionResume("deepseek")).toBe(true);
});

test("negotiates ACP v1 with broker MCP and privacy overlay, then completes a streamed turn", async () => {
  const { adapter, context, dir, requests } = setup();
  await adapter.sendMessage("hello");
  expect(requests().map((entry) => entry.method)).toEqual(["initialize", "session/new", "session/prompt"]);
  const server = requests()[1].params.mcpServers[0];
  expect(server.command.startsWith("/")).toBe(true);
  expect(server.env).toContainEqual({ name: "WINGMAN_CAPABILITY", value: "test-opaque-capability" });
  expect(JSON.stringify(server)).not.toContain("test-provider-secret");
  expect(readFileSync(join(dir, "argv.json"), "utf8")).toBe(JSON.stringify(["--profile", "acp", "--patch", DEEPSEEK_ACP_PATCH]));
  const messages = await adapter.fetchMessages();
  expect(messages.some((message) => message.role === "assistant" && message.content === "Done.")).toBe(true);
  expect(messages.some((message) => message.content.includes("Tool call: Read file (completed)"))).toBe(true);
  expect(await adapter.fetchStatus()).toBe("stable");
  expect(adapter.getSessionId()).toBe("native-deepseek-session");
  expect(adapter.getRunningModel()).toBe(JSON.stringify(["deepseek-official", "deepseek-v4-flash"]));
  expect(buildDeepSeekEnvironment(context).DSH_TELEMETRY_DISABLED).toBe("1");
  expect(readFileSync(DEEPSEEK_ACP_PATCH, "utf8")).toContain("id: session-log-deepseek\n  disabled: true");
});

test("resumes using session/resume without inventing session/load", async () => {
  const { adapter, requests } = setup({ deepseekSessionId: "existing" });
  await adapter.waitForReady();
  expect(requests().map((entry) => entry.method)).toEqual(["initialize", "session/resume"]);
  expect(adapter.getSessionId()).toBe("existing");
});

test("maps advertised grouped model options and confirms selection", async () => {
  const { adapter, requests } = setup({ model: "deepseek-v4-flash" });
  await adapter.waitForReady();
  expect(requests()[2]).toMatchObject({ method: "session/set_config_option", params: { value: JSON.stringify(["deepseek-official", "deepseek-v4-flash"]) } });
});

test("rejects unavailable models instead of silently using the default", async () => {
  const { adapter } = setup({ model: "unavailable" });
  await expect(adapter.waitForReady()).rejects.toThrow("not advertised");
});

test("waits for permission, responds once, and returns completion", async () => {
  const { adapter } = setup({ acpPermissionPolicy: "ask" });
  const turn = adapter.sendMessage("permission");
  for (let i = 0; i < 100 && !adapter.getPendingPermissions().length; i++) await Bun.sleep(10);
  expect(adapter.getPendingPermissions()).toHaveLength(1);
  expect((await adapter.getPromptReadiness()).state).toBe("busy");
  await adapter.respondToPermission("permit", "once");
  await turn;
  expect(adapter.getPendingPermissions()).toHaveLength(0);
  expect(await adapter.fetchStatus()).toBe("stable");
});

test("cancels permission and sends cancellation as a notification", async () => {
  const { adapter, requests } = setup({ acpPermissionPolicy: "ask" });
  const turn = adapter.sendMessage("permission");
  for (let i = 0; i < 100 && !adapter.getPendingPermissions().length; i++) await Bun.sleep(10);
  expect(await adapter.interruptCurrentTurn()).toBe(true);
  await turn;
  expect(requests().find((entry) => entry.method === "session/cancel").id).toBeUndefined();
  expect(adapter.getPendingPermissions()).toHaveLength(0);
});

test("requires configured runtime, credential and broker; strips raw signing keys", () => {
  expect(redactDeepSeekError(new Error("401 test-secret test-capability"), { DEEPSEEK_API_KEY: "test-secret", WINGMAN_CAPABILITY: "test-capability" }).message).toBe("401 [redacted] [redacted] Verify the DeepSeek API Key in Instance Settings and provider account access.");
  expect(() => resolveDeepSeekRuntime(undefined)).toThrow("absolute path");
  expect(() => resolveDeepSeekRuntime("/missing/dsh")).toThrow("missing or cannot run");
  const wrongDir = mkdtempSync(join(tmpdir(), "wingman-deepseek-version-"));
  const wrongVersion = join(wrongDir, "dsh");
  writeFileSync(wrongVersion, "#!/bin/sh\nprintf '9.9.9\\n'\n");
  chmodSync(wrongVersion, 0o755);
  cleanups.push(() => rmSync(wrongDir, { recursive: true, force: true }));
  expect(() => resolveDeepSeekRuntime(wrongVersion)).toThrow("must be pinned to 0.2.0-rc.2");
  const { context } = setup();
  expect(() => buildDeepSeekEnvironment({ ...context, deepseekApiKey: undefined })).toThrow("No credential");
  expect(() => buildDeepSeekMcpServers({})).toThrow("missing Wingman MCP");
  expect(buildDeepSeekEnvironment({ ...context, env: { ...context.env, AGENT_NSEC: "secret", NOSTR_SECRET_KEY: "secret" } }).AGENT_NSEC).toBeUndefined();
});

test("manager eagerly negotiates, captures native identity and exposes dispatch completion", async () => {
  const { context, dir, requests } = setup();
  const config = {
    allowedHosts: "127.0.0.1", baseUrl: "http://127.0.0.1:3600", port: 3600,
    agentPortStart: 47984, agentPortMax: 47984,
    agents: { deepseek: {
      label: "DeepSeek Harness", modelOptions: ["default"],
      command: () => ["agentapi", "--", context.deepseekAcpCli!],
      env: { DSH_HOME: dir, DEEPSEEK_API_KEY: "test-manager-key" },
    } },
  } as unknown as WingmanConfig;
  const manager = new ProcessManager(config, {
    issueSessionCapability: () => ({ token: "test-manager-capability", botPubkeyHex: "a".repeat(64), botNpub: "npub-test", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  });
  const session = await manager.createSession("deepseek", dir, "Harness worker", null, undefined, "npub-owner", { acpPermissionPolicy: "ask" });
  const adapter = manager.getAdapter(session.id)!;
  cleanups.unshift(() => adapter.dispose());
  expect(session.metadata?.agentTransport).toBe("deepseek-acp");
  expect(session.metadata?.nativeAgentSession?.sessionId).toBe("native-deepseek-session");
  expect(session.status).toBe("running");
  expect(requests().map((entry) => entry.method)).toEqual(["initialize", "session/new"]);
  await adapter.sendMessage("worker prompt");
  expect(await adapter.fetchStatus()).toBe("stable");
  expect((await adapter.fetchMessages()).some((message) => message.role === "assistant" && message.content === "Done.")).toBe(true);
});

const FAKE_DSH = `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) { console.log("0.2.0-rc.2"); process.exit(0); }
writeFileSync("argv.json", JSON.stringify(process.argv.slice(2)));
const model = JSON.stringify(["deepseek-official", "deepseek-v4-flash"]);
const configOptions = [{ id: "model", currentValue: model, options: [{ group: "DeepSeek", options: [{ value: model, name: "Flash" }] }] }];
const send = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
const update = (data) => console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-deepseek-session", update: data } }));
let prompt;
createInterface({ input: process.stdin }).on("line", (line) => {
 const message = JSON.parse(line); appendFileSync("rpc.jsonl", line + "\\n");
 if (message.method === "initialize") return send(message.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } });
 if (message.method === "session/new") return send(message.id, { sessionId: "native-deepseek-session", configOptions });
 if (message.method === "session/resume" || message.method === "session/set_config_option") return send(message.id, { configOptions });
 if (message.method === "session/prompt") {
  if (message.params.prompt[0].text === "permission") {
   prompt = message.id;
   console.log(JSON.stringify({ jsonrpc: "2.0", id: "permit", method: "session/request_permission", params: { options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }] } })); return;
  }
  update({ sessionUpdate: "tool_call", toolCallId: "read", title: "Read file", status: "in_progress" });
  update({ sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed" });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
  return send(message.id, { stopReason: "end_turn" });
 }
 if (message.id === "permit") { send(prompt, { stopReason: message.result.outcome.outcome === "cancelled" ? "cancelled" : "end_turn" }); }
});
`;
