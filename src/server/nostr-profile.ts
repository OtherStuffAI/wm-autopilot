import { normaliseNpub } from "../identity/npub-utils";
import { fetchNewestNostrProfile } from '../identity/nostr-profile-metadata';
import { identityUserStore } from "../storage/identity-user-store";

const DEFAULT_PROFILE_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "ws://127.0.0.1:4869",
];

const sanitisePictureUrl = (value: string | null | undefined): string | null => {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
  } catch {
    // ignore invalid URLs
  }
  return null;
};

export const resolveAndCacheNostrProfile = async (
  npub: string,
  options: { force?: boolean; relays?: string[] } = {},
): Promise<{ pictureUrl: string | null; name: string | null; source: "cache" | "fetched" }> => {
  const normalized = normaliseNpub(npub);
  if (!normalized) {
    throw new Error("A valid npub is required");
  }
  const relays =
    Array.isArray(options.relays) && options.relays.length > 0 ? options.relays : DEFAULT_PROFILE_RELAYS;
  const existing = identityUserStore.getByNormalized(normalized);
  if ((existing?.pictureUrl || existing?.profileName) && !options.force) {
    return { pictureUrl: existing.pictureUrl, name: existing.profileName, source: "cache" };
  }

  let metadata;
  try {
    metadata = await fetchNewestNostrProfile({ npub, relays });
  } catch (error) {
    console.warn("[nostr] profile lookup failed:", error instanceof Error ? error.message : String(error));
    metadata = null;
  }
  if (!metadata) {
    if (!existing) {
      identityUserStore.touch(npub);
    }
    return { pictureUrl: existing?.pictureUrl ?? null, name: existing?.profileName ?? null, source: "cache" };
  }

  const pictureUrl = sanitisePictureUrl(metadata.profile.picture);
  const name = metadata.profile.name;
  if (pictureUrl) identityUserStore.setPictureUrl(npub, pictureUrl);
  if (name) identityUserStore.setProfileName(npub, name);
  if (!existing) {
    identityUserStore.touch(npub);
  }
  const updated = identityUserStore.getByNormalized(normalized);

  return {
    pictureUrl: pictureUrl ?? updated?.pictureUrl ?? null,
    name: name ?? updated?.alias ?? null,
    source: "fetched",
  };
};
