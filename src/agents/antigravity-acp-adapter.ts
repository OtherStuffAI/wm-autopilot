import type { AdapterSessionContext } from "./agent-adapter";
import { AcpAdapter } from "./acp-adapter";
import { buildInheritedAgentEnvironment, sanitizeInjectedAgentEnvironment } from "./agent-environment";
import { configureAntigravityModel, readAntigravityModel } from "./antigravity-model-config";

/** Pass only the session's scoped capability to MCP; never inherit host secrets. */
export function buildAntigravityMcpServers(env: Record<string, string>): Array<Record<string, unknown>> {
  if (!env.WINGMAN_MCP_SERVER) throw new Error("Antigravity requires Wingman MCP injection.");
  for (const name of ["WINGMAN_URL", "WINGMAN_BROKER_URL", "WINGMAN_CAPABILITY", "SESSION_ID"]) {
    if (!env[name]) throw new Error(`Antigravity is missing required broker context: ${name}`);
  }
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Antigravity Wingman MCP requires Bun on PATH.");
  const names = ["WINGMAN_URL", "WINGMAN_BROKER_URL", "WINGMAN_CAPABILITY", "SESSION_ID", "WINGMAN_NPUB", "BOT_PUBKEY_HEX", "BOT_NPUB", "USER_NPUB"];
  return [{
    name: "wingman", command: bun, args: ["run", env.WINGMAN_MCP_SERVER],
    env: names.filter((name) => env[name]).map((name) => ({ name, value: env[name] })),
  }];
}

export class AntigravityAcpAdapter extends AcpAdapter {
  constructor(context: AdapterSessionContext) {
    const env = {
      ...buildInheritedAgentEnvironment(process.env),
      ...sanitizeInjectedAgentEnvironment(context.env ?? {}),
    };
    super(context, {
      agentName: "Antigravity",
      command: context.antigravityCli?.trim() || "agy",
      args: ["acp"],
      env,
      protocolVersion: 1,
      sessionId: context.antigravitySessionId,
      mcpServers: buildAntigravityMcpServers(env),
      cancelIsNotification: true,
      aggregateAutoApprovedPermissions: true,
      rollIntermediateAgentMessages: true,
      configureSession: (client, id, response) => configureAntigravityModel(client, id, response, context.model),
      readRunningModel: readAntigravityModel,
      formatError: (error) => redactAntigravityError(error, env),
    });
  }
}

export function redactAntigravityError(error: Error, env: Record<string, string>): Error {
  let message = error.message;
  const capability = env.WINGMAN_CAPABILITY;
  if (capability) message = message.split(capability).join("[redacted]");
  if (/\bauth(?:entication|orization)?\b|login|log in|credential|401|403/i.test(message)) {
    message += " Sign in with agy on the Autopilot host and verify account model access; legacy Gemini credentials are separate.";
  }
  return new Error(message);
}
