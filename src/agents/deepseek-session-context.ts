import { instanceSettingsService } from "../settings/instance-settings-service";
import type { AdapterSessionContext } from "./agent-adapter";

/** Resolve secrets only at adapter creation; never persist them in session metadata. */
export function buildDeepSeekAdapterContext(session: {
  agent: string;
  command?: string[];
  metadata: { nativeAgentSession?: { agent: string; sessionId: string } };
}): Partial<AdapterSessionContext> {
  if (session.agent !== "deepseek") return {};
  const separator = session.command?.indexOf("--") ?? -1;
  const configuredCli = separator >= 0 ? session.command?.[separator + 1] : undefined;
  return {
    deepseekAcpCli: instanceSettingsService.get("agents.deepseek_acp_cli") || configuredCli,
    deepseekApiKey: instanceSettingsService.get("integrations.deepseek_api_key") || undefined,
    deepseekSessionId: session.metadata.nativeAgentSession?.agent === "deepseek"
      ? session.metadata.nativeAgentSession.sessionId : undefined,
  };
}
