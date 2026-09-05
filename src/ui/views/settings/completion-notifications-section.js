export function createCompletionNotificationsSection({ soundController }) {
  const section = document.createElement("section");
  section.className = "wm-completion-notifications";
  section.dataset.testid = "completion-notifications-settings";

  const heading = document.createElement("h2");
  heading.textContent = "Session notifications";

  const description = document.createElement("p");
  description.className = "wm-settings__port-note";
  description.textContent = "Play a short ping when an open Autopilot browser detects that a session has finished.";

  const option = document.createElement("label");
  option.className = "wm-completion-notifications__option";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.testid = "completion-sound-enabled";
  checkbox.setAttribute("aria-label", "Play a sound when a session completes");

  const optionText = document.createElement("span");
  optionText.textContent = "Ping when a session completes";
  option.append(checkbox, optionText);

  const status = document.createElement("p");
  status.className = "wm-completion-notifications__status";
  status.dataset.testid = "completion-sound-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  void soundController.init().then(() => {
    checkbox.checked = soundController.isEnabled();
  }).catch((error) => {
    checkbox.disabled = true;
    status.textContent = error instanceof Error ? error.message : "Unable to load notification settings.";
  });

  checkbox.addEventListener("change", async () => {
    const enabled = checkbox.checked;
    checkbox.disabled = true;
    status.textContent = enabled ? "Enabling completion ping…" : "Disabling completion ping…";
    try {
      const previewPromise = enabled ? soundController.preview() : Promise.resolve();
      await Promise.all([soundController.setEnabled(enabled), previewPromise]);
      status.textContent = enabled ? "Completion ping enabled." : "Completion ping disabled.";
    } catch (error) {
      checkbox.checked = soundController.isEnabled();
      status.textContent = error instanceof Error ? error.message : "Unable to save notification setting.";
    } finally {
      checkbox.disabled = false;
    }
  });

  section.append(heading, description, option, status);
  return section;
}
