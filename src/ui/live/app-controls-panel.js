/**
 * App controls side panel for live sessions.
 * Renders the same app card used on the Apps page.
 */

function createModeButton(mode, currentMode, title, icon, onModeChange) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `wm-webview-mode-btn${currentMode === mode ? " active" : ""}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = icon;
  button.addEventListener("click", () => onModeChange(mode));
  return button;
}

export function createAppControlsToolbar(currentMode, onModeChange, onClose) {
  const toolbar = document.createElement("div");
  toolbar.className = "wm-webview-toolbar";

  const modeGroup = document.createElement("div");
  modeGroup.className = "wm-webview-toolbar-modes";

  const title = document.createElement("span");
  title.className = "wm-app-controls-toolbar-title";
  title.textContent = "App card";
  modeGroup.append(title);

  const chatNarrowBtn = createModeButton(
    "chat-narrow",
    currentMode,
    "Chat narrow, app card wide",
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="6" height="18" rx="1"/><rect x="10" y="3" width="12" height="18" rx="1"/></svg>',
    onModeChange,
  );

  const appNarrowBtn = createModeButton(
    "app-narrow",
    currentMode,
    "Chat wide, app card narrow",
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="12" height="18" rx="1"/><rect x="16" y="3" width="6" height="18" rx="1"/></svg>',
    onModeChange,
  );

  modeGroup.append(chatNarrowBtn, appNarrowBtn);

  const actionsGroup = document.createElement("div");
  actionsGroup.className = "wm-webview-toolbar-actions";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "wm-webview-close-btn";
  closeBtn.title = "Close app card";
  closeBtn.setAttribute("aria-label", "Close app card panel");
  closeBtn.dataset.testid = "app-card-panel-close";
  closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  closeBtn.addEventListener("click", onClose);

  actionsGroup.append(closeBtn);
  toolbar.append(modeGroup, actionsGroup);

  return toolbar;
}

function createFallbackPanel(app) {
  const wrapper = document.createElement("section");
  wrapper.className = "wm-card wm-app-card wm-app-controls-card";

  const title = document.createElement("h3");
  title.textContent = app?.label ?? app?.id ?? "App";

  const note = document.createElement("p");
  note.className = "wm-apps-empty";
  note.textContent = "App card renderer unavailable.";

  wrapper.append(title, note);
  return wrapper;
}

export function createAppControlsPanel(app, options = {}) {
  const { renderAppCard } = options;

  const panel = document.createElement("div");
  panel.className = "wm-app-controls-panel";
  panel.dataset.testid = "app-card-panel";

  if (typeof renderAppCard === "function") {
    const card = renderAppCard(app);
    if (card instanceof HTMLElement) {
      card.classList.add("wm-app-controls-card");
      panel.append(card);
      return panel;
    }
  }

  panel.append(createFallbackPanel(app));
  return panel;
}
