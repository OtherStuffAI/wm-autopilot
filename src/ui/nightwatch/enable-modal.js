const MODAL_STYLE_ID = "wm-nightwatch-enable-modal-styles";

function buildDefaultNightWatchGoal(sessionName) {
  const label = typeof sessionName === "string" && sessionName.trim().length > 0
    ? sessionName.trim()
    : "this session";
  return [
    `I would like you to reflect and consider whether you have adequately completed the work in ${label}.`,
    'If you believe the work is complete and any required handoff is done, then set nextAction to stop using the Wingman session metadata CLI (`bun clis/sessions.ts metadata-update --next-action stop`).',
    'Otherwise continue working toward completion.',
  ].join(' ');
}

function ensureNightWatchEnableModalStyles() {
  if (document.getElementById(MODAL_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = MODAL_STYLE_ID;
  style.textContent = `
    .wm-nightwatch-enable-modal {
      width: min(42rem, 92vw);
      max-width: 42rem;
    }

    .wm-nightwatch-enable-modal__form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      min-width: 0;
    }

    .wm-nightwatch-enable-modal__body {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .wm-nightwatch-enable-modal__tabs {
      display: inline-flex;
      align-self: flex-start;
      gap: 0.4rem;
      padding: 0.25rem;
      border: 1px solid var(--border-primary, rgba(148, 163, 184, 0.3));
      border-radius: 999px;
      background: var(--bg-secondary, rgba(15, 23, 42, 0.04));
    }

    .wm-nightwatch-enable-modal__tab {
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: inherit;
      padding: 0.45rem 0.9rem;
      font: inherit;
      cursor: pointer;
    }

    .wm-nightwatch-enable-modal__tab[aria-selected="true"] {
      background: var(--accent-primary, #2563eb);
      color: var(--accent-on-primary, #fff);
    }

    .wm-nightwatch-enable-modal__panel[hidden] {
      display: none;
    }

    .wm-nightwatch-enable-modal__hint {
      margin: 0.35rem 0 0;
      opacity: 0.75;
      font-size: 0.9rem;
      line-height: 1.4;
    }

    .wm-nightwatch-enable-modal__grid {
      display: grid;
      gap: 1rem;
      grid-template-columns: minmax(0, 1fr) 12rem;
      align-items: start;
    }

    .wm-nightwatch-enable-modal__status {
      min-height: 1.25rem;
      margin: 0;
      font-size: 0.9rem;
      color: #fca5a5;
    }

    .wm-nightwatch-enable-modal__footer {
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
    }

    @media (max-width: 640px) {
      .wm-nightwatch-enable-modal__grid {
        grid-template-columns: minmax(0, 1fr);
      }

      .wm-nightwatch-enable-modal__footer {
        flex-direction: column-reverse;
      }

      .wm-nightwatch-enable-modal__footer button {
        width: 100%;
      }
    }
  `;

  document.head.append(style);
}

export function openNightWatchEnableModal({
  sessionName,
  prompt,
  intervalMinutes,
  minIntervalMinutes,
  maxIntervalMinutes,
  maxCycles,
  maxCycleOptions,
  goal,
  nextAction,
  nextActionTemplate,
}) {
  ensureNightWatchEnableModalStyles();
  const normalizedGoal = typeof goal === "string" && goal.trim().length > 0
    ? goal.trim()
    : buildDefaultNightWatchGoal(sessionName);
  const normalizedNextAction = typeof nextAction === "string" && nextAction.trim().length > 0
    ? nextAction.trim()
    : "reflect";

  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "wm-nightwatch-enable-modal";
    dialog.setAttribute("aria-labelledby", "wm-nightwatch-enable-title");
    dialog.dataset.testid = "nightwatch-enable-modal";

    const form = document.createElement("form");
    form.method = "dialog";
    form.className = "wm-nightwatch-enable-modal__form";

    const header = document.createElement("header");
    header.className = "wm-dialog__header";

    const title = document.createElement("h2");
    title.id = "wm-nightwatch-enable-title";
    title.textContent = "Enable Night Watch";

    const subtitle = document.createElement("p");
    subtitle.className = "wm-dialog__subtitle";
    subtitle.textContent = sessionName
      ? `Configure the check-in prompt for ${sessionName}.`
      : "Configure the check-in prompt for this session.";

    header.append(title, subtitle);

    const body = document.createElement("section");
    body.className = "wm-nightwatch-enable-modal__body";

    const tabList = document.createElement("div");
    tabList.className = "wm-nightwatch-enable-modal__tabs";
    tabList.setAttribute("role", "tablist");
    tabList.setAttribute("aria-label", "Night Watch settings");

    const timerTab = document.createElement("button");
    timerTab.type = "button";
    timerTab.className = "wm-nightwatch-enable-modal__tab";
    timerTab.setAttribute("role", "tab");
    timerTab.setAttribute("aria-selected", "false");
    timerTab.setAttribute("aria-controls", "wm-nightwatch-timer-panel");
    timerTab.id = "wm-nightwatch-timer-tab";
    timerTab.textContent = "Timer";

    const hookTab = document.createElement("button");
    hookTab.type = "button";
    hookTab.className = "wm-nightwatch-enable-modal__tab";
    hookTab.setAttribute("role", "tab");
    hookTab.setAttribute("aria-selected", "true");
    hookTab.setAttribute("aria-controls", "wm-nightwatch-hook-panel");
    hookTab.id = "wm-nightwatch-hook-tab";
    hookTab.textContent = "Hook";

    tabList.append(timerTab, hookTab);

    const timerPanel = document.createElement("section");
    timerPanel.className = "wm-nightwatch-enable-modal__panel";
    timerPanel.id = "wm-nightwatch-timer-panel";
    timerPanel.setAttribute("role", "tabpanel");
    timerPanel.setAttribute("aria-labelledby", timerTab.id);
    timerPanel.hidden = true;

    const hookPanel = document.createElement("section");
    hookPanel.className = "wm-nightwatch-enable-modal__panel";
    hookPanel.id = "wm-nightwatch-hook-panel";
    hookPanel.setAttribute("role", "tabpanel");
    hookPanel.setAttribute("aria-labelledby", hookTab.id);

    const metadataFields = document.createElement("div");
    metadataFields.style.display = "flex";
    metadataFields.style.flexDirection = "column";
    metadataFields.style.gap = "1rem";

    const goalField = document.createElement("label");
    goalField.className = "wm-dialog__field";
    goalField.textContent = "Goal";

    const goalInput = document.createElement("textarea");
    goalInput.rows = 3;
    goalInput.value = normalizedGoal;
    goalInput.spellcheck = false;
    goalInput.setAttribute("aria-label", "Session goal");
    goalInput.setAttribute("data-testid", "nightwatch-goal-input");

    const goalHint = document.createElement("p");
    goalHint.className = "wm-nightwatch-enable-modal__hint";
    goalHint.textContent = "Optional goal used by Night Watch reflection hooks.";

    goalField.append(goalInput, goalHint);

    const hookField = document.createElement("label");
    hookField.className = "wm-dialog__field";
    hookField.textContent = "Next Action Hook";

    const hookSelect = document.createElement("select");
    hookSelect.setAttribute("aria-label", "Night Watch next action hook");
    hookSelect.setAttribute("data-testid", "nightwatch-next-action-select");
    [
      ["", "None"],
      ["reflect", "Reflect"],
      ["stop", "Stop"],
      ["restart", "Restart"],
    ].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      if (normalizedNextAction === value) {
        option.selected = true;
      }
      hookSelect.append(option);
    });

    const hookHint = document.createElement("p");
    hookHint.className = "wm-nightwatch-enable-modal__hint";
    hookHint.textContent = "What Night Watch should do when the timer fires for this session.";

    hookField.append(hookSelect, hookHint);

    const templateField = document.createElement("label");
    templateField.className = "wm-dialog__field";
    templateField.textContent = "Reflection Template";

    const templateInput = document.createElement("textarea");
    templateInput.rows = 4;
    templateInput.value = typeof nextActionTemplate === "string" ? nextActionTemplate : "";
    templateInput.spellcheck = false;
    templateInput.placeholder = "Optional template for reflect hooks";
    templateInput.setAttribute("aria-label", "Night Watch reflection template");
    templateInput.setAttribute("data-testid", "nightwatch-next-action-template-input");

    const templateHint = document.createElement("p");
    templateHint.className = "wm-nightwatch-enable-modal__hint";
    templateHint.textContent =
      "Supports {{goal}}, {{nextActionPayload}}, {{sessionName}}, and {{workingDirectory}}.";

    templateField.append(templateInput, templateHint);
    metadataFields.append(goalField, hookField, templateField);
    hookPanel.append(metadataFields);

    const grid = document.createElement("div");
    grid.className = "wm-nightwatch-enable-modal__grid";

    const promptField = document.createElement("label");
    promptField.className = "wm-dialog__field";
    promptField.textContent = "Prompt and instructions";

    const promptInput = document.createElement("textarea");
    promptInput.rows = 6;
    promptInput.value = prompt;
    promptInput.required = true;
    promptInput.spellcheck = false;
    promptInput.setAttribute("aria-label", "Night Watch prompt and instructions");
    promptInput.setAttribute("data-testid", "nightwatch-prompt-input");

    const promptHint = document.createElement("p");
    promptHint.className = "wm-nightwatch-enable-modal__hint";
    promptHint.textContent =
      "This exact message is sent to the agent each time the timer fires.";

    promptField.append(promptInput, promptHint);

    const timingFields = document.createElement("div");
    timingFields.style.display = "flex";
    timingFields.style.flexDirection = "column";
    timingFields.style.gap = "1rem";

    const intervalField = document.createElement("label");
    intervalField.className = "wm-dialog__field";
    intervalField.textContent = "How Often";

    const intervalInput = document.createElement("input");
    intervalInput.type = "number";
    intervalInput.min = String(minIntervalMinutes);
    intervalInput.max = String(maxIntervalMinutes);
    intervalInput.step = "1";
    intervalInput.value = String(intervalMinutes);
    intervalInput.required = true;
    intervalInput.setAttribute("aria-label", "Night Watch timer in minutes");
    intervalInput.setAttribute("data-testid", "nightwatch-interval-input");

    const intervalHint = document.createElement("p");
    intervalHint.className = "wm-nightwatch-enable-modal__hint";
    intervalHint.textContent = `Choose a timer between ${minIntervalMinutes} and ${maxIntervalMinutes} minutes.`;

    intervalField.append(intervalInput, intervalHint);

    const maxTurnsField = document.createElement("label");
    maxTurnsField.className = "wm-dialog__field";
    maxTurnsField.textContent = "Max Turns";

    const maxTurnsInput = document.createElement("select");
    maxTurnsInput.required = true;
    maxTurnsInput.setAttribute("aria-label", "Night Watch maximum turns");
    maxTurnsInput.setAttribute("data-testid", "nightwatch-max-cycles-input");

    const cycleOptions = Array.isArray(maxCycleOptions) && maxCycleOptions.length > 0
      ? maxCycleOptions
      : [6, 21, 256];
    const normalizedMaxCycles = Number.isFinite(Number(maxCycles)) && Number(maxCycles) > 0
      ? Math.trunc(Number(maxCycles))
      : cycleOptions[0];
    const uniqueCycleOptions = Array.from(new Set([...cycleOptions, normalizedMaxCycles]))
      .filter((value) => Number.isFinite(Number(value)) && Number(value) > 0)
      .map((value) => Math.trunc(Number(value)))
      .sort((a, b) => a - b);

    uniqueCycleOptions.forEach((value) => {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(value);
      if (value === normalizedMaxCycles) {
        option.selected = true;
      }
      maxTurnsInput.append(option);
    });

    const maxTurnsHint = document.createElement("p");
    maxTurnsHint.className = "wm-nightwatch-enable-modal__hint";
    maxTurnsHint.textContent = "Stop Night Watch automatically after this many check-ins.";

    maxTurnsField.append(maxTurnsInput, maxTurnsHint);
    timingFields.append(intervalField, maxTurnsField);

    grid.append(promptField, timingFields);
    timerPanel.append(grid);
    body.append(tabList, timerPanel, hookPanel);

    const setActiveTab = (tabName) => {
      const timerActive = tabName !== "hook";
      timerTab.setAttribute("aria-selected", timerActive ? "true" : "false");
      hookTab.setAttribute("aria-selected", timerActive ? "false" : "true");
      timerPanel.hidden = !timerActive;
      hookPanel.hidden = timerActive;
    };

    timerTab.addEventListener("click", () => setActiveTab("timer"));
    hookTab.addEventListener("click", () => setActiveTab("hook"));

    const status = document.createElement("p");
    status.className = "wm-nightwatch-enable-modal__status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("data-testid", "nightwatch-enable-status");
    body.append(status);

    const footer = document.createElement("footer");
    footer.className = "wm-nightwatch-enable-modal__footer";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "wm-btn wm-btn--sm";
    cancelButton.textContent = "Cancel";
    cancelButton.setAttribute("aria-label", "Cancel enabling Night Watch");
    cancelButton.addEventListener("click", () => dialog.close("cancel"));

    const confirmButton = document.createElement("button");
    confirmButton.type = "submit";
    confirmButton.className = "wm-btn wm-btn--sm";
    confirmButton.textContent = "Enable";
    confirmButton.setAttribute("aria-label", "Enable Night Watch");
    confirmButton.setAttribute("data-testid", "nightwatch-enable-confirm");

    footer.append(cancelButton, confirmButton);

    form.append(header, body, footer);
    dialog.append(form);

    const cleanup = () => {
      dialog.remove();
    };

    form.addEventListener("submit", (event) => {
      event.preventDefault();

      const nextPrompt = promptInput.value.trim();
      if (!nextPrompt) {
        status.textContent = "Prompt cannot be empty.";
        promptInput.focus();
        return;
      }

      const nextGoal = goalInput.value.trim();
      const nextHook = hookSelect.value.trim();
      if (nextHook && !nextGoal) {
        status.textContent = "Goal cannot be empty when a hook is enabled.";
        setActiveTab("hook");
        goalInput.focus();
        return;
      }

      const nextInterval = Number(intervalInput.value);
      if (
        !Number.isFinite(nextInterval) ||
        nextInterval < minIntervalMinutes ||
        nextInterval > maxIntervalMinutes
      ) {
        status.textContent = `Timer must be between ${minIntervalMinutes} and ${maxIntervalMinutes} minutes.`;
        intervalInput.focus();
        return;
      }

      dialog.close("confirm");
      resolve({
        prompt: nextPrompt,
        intervalMinutes: Math.trunc(nextInterval),
        maxCycles: Math.trunc(Number(maxTurnsInput.value)),
        goal: nextGoal,
        nextAction: nextHook,
        nextActionTemplate: templateInput.value.trim(),
      });
    });

    dialog.addEventListener(
      "close",
      () => {
        if (dialog.returnValue !== "confirm") {
          resolve(null);
        }
        cleanup();
      },
      { once: true },
    );

    document.body.append(dialog);
    dialog.showModal();
    requestAnimationFrame(() => goalInput.focus());
  });
}
