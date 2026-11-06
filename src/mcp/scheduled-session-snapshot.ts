import type { SessionSnapshot } from "../agents/process-manager";

/** Minimal exact-caller state for scheduled binding; never enumerate owner sessions. */
export function scheduledSessionSnapshot(session: SessionSnapshot) {
  if (session.origin?.type !== "scheduler") return null;
  const keys = ["agentChatBotNpub", "ownerNpub", "bindingType", "bindingId", "flightdeckSubscriptionId",
    "flightdeckTowerServiceNpub", "flightdeckBackendConnectionId", "flightdeckWorkspaceId",
    "flightdeckAgentNpub", "flightdeckScopeId", "flightdeckChannelId", "flightdeckThreadId"] as const;
  const metadata = Object.fromEntries(keys.filter(key => session.metadata?.[key] !== undefined)
    .map(key => [key, session.metadata![key]]));
  return { id: session.id, npub: session.npub, status: session.status, agent: session.agent,
    workingDirectory: session.workingDirectory, origin: session.origin, metadata };
}
