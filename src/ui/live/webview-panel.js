/**
 * Webview panel for live sessions.
 * Shows an inline iframe for web apps associated with a session.
 */

/**
 * Match a session to a registered app by working directory.
 * First tries exact directory match, then falls back to appId from npub-project.
 * @param {string} sessionId
 * @param {Array} sessions
 * @param {Array} apps
 * @param {{ items: Array }} npubProjects
 * @returns {Object|null} Matching app or null
 */
export function findAppForSession(sessionId, sessions, apps, npubProjects) {
  const session = sessions.find((s) => s.id === sessionId);
  const directory = session?.workingDirectory;
  if (!directory) return null;

  // Exact directory match
  let app = apps.find((a) => a.root === directory);

  // Fallback: appId from npub-project
  if (!app) {
    const project = npubProjects.items.find((p) => p.directoryPath === directory);
    if (project?.appId) {
      app = apps.find((a) => a.id === project.appId);
    }
  }

  return app || null;
}

/**
 * Match a session to a registered web app (requires webApp: true).
 * @param {string} sessionId
 * @param {Array} sessions
 * @param {Array} apps
 * @param {{ items: Array }} npubProjects
 * @returns {Object|null} Matching web app or null
 */
export function findWebAppForSession(sessionId, sessions, apps, npubProjects) {
  const app = findAppForSession(sessionId, sessions, apps, npubProjects);
  if (!app || !app.webApp) return null;
  return app;
}

/**
 * Get the best URL for a web app's iframe.
 * Prefers subdomainUrl, falls back to webAppUrl.
 * @param {Object} app
 * @returns {string|null}
 */
function resolveAppUrl(app) {
  return app.subdomainUrl || app.webAppUrl || null;
}

/**
 * Create the globe icon button that toggles the webview panel.
 * @param {Object} app
 * @param {Function} onToggle
 * @returns {HTMLButtonElement}
 */
export function createWebviewIcon(app, onToggle) {
  const btn = document.createElement("button");
  btn.className = "wm-webview-icon";
  btn.title = `Open ${app.label || 'web app'}`;
  btn.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
  btn.addEventListener("click", onToggle);
  return btn;
}

/**
 * Create the webview iframe panel.
 * @param {Object} app
 * @returns {{ panel: HTMLElement, iframe: HTMLIFrameElement }|null}
 */
export function createWebviewPanel(app) {
  const url = resolveAppUrl(app);
  if (!url) return null;

  const panel = document.createElement("div");
  panel.className = "wm-webview-panel";

  const iframe = document.createElement("iframe");
  iframe.src = url;
  iframe.className = "wm-webview-iframe";
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
  iframe.setAttribute("loading", "lazy");

  panel.append(iframe);
  return { panel, iframe };
}

/**
 * Force-reload an iframe, bypassing cache where possible.
 * Tries contentWindow.location.reload() for same-origin frames,
 * falls back to resetting src with a cache-busting query param.
 * @param {HTMLIFrameElement} iframe
 */
function forceReloadIframe(iframe) {
  try {
    // Same-origin: direct reload
    iframe.contentWindow.location.reload();
  } catch {
    // Cross-origin: reset src with cache-buster
    const url = new URL(iframe.src);
    url.searchParams.set("_cb", Date.now().toString(36));
    iframe.src = url.toString();
  }
}

/**
 * Create the layout toolbar with mode toggle, refresh, and close buttons.
 * @param {string} currentMode - 'chat-narrow' or 'app-narrow'
 * @param {Function} onModeChange - Called with new mode string
 * @param {Function} onClose - Called when close is clicked
 * @param {{ iframe: HTMLIFrameElement }|null} webviewRef - Reference to the webview iframe
 * @returns {HTMLElement}
 */
export function createLayoutToolbar(currentMode, onModeChange, onClose, webviewRef) {
  const toolbar = document.createElement("div");
  toolbar.className = "wm-webview-toolbar";

  const modeGroup = document.createElement("div");
  modeGroup.className = "wm-webview-toolbar-modes";

  const chatNarrowBtn = document.createElement("button");
  chatNarrowBtn.className = `wm-webview-mode-btn${currentMode === "chat-narrow" ? " active" : ""}`;
  chatNarrowBtn.title = "Chat narrow, app wide";
  chatNarrowBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="6" height="18" rx="1"/><rect x="10" y="3" width="12" height="18" rx="1"/></svg>`;
  chatNarrowBtn.addEventListener("click", () => onModeChange("chat-narrow"));

  const appNarrowBtn = document.createElement("button");
  appNarrowBtn.className = `wm-webview-mode-btn${currentMode === "app-narrow" ? " active" : ""}`;
  appNarrowBtn.title = "Chat wide, app narrow";
  appNarrowBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="12" height="18" rx="1"/><rect x="16" y="3" width="6" height="18" rx="1"/></svg>`;
  appNarrowBtn.addEventListener("click", () => onModeChange("app-narrow"));

  modeGroup.append(chatNarrowBtn, appNarrowBtn);

  const actionsGroup = document.createElement("div");
  actionsGroup.className = "wm-webview-toolbar-actions";

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "wm-webview-refresh-btn";
  refreshBtn.title = "Reload app (force refresh)";
  refreshBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
  refreshBtn.addEventListener("click", () => {
    if (webviewRef?.iframe) {
      forceReloadIframe(webviewRef.iframe);
    }
  });

  const closeBtn = document.createElement("button");
  closeBtn.className = "wm-webview-close-btn";
  closeBtn.title = "Close webview";
  closeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  closeBtn.addEventListener("click", onClose);

  actionsGroup.append(refreshBtn, closeBtn);
  toolbar.append(modeGroup, actionsGroup);
  return toolbar;
}
