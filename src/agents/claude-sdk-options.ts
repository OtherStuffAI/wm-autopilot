import { writeServerLog } from "../logging/server-logger";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AdapterSessionContext } from "./agent-adapter";
import { buildInheritedAgentEnvironment, sanitizeInjectedAgentEnvironment } from "./agent-environment";

/** Never inherit host provider credentials or the parent agent's session state. */
export function buildClaudeSdkEnvironment(context: AdapterSessionContext): Record<string, string> {
  return {
    ...buildInheritedAgentEnvironment(process.env),
    ...sanitizeInjectedAgentEnvironment(context.env ?? {}),
    SESSION_ID: context.id,
    SESSION_AGENT: "claude",
    SESSION_DIRECTORY: context.workingDirectory!,
    CLAUDE_AGENT_SDK_CLIENT_APP: "wingman-autopilot",
  };
}

export async function buildClaudeSdkOptions(context: AdapterSessionContext, abortController: AbortController): Promise<Options> {
  if (!context.workingDirectory) throw new Error("Claude SDK requires a working directory");
  if (context.claudeResume && !context.claudeSessionId) throw new Error("Claude SDK resume requires a native session identity");
  if (!context.claudeMcpConfigPath) throw new Error("Claude SDK requires session-private MCP configuration");
  const config = await Bun.file(context.claudeMcpConfigPath).json();
  const server = config?.mcpServers?.wingman;
  if (server?.type !== "stdio" || typeof server.command !== "string" || !Array.isArray(server.args)) {
    throw new Error("Claude SDK Wingman MCP configuration is missing or invalid");
  }
  return {
    cwd: context.workingDirectory,
    model: context.model || undefined,
    env: buildClaudeSdkEnvironment(context),
    stderr: (text) => writeServerLog("WARN", "[claude-sdk]", sanitizeClaudeSdkError(new Error(text), context.env).message),
    abortController,
    includePartialMessages: true,
    persistSession: true,
    ...(context.claudeResume ? { resume: context.claudeSessionId } : { sessionId: context.claudeSessionId }),
    pathToClaudeCodeExecutable: context.claudeCli ? Bun.which(context.claudeCli) ?? context.claudeCli : undefined,
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    strictMcpConfig: true,
    mcpServers: { wingman: { ...server, alwaysLoad: true } },
    ...(context.providerApprovalConfigured?.() ? { permissionMode: "default" as const }
      : context.claudeSkipPermissions ? { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } : {}),
  };
}

/** Redact session credentials before an SDK error reaches UI, logs or callers. */
export function sanitizeClaudeSdkError(error: unknown, env: Record<string, string> = {}): Error {
  let message = error instanceof Error ? error.message : "Claude SDK operation failed";
  for (const [key, value] of Object.entries(env)) {
    if (value && /token|key|secret|capability|auth/i.test(key)) message = message.split(value).join("[redacted]");
  }
  message = message.replace(/sk-ant-[\w-]+/g, "[redacted]");
  return new Error(message);
}
