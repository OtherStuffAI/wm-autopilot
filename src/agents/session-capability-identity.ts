export interface SessionCapabilityBotRecord {
  botNpub: string;
  userNpub: string;
}

export interface SessionCapabilityAgentProfile {
  botNpub: string;
  workingDirectory: string;
  enabled: boolean;
  archived?: boolean;
}

export function resolveSessionCapabilityBotRecord<T extends SessionCapabilityBotRecord>(input: {
  ownerNpub: string;
  requestedBotNpub?: string | null;
  workingDirectory?: string | null;
  profiles: SessionCapabilityAgentProfile[];
  getActiveByBotNpub: (botNpub: string) => T | null;
  getActiveForOwner: (ownerNpub: string) => T | null;
}): T | null {
  const requestedBotNpub = input.requestedBotNpub?.trim() ?? "";
  if (requestedBotNpub) {
    const requested = input.getActiveByBotNpub(requestedBotNpub);
    if (requested) return requested;
  }

  const workingDirectory = input.workingDirectory?.trim() ?? "";
  if (workingDirectory) {
    const matchingProfiles = input.profiles.filter((profile) =>
      profile.enabled
      && profile.archived !== true
      && profile.workingDirectory === workingDirectory,
    );
    if (matchingProfiles.length === 1) {
      const matched = input.getActiveByBotNpub(matchingProfiles[0]!.botNpub);
      if (matched) return matched;
    }
  }

  return requestedBotNpub ? null : input.getActiveForOwner(input.ownerNpub);
}
