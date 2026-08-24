import Dexie from "/vendor/dexie/dexie.mjs";

export const identityProfileDb = new Dexie("WingmanIdentityProfiles");

identityProfileDb.version(1).stores({
  profiles: "npub, updatedAt",
});

export async function getCachedIdentityProfile(npub) {
  if (typeof npub !== "string" || npub.trim().length === 0) return null;
  return identityProfileDb.profiles.get(npub.trim());
}

export async function cacheIdentityProfile(profile) {
  if (!profile || typeof profile.npub !== "string" || profile.npub.trim().length === 0) return;
  await identityProfileDb.profiles.put({
    npub: profile.npub.trim(),
    name: typeof profile.name === "string" && profile.name.trim().length > 0 ? profile.name.trim() : null,
    pictureUrl: typeof profile.pictureUrl === "string" && profile.pictureUrl.trim().length > 0
      ? profile.pictureUrl.trim()
      : null,
    updatedAt: Date.now(),
  });
}
