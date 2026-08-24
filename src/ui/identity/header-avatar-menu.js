import { applyAvatarImage } from "../utils/avatar.js";
import { getIdentityDisplayName } from "./profile-display.js";

export function initHeaderAvatarMenu({ button, state, identityEventNames = [] }) {
  const avatar = button?.querySelector("#menu-toggle-avatar");
  if (!(button instanceof HTMLElement) || !(avatar instanceof HTMLElement)) {
    return { update: () => {}, destroy: () => {} };
  }

  function update() {
    const identity = state.identity ?? {};
    const displayName = getIdentityDisplayName(identity);
    applyAvatarImage(avatar, identity.picture, displayName);
    button.title = displayName === "?" ? "Open account menu" : `Open account menu for ${displayName}`;
  }

  const trackedEvents = ["wingman:identity-ui-state", ...identityEventNames];
  trackedEvents.forEach((eventName) => {
    window.addEventListener(eventName, update);
  });

  update();

  return {
    update,
    destroy() {
      trackedEvents.forEach((eventName) => {
        window.removeEventListener(eventName, update);
      });
    },
  };
}
