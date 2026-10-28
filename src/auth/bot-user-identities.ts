import { normaliseNpub } from "../identity/npub-utils";

export interface BotUserIdentity { botNpub: string; displayName: string; active: boolean }

/** Public identity metadata only; profile custodians never supply role authority. */
export function listBotUserIdentities(
  keys: BotUserIdentity[],
  profiles: Array<{ botNpub: string; label: string; enabled: boolean; archived?: boolean }>,
): BotUserIdentity[] {
  const identities = new Map<string, BotUserIdentity>();
  for (const key of keys) {
    const npub = normaliseNpub(key.botNpub);
    if (npub) identities.set(npub, { ...key, botNpub: npub });
  }
  const profileGroups = new Map<string, typeof profiles>();
  for (const profile of profiles) {
    const npub = normaliseNpub(profile.botNpub);
    if (!npub) continue;
    profileGroups.set(npub, [...(profileGroups.get(npub) ?? []), profile]);
  }
  for (const [npub, group] of profileGroups) {
    const activeProfiles = group.filter((profile) => profile.enabled && !profile.archived);
    const key = identities.get(npub);
    identities.set(npub, { botNpub: npub,
      displayName: (activeProfiles[0] ?? group[0])!.label || key?.displayName || npub,
      active: activeProfiles.length > 0 && (key?.active ?? true) });
  }
  return [...identities.values()];
}

/** Preserve bot classification before key/profile metadata can be removed. */
export function classifyStoredBotUsers(
  store: { listUsers: () => Array<{ npub: string; normalizedNpub: string; roles: string[] }>;
    setRole: (npub: string, role: string, enabled: boolean) => unknown },
  bots: BotUserIdentity[],
): void {
  const known = new Set(bots.map((bot) => normaliseNpub(bot.botNpub)));
  for (const user of store.listUsers()) {
    if (known.has(normaliseNpub(user.normalizedNpub || user.npub)) && !user.roles.includes("bot")) {
      store.setRole(user.npub, "bot", true);
    }
  }
}
