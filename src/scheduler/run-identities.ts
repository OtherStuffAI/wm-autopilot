import type { BotKeyStore } from "../identity/bot-key-store";

/** Only active keys owned by the scheduler owner are selectable. */
export function listSchedulerRunIdentities(
  ownerNpub: string,
  keys: Pick<BotKeyStore, "listActiveKeysForUser">,
  profiles: Array<{ botNpub: string; label: string; enabled: boolean; archived?: boolean }>,
) {
  const activeProfiles = profiles.filter((profile) => profile.enabled && !profile.archived);
  return keys.listActiveKeysForUser(ownerNpub).flatMap((key) => {
    const profile = activeProfiles.find((entry) => entry.botNpub === key.botNpub);
    return profile ? [{ botNpub: key.botNpub, name: profile.label || key.displayName }] : [];
  });
}
