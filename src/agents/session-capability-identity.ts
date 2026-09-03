export interface SessionCapabilityBotRecord {
  botNpub: string;
  userNpub: string;
}

export interface SessionCapabilityAgentProfile {
  profileId: string;
  botNpub: string;
  enabled: boolean;
  archived?: boolean;
}

export function resolveSessionCapabilityBotRecord<T extends SessionCapabilityBotRecord>(input: {
  ownerNpub: string;
  requestedProfileId?: string | null;
  requestedBotNpub?: string | null;
  profiles: SessionCapabilityAgentProfile[];
  defaultProfile?: SessionCapabilityAgentProfile | null;
  allowDefaultFallbackForMissingRequestedProfile?: boolean;
  getActiveByBotNpub: (botNpub: string) => T | null;
}): { record: T; profileId: string } | null {
  const requestedProfileId = input.requestedProfileId?.trim() ?? "";
  const requestedBotNpub = input.requestedBotNpub?.trim() ?? "";
  const activeProfile = (profile: SessionCapabilityAgentProfile | null | undefined) => (
    profile && profile.enabled && profile.archived !== true ? profile : null
  );
  const profileById = requestedProfileId
    ? activeProfile(input.profiles.find((profile) => profile.profileId === requestedProfileId))
    : null;
  const defaultProfile = activeProfile(input.defaultProfile);
  const resolveDefault = () => {
    if (!input.allowDefaultFallbackForMissingRequestedProfile || !defaultProfile) return null;
    const record = input.getActiveByBotNpub(defaultProfile.botNpub);
    return record ? { record, profileId: defaultProfile.profileId } : null;
  };

  if (requestedBotNpub) {
    const requested = input.getActiveByBotNpub(requestedBotNpub);
    if (requested) {
      const matchingProfile = profileById
        ?? activeProfile(input.profiles.find((profile) => profile.botNpub === requestedBotNpub));
      if (!matchingProfile || matchingProfile.botNpub !== requestedBotNpub) return resolveDefault();
      return { record: requested, profileId: matchingProfile.profileId };
    }
    if (!profileById) return resolveDefault();
    const rotated = input.getActiveByBotNpub(profileById.botNpub);
    return rotated ? { record: rotated, profileId: profileById.profileId } : resolveDefault();
  }

  if (requestedProfileId) {
    if (!profileById) return resolveDefault();
    const requested = input.getActiveByBotNpub(profileById.botNpub);
    return requested ? { record: requested, profileId: profileById.profileId } : resolveDefault();
  }

  if (!defaultProfile) return null;
  const defaultRecord = input.getActiveByBotNpub(defaultProfile.botNpub);
  return defaultRecord ? { record: defaultRecord, profileId: defaultProfile.profileId } : null;
}
