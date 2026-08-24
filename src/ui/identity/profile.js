import { cacheIdentityProfile } from "./profile-cache.js";

export const fetchIdentityProfile = async ({ npub, force = false } = {}) => {
  const params = new URLSearchParams();
  if (typeof npub === "string" && npub.trim().length > 0) {
    params.set("npub", npub.trim());
  }
  if (force) {
    params.set("refresh", "1");
  }
  const response = await fetch(`/api/identity/profile?${params.toString()}`, { credentials: "include" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof payload.error === "string"
        ? payload.error
        : response.statusText || "Profile lookup failed";
    throw new Error(message);
  }
  const profile = payload ?? {};
  await cacheIdentityProfile(profile);
  return profile;
};

export const fetchAdminUserProfile = async ({ npub, force = false } = {}) => {
  if (!npub || typeof npub !== "string") {
    throw new Error("npub is required");
  }
  const response = await fetch("/api/admin/users/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ npub, refresh: force }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof payload.error === "string"
        ? payload.error
        : response.statusText || "Profile lookup failed";
    throw new Error(message);
  }
  return payload ?? {};
};
