export function getIdentityDisplayName(identity) {
  const profileName = typeof identity?.profileName === "string" && identity.profileName.trim().length > 0
    ? identity.profileName.trim()
    : null;
  const alias = typeof identity?.alias === "string" && identity.alias.trim().length > 0
    ? identity.alias.trim()
    : null;
  const npub = typeof identity?.npub === "string" ? identity.npub : "";

  if (profileName) return profileName;
  if (alias) return alias;
  if (!npub) return "?";
  return npub.length > 20 ? `${npub.slice(0, 10)}\u2026${npub.slice(-4)}` : npub;
}
