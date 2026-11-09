/** Resolve the server-owned identity fields accepted when issuing a capability. */
export function sessionIdentityBinding(metadata?: { agentChatAgentId?: unknown; agentProfileId?: unknown; agentChatBotNpub?: unknown; flightdeckAgentNpub?: unknown } | null) {
  return {
    profileId: typeof metadata?.agentChatAgentId === "string"
      ? metadata.agentChatAgentId
      : typeof metadata?.agentProfileId === "string" ? metadata.agentProfileId : null,
    botNpub: typeof metadata?.agentChatBotNpub === "string"
      ? metadata.agentChatBotNpub
      : typeof metadata?.flightdeckAgentNpub === "string" ? metadata.flightdeckAgentNpub : null,
  };
}
