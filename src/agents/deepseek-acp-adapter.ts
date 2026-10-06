import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AdapterSessionContext } from "./agent-adapter";
import { AcpAdapter } from "./acp-adapter";
import { buildInheritedAgentEnvironment, sanitizeInjectedAgentEnvironment } from "./agent-environment";
import { configureDeepSeekModel } from "./deepseek-model-config";

export const DEEPSEEK_RUNTIME_VERSION = "0.2.0-rc.2";
export const DEEPSEEK_ACP_PATCH = fileURLToPath(new URL("../../config/agents/deepseek-acp.patch.yml", import.meta.url));

export function buildDeepSeekEnvironment(context: AdapterSessionContext): Record<string, string> {
  const env: Record<string, string> = {
    ...buildInheritedAgentEnvironment(process.env),
    ...sanitizeInjectedAgentEnvironment(context.env ?? {}),
    DSH_HOME: context.env?.DSH_HOME || join(homedir(), ".wingman", "deepseek-harness"),
    DSH_TELEMETRY_DISABLED: "1",
    DSH_TELEMETRY_MODE: "DISABLED",
  };
  const key = context.deepseekApiKey?.trim() || env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error("DeepSeek Harness requires a DeepSeek API Key in Instance Settings (integrations.deepseek_api_key / DEEPSEEK_API_KEY). No credential was configured.");
  return { ...env, DEEPSEEK_API_KEY: key };
}

export function resolveDeepSeekRuntime(command: string | undefined): string {
  if (!command || !isAbsolute(command)) {
    throw new Error(`Set agents.deepseek_acp_cli / DEEPSEEK_ACP_CLI to the absolute path of an installed dsh ${DEEPSEEK_RUNTIME_VERSION}; see docs/deepseek-harness.md`);
  }
  let version: string;
  try {
    version = execFileSync(command, ["--version"], {
      env: buildInheritedAgentEnvironment(process.env),
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString().trim();
  } catch {
    throw new Error(`DeepSeek Harness executable is missing or cannot run: ${command}. Install dsh ${DEEPSEEK_RUNTIME_VERSION} with supported Node.js and configure its absolute path; see docs/deepseek-harness.md`);
  }
  if (version !== DEEPSEEK_RUNTIME_VERSION) {
    throw new Error(`DeepSeek Harness runtime must be pinned to ${DEEPSEEK_RUNTIME_VERSION}; executable reports ${version}. Install the validated version before starting a session.`);
  }
  return command;
}

export function buildDeepSeekMcpServers(env: Record<string, string>): Array<Record<string, unknown>> {
  if (!env.WINGMAN_MCP_SERVER) throw new Error("DeepSeek Harness is missing Wingman MCP injection; configure the session capability broker before starting.");
  if (!env.WINGMAN_URL || !env.WINGMAN_CAPABILITY || !env.WINGMAN_BROKER_URL || !env.SESSION_ID) {
    throw new Error("DeepSeek Harness is missing its scoped Wingman broker capability or session context.");
  }
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Wingman MCP requires Bun on PATH; DeepSeek ACP requires an absolute MCP executable path.");
  const names = ["WINGMAN_URL", "WINGMAN_BROKER_URL", "WINGMAN_CAPABILITY", "SESSION_ID", "WINGMAN_NPUB", "BOT_PUBKEY_HEX", "BOT_NPUB", "USER_NPUB"];
  return [{
    name: "wingman", command: bun, args: ["run", env.WINGMAN_MCP_SERVER],
    env: names.filter((name) => env[name]).map((name) => ({ name, value: env[name] })),
  }];
}

export class DeepSeekAcpAdapter extends AcpAdapter {
  constructor(context: AdapterSessionContext) {
    const command = resolveDeepSeekRuntime(context.deepseekAcpCli);
    const env = buildDeepSeekEnvironment(context);
    mkdirSync(env.DSH_HOME!, { recursive: true, mode: 0o700 });
    super(context, {
      agentName: "DeepSeek Harness",
      protocolVersion: 1,
      command,
      args: ["--profile", "acp", "--patch", DEEPSEEK_ACP_PATCH],
      env,
      processWorkingDirectory: env.DSH_HOME,
      sessionId: context.deepseekSessionId,
      resumeMethod: "session/resume",
      mcpServers: buildDeepSeekMcpServers(env),
      cancelIsNotification: true,
      aggregateAutoApprovedPermissions: true,
      rollIntermediateAgentMessages: true,
      formatError: (error) => redactDeepSeekError(error, env),
      configureSession: (client, id, response) => configureDeepSeekModel(client, id, response, context.model),
    });
  }
}

export function redactDeepSeekError(error: Error, env: Record<string, string>): Error {
  let message = error.message;
  for (const name of ["DEEPSEEK_API_KEY", "WINGMAN_CAPABILITY"]) {
    const value = env[name];
    if (value) message = message.split(value).join("[redacted]");
  }
  if (/401|403|credential|api.?key|unauthorized/i.test(message)) {
    message += " Verify the DeepSeek API Key in Instance Settings and provider account access.";
  }
  return new Error(message);
}
