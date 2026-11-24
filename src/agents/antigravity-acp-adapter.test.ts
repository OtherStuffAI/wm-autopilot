import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityAcpAdapter, buildAntigravityMcpServers, redactAntigravityError } from "./antigravity-acp-adapter";
import { resolveAdapterFactory, resolveAgentTransport, type AdapterSessionContext, type AdapterStreamEvent } from "./agent-adapter";
import { supportsNativeSessionResume } from "./native-session";
import { ProcessManager, transportRequiresEagerReadiness, transportSkipsAgentApiSpawn, transportUsesAcpPermissionPolicy } from "./process-manager";
import { loadConfig } from "../config";
import { normaliseSessionMetadata } from "../sessions/session-metadata";
import { createSessionSchema } from "../mcp/tools/create-session";
import { sessionDispatchSchema } from "../mcp/tools/session-dispatch";
import { resolveAgentModelCatalogue } from "../server/agent-model-catalogue";
import { resolveLaunchModelForHarness } from "../settings/harness-models";
import { parseAntigravityModels } from "../settings/harness-model-discovery";
import { getAvailableHarnesses, getModelOptionsForAgent } from "../ui/common/agent-model-lookups.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function setup(overrides: Partial<AdapterSessionContext> = {}, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wingman-antigravity-test-"));
  const cli = join(dir, "agy");
  writeFileSync(cli, FAKE_AGY);
  chmodSync(cli, 0o755);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const context: AdapterSessionContext = {
    id: "test-session", port: 3700, agent: "antigravity", host: "127.0.0.1", workingDirectory: dir,
    antigravityCli: cli, model: "gemini-4-neon-medium", acpPermissionPolicy: "ask",
    env: { WINGMAN_MCP_SERVER: "/tmp/stdio-server.ts", WINGMAN_URL: "http://localhost:3600", WINGMAN_BROKER_URL: "http://127.0.0.1:3600", WINGMAN_CAPABILITY: "test-opaque-capability", SESSION_ID: "test-session", ...env },
    ...overrides,
  };
  const adapter = new AntigravityAcpAdapter(context);
  cleanups.unshift(() => adapter.dispose());
  return { adapter, context, dir, requests: () => readFileSync(join(dir, "rpc.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
}

test("registers a distinct ACP agent in configuration, UI models, MCP and resume", () => {
  expect(createSessionSchema.agent.parse("antigravity")).toBe("antigravity");
  expect(sessionDispatchSchema.agent.parse("antigravity")).toBe("antigravity");
  expect(resolveAgentTransport("antigravity", "agentapi")).toBe("antigravity-acp");
  expect(resolveAgentTransport("gemini")).toBe("agentapi");
  expect(transportSkipsAgentApiSpawn("antigravity-acp")).toBe(true);
  expect(transportRequiresEagerReadiness("antigravity-acp")).toBe(true);
  expect(transportUsesAcpPermissionPolicy("antigravity-acp")).toBe(true);
  expect(supportsNativeSessionResume("antigravity")).toBe(true);
  expect(normaliseSessionMetadata({ agentTransport: "antigravity-acp" }).agentTransport).toBe("antigravity-acp");
  const agents = resolveAgentModelCatalogue(loadConfig().agents, { modelProviders: null, harnessModels: null });
  expect(getAvailableHarnesses({ agents })).toContainEqual({ id: "antigravity", label: "Antigravity" });
  expect(getModelOptionsForAgent({ agents }, "antigravity")).toContain("gemini-4-neon-xhigh");
  expect(resolveLaunchModelForHarness("antigravity", "unavailable", ["default"])).toEqual({ model: "unavailable", fallbackFrom: null });
});

test("confirms model family and thinking level, streams separate turns, injects scoped MCP", async () => {
  const { adapter, requests } = setup();
  const events: AdapterStreamEvent[] = [];
  adapter.subscribeToEvents((event) => events.push(event));
  await adapter.sendMessage("first");
  await adapter.sendMessage("follow-up");
  expect(adapter.getRunningModel()).toBe("gemini-4-neon-medium");
  const rpc = requests();
  expect(rpc.slice(0, 4).map((entry) => entry.method)).toEqual(["initialize", "session/new", "session/set_config_option", "session/set_config_option"]);
  expect(rpc[0].params.clientCapabilities).toEqual({});
  expect(rpc[1].params.mcpServers[0].env).toContainEqual({ name: "WINGMAN_CAPABILITY", value: "test-opaque-capability" });
  expect(rpc.filter((entry) => entry.method === "session/prompt").map((entry) => entry.params.sessionId)).toEqual(["native-agy", "native-agy"]);
  expect((await adapter.fetchMessages()).filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["NEON_OK", "NEON_OK"]);
  expect(events.filter((e) => e.type === "message" && e.message.role === "assistant").length).toBe(4);
  expect(await adapter.fetchStatus()).toBe("stable");
});

test("confirms every advertised Neon thinking level", async () => {
  for (const level of ["low", "medium", "high", "xhigh"]) {
    const model = `gemini-4-neon-${level}`;
    const { adapter } = setup({ model });
    await adapter.waitForReady();
    expect(adapter.getRunningModel()).toBe(model);
  }
});

test("loads a saved native session and retains its ID", async () => {
  const { adapter, requests } = setup({ antigravitySessionId: "saved-agy" });
  await adapter.waitForReady();
  expect(requests()[1]).toMatchObject({ method: "session/load", params: { sessionId: "saved-agy" } });
  expect(adapter.getSessionId()).toBe("saved-agy");
});

test("refuses unsupported resume, unavailable models and unconfirmed selections", async () => {
  const resume = setup({ antigravitySessionId: "saved" }, { NO_LOAD: "1" });
  await expect(resume.adapter.waitForReady()).rejects.toThrow("does not advertise");
  const unavailable = setup({ model: "invented-model" });
  await expect(unavailable.adapter.waitForReady()).rejects.toThrow("not advertised");
  expect(unavailable.requests().some((r) => r.method === "session/prompt")).toBe(false);
  const inconsistent = setup({}, { BAD_MODEL: "1" });
  await expect(inconsistent.adapter.waitForReady()).rejects.toThrow("could not confirm");
});

test("surfaces tool permission and sends the exact advertised choice", async () => {
  const { adapter, requests } = setup();
  const turn = adapter.sendMessage("permission");
  for (let i = 0; i < 150 && !adapter.getPendingPermissions().length; i++) await Bun.sleep(10);
  const permission = adapter.getPendingPermissions()[0]!;
  expect(permission.options.map((o) => o.response)).toEqual(["once", "reject"]);
  expect((await adapter.getPromptReadiness()).state).toBe("busy");
  await expect(adapter.respondToPermission(permission.id, "always")).rejects.toThrow("does not offer");
  await adapter.respondToPermission(permission.id, "once");
  await turn;
  expect(requests().find((r) => r.id === "permission-1" && r.result)?.result).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
});

test("auto approval and cancellation use existing ACP policy without CLI bypass", async () => {
  const approved = setup({ acpPermissionPolicy: "auto_approve" });
  await approved.adapter.sendMessage("permission");
  expect(approved.adapter.getPendingPermissions()).toEqual([]);
  const cancelled = setup();
  await cancelled.adapter.waitForReady();
  const turn = cancelled.adapter.sendMessage("hold");
  for (let i = 0; i < 150 && !cancelled.requests().some((r) => r.method === "session/prompt"); i++) await Bun.sleep(10);
  expect(await cancelled.adapter.interruptCurrentTurn()).toBe(true);
  await turn;
  expect(cancelled.requests().some((r) => r.method === "session/cancel" && r.id === undefined)).toBe(true);
});

test("requires broker injection and redacts capabilities in errors", () => {
  expect(() => buildAntigravityMcpServers({})).toThrow("MCP injection");
  expect(() => buildAntigravityMcpServers({ WINGMAN_MCP_SERVER: "/mcp.ts" })).toThrow("broker context");
  expect(redactAntigravityError(new Error("401 opaque"), { WINGMAN_CAPABILITY: "opaque" }).message).toContain("401 [redacted]");
  expect(redactAntigravityError(new Error("Model not advertised by your authenticated agy account"), {}).message).not.toContain("Sign in");
});

test("parses authenticated model discovery and rejects empty or malformed catalogues", () => {
  expect(parseAntigravityModels("Fetching available models...\ngemini-4-neon-medium\tNeon Medium\ngemini-4-neon-high\tNeon High\n")).toEqual(["gemini-4-neon-medium", "gemini-4-neon-high"]);
  expect(() => parseAntigravityModels("Please log in")).toThrow("No selectable models");
  expect(() => parseAntigravityModels("bad model\tBad")).toThrow("invalid model catalogue");
});

test("ProcessManager rehydrates Antigravity through its adapter with pinned transport and model", async () => {
  const { context } = setup();
  const config = loadConfig();
  config.agents.antigravity = { label: "Antigravity", modelOptions: ["default", "gemini-4-neon-medium"], env: context.env, command: () => ["agentapi", "--", context.antigravityCli!] };
  const manager = new ProcessManager(config);
  const snapshot = manager.rehydrateSession({ id: "adopted-agy", agent: "antigravity", port: 3799, name: "test", workingDirectory: context.workingDirectory!, startedAt: new Date().toISOString(), model: context.model, metadata: { agentTransport: "antigravity-acp", nativeAgentSession: { agent: "antigravity", sessionId: "saved-agy", workingDirectory: context.workingDirectory!, capturedAt: new Date().toISOString(), source: "adapter" } } });
  const adapter = manager.getAdapter("adopted-agy")!;
  cleanups.unshift(() => adapter.dispose());
  expect(snapshot?.metadata.agentTransport).toBe("antigravity-acp");
  expect(adapter).toBeInstanceOf(AntigravityAcpAdapter);
  await adapter.waitForReady();
  expect(adapter.getRunningModel?.()).toBe("gemini-4-neon-medium");
  const resolved = resolveAdapterFactory("antigravity", "antigravity-acp")(context);
  cleanups.unshift(() => resolved.dispose());
  expect(resolved).toBeInstanceOf(AntigravityAcpAdapter);
});

const FAKE_AGY = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const model = { id: "model", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon" }] };
const thought = { id: "thought_level", currentValue: "high", options: ["low", "medium", "high", "xhigh"].map(value => ({ value })) };
const result = () => ({ sessionId: "native-agy", models: { currentModelId: "gemini-4-neon-high", availableModels: ["low", "medium", "high", "xhigh"].map(level => ({ modelId: "gemini-4-neon-" + level })) }, configOptions: [model, thought] });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
let pending;
const done = id => { for (const text of ["NE", "ON_OK"]) send({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } }); send({ id, result: { stopReason: "end_turn" } }); };
createInterface({ input: process.stdin }).on("line", line => {
  const r = JSON.parse(line); appendFileSync("rpc.jsonl", JSON.stringify(r) + "\\n");
  if (r.result) { if (pending) done(pending); pending = null; return; }
  if (r.method === "initialize") send({ id: r.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: !process.env.NO_LOAD } } });
  else if (r.method === "session/new" || r.method === "session/load") send({ id: r.id, result: { ...result(), sessionId: r.params.sessionId || "native-agy" } });
  else if (r.method === "session/set_config_option") { if (!process.env.BAD_MODEL) (r.params.configId === "model" ? model : thought).currentValue = r.params.value; send({ id: r.id, result: { configOptions: [model, thought] } }); }
  else if (r.method === "session/prompt") {
    const text = r.params.prompt[0].text;
    if (text === "permission") { pending = r.id; send({ id: "permission-1", method: "session/request_permission", params: { toolCall: { title: "Read file" }, options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Reject", kind: "reject_once" }] } }); }
    else if (text === "hold") pending = r.id;
    else done(r.id);
  } else if (r.method === "session/cancel") { done(pending); pending = null; }
});
`;
