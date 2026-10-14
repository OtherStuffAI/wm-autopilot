import { getCachedIdentityProfile } from "../identity/profile-cache.js";
import { applyAvatarImage } from "../utils/avatar.js";

function readableLabel(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createAdminUserIdentity({ user, avatar, abbreviateNpub, onLabel }) {
  const npub = user.normalizedNpub || user.npub || "";
  const nickname = readableLabel(user.nickname);
  const alias = readableLabel(user.alias);
  const name = document.createElement("strong");
  name.dataset.testid = "admin-user-name";

  function showProfile(profile) {
    const label = nickname || readableLabel(profile?.name) || alias || "Unnamed user";
    name.textContent = label;
    applyAvatarImage(avatar, profile?.pictureUrl || user.pictureUrl, label);
    avatar.setAttribute("aria-hidden", "true");
    onLabel(label);
  }
  showProfile(null);

  const identity = document.createElement("details");
  identity.className = "wm-admin-users__identity";
  identity.dataset.testid = "admin-user-identity";
  const summary = document.createElement("summary");
  summary.textContent = npub ? `Identity · ${abbreviateNpub(npub)}` : "Identity missing";
  summary.setAttribute("aria-label", "Inspect full user identity");
  const meta = document.createElement("div");
  meta.className = "wm-admin-users__meta";
  const publicKey = document.createElement("code");
  publicKey.textContent = npub;
  publicKey.dataset.testid = "admin-user-npub";
  meta.append(publicKey);
  if (alias) {
    const aliasText = document.createElement("p");
    aliasText.textContent = `Alias: ${alias}`;
    meta.append(aliasText);
  }
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "wm-button secondary";
  copy.textContent = "Copy npub";
  copy.setAttribute("aria-label", "Copy full user npub");
  copy.dataset.testid = "admin-user-copy-npub";
  copy.disabled = !npub;
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(npub);
      status.textContent = "Identity copied.";
    } catch {
      status.textContent = "Could not copy. Select the identity above to copy it manually.";
    }
  });
  meta.append(copy, status);
  identity.append(summary, meta);

  // Read the existing Dexie profile cache; never fetch a profile for rendering.
  void getCachedIdentityProfile(npub).then((profile) => {
    if (profile && name.isConnected) showProfile(profile);
  }).catch(() => {
    summary.title = "Cached profile unavailable; showing the registered user label.";
  });
  return { name, identity };
}
