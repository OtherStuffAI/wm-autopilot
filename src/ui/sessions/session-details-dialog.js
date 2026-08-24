import { getSessionPosition, sortSessionsForTabs } from "./session-order.js";

function hasDialogSupport() {
  return typeof document !== "undefined" && typeof HTMLDialogElement !== "undefined";
}

function appendDialog(dialog) {
  document.body.append(dialog);
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function removeDialog(dialog) {
  dialog.remove();
}

function createField({ label, control }) {
  const field = document.createElement("label");
  field.className = "wm-dialog__field";

  const labelEl = document.createElement("span");
  labelEl.className = "wm-dialog__field-label";
  labelEl.textContent = label;

  control.setAttribute("aria-label", label);
  field.append(labelEl, control);
  return field;
}

function createCheckboxField({ label, description, control }) {
  const field = document.createElement("label");
  field.className = "wm-dialog__field wm-dialog__field--checkbox";

  const row = document.createElement("span");
  row.className = "wm-dialog__checkbox-row";

  const labelEl = document.createElement("span");
  labelEl.className = "wm-dialog__field-label";
  labelEl.textContent = label;

  control.setAttribute("aria-label", label);
  row.append(control, labelEl);
  field.append(row);

  if (description) {
    const descriptionEl = document.createElement("span");
    descriptionEl.className = "wm-dialog__field-description";
    descriptionEl.textContent = description;
    field.append(descriptionEl);
  }

  return field;
}

function createPositionSelect(session, sessions) {
  const ordered = sortSessionsForTabs(sessions);
  const currentPosition = getSessionPosition(session, ordered);
  const select = document.createElement("select");
  select.className = "wm-dialog__input";
  select.dataset.testid = "session-details-position";

  const total = Math.max(ordered.length, currentPosition);
  for (let index = 1; index <= total; index += 1) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = String(index);
    select.append(option);
  }
  select.value = String(currentPosition);
  return select;
}

export async function openSessionDetailsDialog({
  session,
  sessions,
  getSessionDisplayName,
} = {}) {
  const currentName =
    typeof session?.name === "string" && session.name.trim().length > 0
      ? session.name.trim()
      : getSessionDisplayName?.(session) ?? session?.id ?? "";

  if (!hasDialogSupport()) {
    const fallbackValue = typeof window !== "undefined" && typeof window.prompt === "function"
      ? window.prompt("Session Details", currentName)
      : null;
    return typeof fallbackValue === "string"
      ? { name: fallbackValue.trim(), position: getSessionPosition(session, sessions) }
      : null;
  }

  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "wm-dialog wm-dialog-prompt";
    dialog.dataset.testid = "session-details-dialog";
    dialog.setAttribute("aria-labelledby", "session-details-title");

    const form = document.createElement("form");
    form.method = "dialog";
    form.className = "wm-dialog__form";

    const header = document.createElement("header");
    header.className = "wm-dialog__header";

    const title = document.createElement("h2");
    title.id = "session-details-title";
    title.textContent = "Session Details";

    header.append(title);

    const body = document.createElement("section");
    body.className = "wm-dialog__body";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "wm-dialog__input";
    nameInput.value = currentName;
    nameInput.autocomplete = "off";
    nameInput.dataset.testid = "session-details-name";

    const positionSelect = createPositionSelect(session, sessions);
    const generateAudioInput = document.createElement("input");
    generateAudioInput.type = "checkbox";
    generateAudioInput.checked = Boolean(session?.metadata?.speechGenerateAudio);
    generateAudioInput.dataset.testid = "session-details-speech-generate-audio";

    const alwaysReadInput = document.createElement("input");
    alwaysReadInput.type = "checkbox";
    alwaysReadInput.checked = Boolean(session?.metadata?.speechAlwaysRead);
    alwaysReadInput.dataset.testid = "session-details-speech-always-read";

    const status = document.createElement("p");
    status.className = "wm-dialog__status";
    status.hidden = true;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    body.append(
      createField({ label: "Name", control: nameInput }),
      createField({ label: "Position", control: positionSelect }),
      createCheckboxField({
        label: "Generate audio responses",
        description: "Create spoken summary audio for new assistant responses in this session.",
        control: generateAudioInput,
      }),
      createCheckboxField({
        label: "Auto-read audio responses",
        description: "Automatically play generated audio when a new assistant response is ready.",
        control: alwaysReadInput,
      }),
      status,
    );

    const footer = document.createElement("footer");
    footer.className = "wm-dialog__menu";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "wm-button secondary";
    cancelButton.textContent = "Cancel";
    cancelButton.dataset.testid = "session-details-cancel";
    cancelButton.addEventListener("click", () => dialog.close("cancel"));

    const confirmButton = document.createElement("button");
    confirmButton.type = "submit";
    confirmButton.className = "wm-button";
    confirmButton.textContent = "Save";
    confirmButton.dataset.testid = "session-details-save";
    footer.append(cancelButton, confirmButton);

    form.append(header, body, footer);
    dialog.append(form);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!nameInput.value.trim()) {
        status.hidden = false;
        status.textContent = "Session name cannot be empty.";
        nameInput.focus();
        return;
      }
      dialog.close("confirm");
    });

    dialog.addEventListener(
      "close",
      () => {
        const result = dialog.returnValue === "confirm"
          ? {
              name: nameInput.value.trim(),
              position: Number(positionSelect.value),
              speechGenerateAudio: generateAudioInput.checked,
              speechAlwaysRead: alwaysReadInput.checked,
            }
          : null;
        removeDialog(dialog);
        resolve(result);
      },
      { once: true },
    );

    appendDialog(dialog);
    queueMicrotask(() => {
      nameInput.focus();
      nameInput.select();
    });
  });
}
