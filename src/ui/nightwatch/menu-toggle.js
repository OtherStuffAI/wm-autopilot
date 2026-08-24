/**
 * Night Watch Menu Toggle
 *
 * Adds a Night Watch on/off toggle to the session menu.
 * The button text updates live after toggling and after the initial fetch.
 */

import {
  ensureNightWatchSessionToggleLoaded,
  getNightWatchToggleLabel,
  toggleNightWatchForSession,
} from "./session-toggle.js";

export function addNightWatchToggle({
  sessionId,
  sessionName,
  sessionMetadata,
  addCommand,
  state,
  showToast,
  isFeatureEnabled,
}) {
  if (!isFeatureEnabled("nightwatch_enabled")) return;

  const toggleMap = state.nightwatch.sessionToggles;
  const cached = toggleMap.get(sessionId);
  const initiallyOn = cached?.enabled ?? false;

  const btn = addCommand(getNightWatchToggleLabel(initiallyOn), async () => {
    try {
      const result = await toggleNightWatchForSession({
        sessionId,
        sessionName,
        sessionMetadata,
        state,
        showToast,
      });
      if (result) {
        btn.textContent = getNightWatchToggleLabel(Boolean(result.enabled));
      }
    } catch (err) {
      showToast(`Night Watch toggle failed: ${err.message}`, { type: "error" });
    }
  });

  // Lazy-load session state if not cached, update button when resolved
  void ensureNightWatchSessionToggleLoaded({
    sessionId,
    state,
    onResolved: (data) => {
      if (data?.enabled) {
        btn.textContent = getNightWatchToggleLabel(true);
      }
    },
  });
}
