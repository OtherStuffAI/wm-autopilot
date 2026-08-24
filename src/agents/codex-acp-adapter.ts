import { fileURLToPath } from "node:url";

import type { AdapterSessionContext } from "./agent-adapter";
import { AcpAdapter } from "./acp-adapter";
import type { AcpProcessClient, AcpResponse } from "./acp-process-client";

const DEFAULT_CODEX_ACP_CLI = fileURLToPath(new URL("../../node_modules/.bin/codex-acp", import.meta.url));

export function buildCodexAcpRuntimeEnv(context: AdapterSessionContext): Record<string, string> {
  const env = {
    ...(process.env as Record<string, string>),
    ...(context.env ?? {}),
  };
  const codexCli = context.codexCli?.trim() || env.CODEX_CLI?.trim();
  if (codexCli) env.CODEX_PATH = Bun.which(codexCli) ?? codexCli;

  const existingConfig = parseCodexConfig(env.CODEX_CONFIG);
  const mergedConfig = deepMerge(existingConfig, context.codexConfig ?? {});
  if (Object.keys(mergedConfig).length > 0) env.CODEX_CONFIG = JSON.stringify(mergedConfig);
  return env;
}

export function buildCodexAcpMcpServers(codexConfig: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  if (codexConfig?.mcp_servers !== undefined && !isRecord(codexConfig.mcp_servers)) {
    throw new Error("Codex ACP mcp_servers config must be an object");
  }
  const configured = isRecord(codexConfig?.mcp_servers) ? codexConfig.mcp_servers : {};
  const servers: Array<Record<string, unknown>> = [];
  for (const [name, value] of Object.entries(configured)) {
    if (!isRecord(value) || typeof value.command !== "string" || !value.command.trim()) {
      throw new Error(`Codex ACP MCP server ${name} requires a command`);
    }
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((entry) => typeof entry !== "string"))) {
      throw new Error(`Codex ACP MCP server ${name} args must be strings`);
    }
    if (value.env !== undefined && (!isRecord(value.env) || Object.values(value.env).some((entry) => typeof entry !== "string"))) {
      throw new Error(`Codex ACP MCP server ${name} env values must be strings`);
    }
    const args = Array.isArray(value.args) ? value.args as string[] : [];
    const env = isRecord(value.env)
      ? Object.entries(value.env).map(([envName, envValue]) => ({ name: envName, value: envValue as string }))
      : [];
    servers.push({ name, command: value.command, args, env });
  }
  return servers;
}

export class CodexAcpAdapter extends AcpAdapter {
  constructor(context: AdapterSessionContext) {
    const env = buildCodexAcpRuntimeEnv(context);
    super(context, {
      agentName: "Codex",
      protocolVersion: 1,
      command: context.codexAcpCli?.trim() || env.CODEX_ACP_CLI?.trim() || DEFAULT_CODEX_ACP_CLI,
      env,
      sessionId: context.codexThreadId,
      mcpServers: buildCodexAcpMcpServers(context.codexConfig),
      cancelIsNotification: true,
      configureSession: async (client, sessionId, response) => {
        await configureCodexSession(client, sessionId, response, context);
      },
    });
  }
}

async function configureCodexSession(
  client: AcpProcessClient,
  sessionId: string,
  _response: AcpResponse,
  context: AdapterSessionContext,
): Promise<void> {
  const model = context.model?.trim();
  if (model) {
    assertSuccess(await client.request("session/set_config_option", {
      sessionId,
      configId: "model",
      value: model,
    }), "model selection");
  }
  const reasoningEffort = typeof context.codexConfig?.model_reasoning_effort === "string"
    ? context.codexConfig.model_reasoning_effort.trim()
    : "";
  if (reasoningEffort) {
    assertSuccess(await client.request("session/set_config_option", {
      sessionId,
      configId: "reasoning_effort",
      value: reasoningEffort,
    }), "reasoning selection");
  }
}

function assertSuccess(response: AcpResponse, operation: string): void {
  if (response.error) throw new Error(`Codex ACP ${operation} failed: ${response.error.message ?? "unknown error"}`);
}

function parseCodexConfig(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`CODEX_CONFIG must be valid JSON for Codex ACP: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error("CODEX_CONFIG must contain a JSON object for Codex ACP");
  return parsed;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isRecord(value) && isRecord(result[key])
      ? deepMerge(result[key] as Record<string, unknown>, value)
      : value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
