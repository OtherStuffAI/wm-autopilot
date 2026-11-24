import { instanceSettingsService } from "../settings/instance-settings-service";
import type { AdapterSessionContext } from "./agent-adapter";

export function buildAntigravityAdapterContext(session: {
  agent: string;
  command?: string[];
  metadata: { nativeAgentSession?: { agent: string; sessionId: string } };
}): Partial<AdapterSessionContext> {
  if (session.agent !== "antigravity") return {};
  const separator = session.command?.indexOf("--") ?? -1;
  return {
    antigravityCli: instanceSettingsService.get("agents.antigravity_cli")
      || (separator >= 0 ? session.command?.[separator + 1] : undefined),
    antigravitySessionId: session.metadata.nativeAgentSession?.agent === "antigravity"
      ? session.metadata.nativeAgentSession.sessionId : undefined,
  };
}
