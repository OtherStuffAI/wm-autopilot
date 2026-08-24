import { fileURLToPath } from "node:url";

import type { AdapterSessionContext } from "./agent-adapter";
import { AcpAdapter } from "./acp-adapter";
import { configureAdvertisedPiModel } from "./pi-acp-model-config";

const DEFAULT_PI_ACP_CLI = fileURLToPath(new URL("../../node_modules/.bin/pi-acp", import.meta.url));

export function buildPiAcpRuntimeEnv(context: AdapterSessionContext): Record<string, string> {
  const env = {
    ...(process.env as Record<string, string>),
    ...(context.env ?? {}),
  };
  const openRouterApiKey = context.piOpenRouterApiKey?.trim();
  if (openRouterApiKey) env.OPENROUTER_API_KEY = openRouterApiKey;
  const piCli = context.piCli?.trim() || env.PI_CLI?.trim();
  if (piCli) env.PI_ACP_PI_COMMAND = Bun.which(piCli) ?? piCli;
  return env;
}

export class PiAcpAdapter extends AcpAdapter {
  constructor(context: AdapterSessionContext) {
    const env = buildPiAcpRuntimeEnv(context);
    super(context, {
      agentName: "Pi",
      protocolVersion: 1,
      command: context.piAcpCli?.trim() || env.PI_ACP_CLI?.trim() || DEFAULT_PI_ACP_CLI,
      env,
      sessionId: context.piSessionId,
      cancelIsNotification: true,
      configureSession: async (client, sessionId, response) => {
        await configureAdvertisedPiModel(client, sessionId, response, context.model);
      },
    });
  }
}
