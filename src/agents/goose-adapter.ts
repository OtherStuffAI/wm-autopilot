import type { AdapterSessionContext } from "./agent-adapter";
import { AcpAdapter } from "./acp-adapter";

const DEFAULT_GOOSE_CLI = "/usr/local/bin/goose";

export function buildGooseRuntimeEnv(context: AdapterSessionContext): Record<string, string> {
  const env = {
    ...(process.env as Record<string, string>),
    ...(context.env ?? {}),
  };
  const model = context.model?.trim();
  if (model) env.GOOSE_MODEL = model;
  const provider = env.GOOSE_PROVIDER?.trim() || context.gooseProvider?.trim();
  if (provider) env.GOOSE_PROVIDER = provider;
  if (env.OPENROUTER_API_KEY && !env.GOOSE_PROVIDER__API_KEY) {
    env.GOOSE_PROVIDER__API_KEY = env.OPENROUTER_API_KEY;
  }
  if (env.OPENROUTER_HOST && !env.GOOSE_PROVIDER__HOST) {
    env.GOOSE_PROVIDER__HOST = env.OPENROUTER_HOST;
  }
  return env;
}

export class GooseAdapter extends AcpAdapter {
  constructor(context: AdapterSessionContext) {
    const env = buildGooseRuntimeEnv(context);
    super(context, {
      agentName: "Goose",
      command: context.gooseCli || env.GOOSE_CLI || DEFAULT_GOOSE_CLI,
      args: ["acp"],
      env,
      protocolVersion: 0,
      sessionId: context.gooseSessionId,
    });
  }
}
