import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProcessClient } from "../src/agents/acp-process-client";
import { buildDeepSeekEnvironment, buildDeepSeekMcpServers, DEEPSEEK_ACP_PATCH, resolveDeepSeekRuntime } from "../src/agents/deepseek-acp-adapter";

// This smoke never calls a model or uses real credentials. It owns all its processes.
const command = resolveDeepSeekRuntime(process.env.DEEPSEEK_ACP_CLI);
const root = await mkdtemp(join(tmpdir(), "wingman-deepseek-protocol-"));
interface SmokeResult {
  protocolVersion?: number;
  agentCapabilities?: { sessionCapabilities?: { resume?: object } };
  sessionId?: string;
  configOptions?: unknown[];
}
const clients: AcpProcessClient[] = [];
const verifyMcp = process.argv.includes("--wingman-mcp");
const mcpServers = verifyMcp ? buildDeepSeekMcpServers({
  WINGMAN_MCP_SERVER: fileURLToPath(new URL("../src/mcp/stdio-server.ts", import.meta.url)),
  ...Object.fromEntries(["WINGMAN_URL", "WINGMAN_BROKER_URL", "WINGMAN_CAPABILITY", "SESSION_ID"].map((name) => [name, process.env[name] ?? ""])),
}) : [];
function client(): AcpProcessClient {
  const result = new AcpProcessClient({
    command, args: ["--profile", "acp", "--patch", DEEPSEEK_ACP_PATCH],
    workingDirectory: root,
    env: buildDeepSeekEnvironment({ id: "protocol-only", port: 0, agent: "deepseek", host: "127.0.0.1", env: { DSH_HOME: root }, deepseekApiKey: "protocol-only-invalid-key-no-model-calls" }),
    label: "DeepSeek protocol smoke",
  });
  clients.push(result);
  return result;
}
function success(response: { error?: unknown; result?: unknown }): SmokeResult {
  if (response.error) throw new Error(JSON.stringify(response.error));
  return response.result as SmokeResult;
}
try {
  const first = client();
  await first.start();
  const initialized = success(await first.request("initialize", { protocolVersion: 1, clientCapabilities: {} }));
  if (initialized.protocolVersion !== 1 || !initialized.agentCapabilities?.sessionCapabilities?.resume) throw new Error("DeepSeek did not advertise ACP v1 session/resume");
  const session = success(await first.request("session/new", { cwd: root, mcpServers }));
  if (!session.sessionId) throw new Error("DeepSeek did not create a native session");
  success(await first.request("session/close", { sessionId: session.sessionId }));
  await first.stop();
  const second = client();
  await second.start();
  success(await second.request("initialize", { protocolVersion: 1, clientCapabilities: {} }));
  const resumed = success(await second.request("session/resume", { sessionId: session.sessionId, cwd: root, mcpServers }));
  if (!Array.isArray(resumed.configOptions)) throw new Error("Resume did not return configuration options");
  success(await second.request("session/close", { sessionId: session.sessionId }));
  if (verifyMcp) console.log("PASS: real Wingman MCP stdio startup/list-tools through ACP new and resume, using this session’s existing broker capability. No MCP tool invocation or model call performed.");
  console.log("PASS: pinned real runtime ACP v1 initialize, session/new, close, cross-process session/resume. No authenticated model work or MCP tool invocation performed.");
} finally {
  for (const owned of clients) await owned.stop();
  await rm(root, { recursive: true, force: true });
}
