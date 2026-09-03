import type { ProcessManager, SessionSnapshot } from "./process-manager";
import {
  resolveSessionCapabilityBotRecord,
  type SessionCapabilityAgentProfile,
  type SessionCapabilityBotRecord,
} from "./session-capability-identity";

type SessionCapabilityBindingManager = Pick<
  ProcessManager,
  "getSession" | "bindSessionCapabilityIdentity"
>;

interface AgentProfileIdentitySource {
  agentId: string;
  botNpub: string;
  enabled: boolean;
  archived?: boolean;
}

export function resolveSessionCapabilityProfileScope(input: {
  ownerNpub: string;
  sharedAgentDispatch: boolean;
  adminNpub?: string | null;
  metadata?: { resumedFromWingmanSessionId?: unknown } | null;
}): { profileManagerNpub: string; allowDefaultFallbackForMissingRequestedProfile: boolean } {
  const adminNpub = input.adminNpub?.trim() ?? "";
  const useSharedProfileManager = input.sharedAgentDispatch && Boolean(adminNpub);
  return {
    profileManagerNpub: useSharedProfileManager ? adminNpub : input.ownerNpub,
    allowDefaultFallbackForMissingRequestedProfile: Boolean(
      useSharedProfileManager && input.metadata?.resumedFromWingmanSessionId,
    ),
  };
}

export function buildSessionCapabilityProfileContext(
  profiles: AgentProfileIdentitySource[],
  defaultProfile: AgentProfileIdentitySource | null,
): {
  profiles: SessionCapabilityAgentProfile[];
  defaultProfile: SessionCapabilityAgentProfile | null;
} {
  const toCapabilityProfile = (profile: AgentProfileIdentitySource): SessionCapabilityAgentProfile => ({
    profileId: profile.agentId,
    botNpub: profile.botNpub,
    enabled: profile.enabled,
    archived: profile.archived,
  });
  return {
    profiles: profiles.map(toCapabilityProfile),
    defaultProfile: defaultProfile ? toCapabilityProfile(defaultProfile) : null,
  };
}

export function resolveAndBindSessionCapabilityBotRecord<
  T extends SessionCapabilityBotRecord,
>(input: {
  manager: SessionCapabilityBindingManager;
  sessionId: string;
  ownerNpub: string;
  profileManagerNpub?: string;
  requestedProfileId?: string | null;
  requestedBotNpub?: string | null;
  profiles: SessionCapabilityAgentProfile[];
  defaultProfile?: SessionCapabilityAgentProfile | null;
  allowDefaultFallbackForMissingRequestedProfile?: boolean;
  getActiveByBotNpub: (botNpub: string) => T | null;
}): { record: T; profileId: string; session: SessionSnapshot } {
  const session = input.manager.getSession(input.sessionId);
  if (!session || session.npub !== input.ownerNpub) {
    throw new Error("Cannot bind capability identity for an unknown or mismatched session");
  }

  const resolved = resolveSessionCapabilityBotRecord({
    ownerNpub: input.ownerNpub,
    requestedProfileId: input.requestedProfileId,
    requestedBotNpub: input.requestedBotNpub,
    profiles: input.profiles,
    defaultProfile: input.defaultProfile,
    allowDefaultFallbackForMissingRequestedProfile: input.allowDefaultFallbackForMissingRequestedProfile,
    getActiveByBotNpub: input.getActiveByBotNpub,
  });
  if (!resolved) throw new Error("Session has no active bound or default agent profile");
  const { record, profileId } = resolved;
  if (record.userNpub !== (input.profileManagerNpub ?? input.ownerNpub)) {
    throw new Error("Selected agent identity is not managed by the active profile manager");
  }

  const boundSession = input.manager.bindSessionCapabilityIdentity(input.sessionId, record.botNpub, profileId);
  if (!boundSession) throw new Error("Cannot bind capability identity for an inactive session");

  return { record, profileId, session: boundSession };
}
