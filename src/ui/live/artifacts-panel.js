/**
 * Artifacts panel for live sessions.
 * Shows a gallery of session artifacts (images, documents, files)
 * in a side panel alongside the chat.
 */

/**
 * Fetch artifacts for a session from the API.
 * @param {string} sessionId
 * @returns {Promise<Array>}
 */
export async function fetchSessionArtifacts(sessionId) {
  try {
    const resp = await fetch(`/api/sessions/${sessionId}/artifacts`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.artifacts || [];
  } catch {
    return [];
  }
}

/**
 * Create the artifacts icon button with optional count badge.
 * @param {number} count - Number of artifacts
 * @param {Function} onToggle - Called when clicked
 * @returns {HTMLButtonElement}
 */
export function createArtifactsIcon(count, onToggle) {
  const btn = document.createElement("button");
  btn.className = "wm-artifacts-icon";
  btn.title = `Artifacts (${count})`;
  btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  if (count > 0) {
    const badge = document.createElement("span");
    badge.className = "wm-artifacts-badge";
    badge.textContent = String(count);
    btn.append(badge);
  }
  btn.addEventListener("click", onToggle);
  return btn;
}

/**
 * Create the artifacts toolbar with layout mode toggle and close button.
 * @param {string} currentMode - 'chat-narrow' or 'app-narrow'
 * @param {Function} onModeChange - Called with new mode string
 * @param {Function} onClose - Called when close is clicked
 * @returns {HTMLElement}
 */
export function createArtifactsToolbar(currentMode, onModeChange, onClose) {
  const toolbar = document.createElement("div");
  toolbar.className = "wm-webview-toolbar";

  const modeGroup = document.createElement("div");
  modeGroup.className = "wm-webview-toolbar-modes";

  const title = document.createElement("span");
  title.className = "wm-artifacts-toolbar-title";
  title.textContent = "Artifacts";
  title.style.cssText = "font-size:0.85em;font-weight:600;margin-right:8px;";

  const chatNarrowBtn = document.createElement("button");
  chatNarrowBtn.className = `wm-webview-mode-btn${currentMode === "chat-narrow" ? " active" : ""}`;
  chatNarrowBtn.title = "Chat narrow, panel wide";
  chatNarrowBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="6" height="18" rx="1"/><rect x="10" y="3" width="12" height="18" rx="1"/></svg>`;
  chatNarrowBtn.addEventListener("click", () => onModeChange("chat-narrow"));

  const appNarrowBtn = document.createElement("button");
  appNarrowBtn.className = `wm-webview-mode-btn${currentMode === "app-narrow" ? " active" : ""}`;
  appNarrowBtn.title = "Chat wide, panel narrow";
  appNarrowBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="12" height="18" rx="1"/><rect x="16" y="3" width="6" height="18" rx="1"/></svg>`;
  appNarrowBtn.addEventListener("click", () => onModeChange("app-narrow"));

  modeGroup.append(title, chatNarrowBtn, appNarrowBtn);

  const actionsGroup = document.createElement("div");
  actionsGroup.className = "wm-webview-toolbar-actions";

  const closeBtn = document.createElement("button");
  closeBtn.className = "wm-webview-close-btn";
  closeBtn.title = "Close artifacts panel";
  closeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  closeBtn.addEventListener("click", onClose);

  actionsGroup.append(closeBtn);
  toolbar.append(modeGroup, actionsGroup);
  return toolbar;
}

/**
 * Create the artifacts panel showing a gallery of artifacts.
 * @param {string} sessionId
 * @param {Array} artifacts - Pre-fetched artifacts array
 * @returns {{ panel: HTMLElement, refresh: Function }}
 */
export function createArtifactsPanel(sessionId, artifacts) {
  const panel = document.createElement("div");
  panel.className = "wm-artifacts-panel";

  function renderContent(items) {
    panel.innerHTML = "";

    if (!items || items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wm-artifacts-empty";
      empty.style.cssText = "padding:24px;text-align:center;color:var(--text-muted);font-size:0.9em;";
      empty.textContent = "No artifacts yet. Use the generate_image tool to create images.";
      panel.append(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "wm-artifacts-grid";
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;padding:12px;";

    for (const artifact of items) {
      const card = createArtifactCard(artifact);
      grid.append(card);
    }

    panel.append(grid);
  }

  function refresh() {
    fetchSessionArtifacts(sessionId).then((items) => {
      renderContent(items);
    });
  }

  renderContent(artifacts);
  return { panel, refresh };
}

/**
 * Create a card for a single artifact.
 * @param {Object} artifact
 * @returns {HTMLElement}
 */
function createArtifactCard(artifact) {
  const card = document.createElement("div");
  card.className = "wm-artifact-card";
  card.style.cssText = "border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--bg-secondary);cursor:pointer;";

  if (artifact.type === "image") {
    const imgContainer = document.createElement("div");
    imgContainer.style.cssText = "aspect-ratio:1;overflow:hidden;background:#111;display:flex;align-items:center;justify-content:center;";

    const img = document.createElement("img");
    img.src = `/api/artifacts/${artifact.id}/raw`;
    img.alt = artifact.label;
    img.loading = "lazy";
    img.style.cssText = "max-width:100%;max-height:100%;object-fit:contain;";
    imgContainer.append(img);
    card.append(imgContainer);

    // Click to view full-size in lightbox
    card.addEventListener("click", () => showLightbox(artifact));
  } else {
    const iconContainer = document.createElement("div");
    iconContainer.style.cssText = "aspect-ratio:1;display:flex;align-items:center;justify-content:center;background:var(--bg);";
    iconContainer.innerHTML = getArtifactTypeIcon(artifact.type);
    card.append(iconContainer);

    card.addEventListener("click", () => {
      if (artifact.url) {
        window.open(artifact.url, "_blank", "noopener");
      }
    });
  }

  const labelEl = document.createElement("div");
  labelEl.className = "wm-artifact-label";
  labelEl.style.cssText = "padding:6px 8px;font-size:0.8em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  labelEl.textContent = artifact.label;
  labelEl.title = artifact.label;
  card.append(labelEl);

  return card;
}

/**
 * Show a full-screen lightbox for an image artifact.
 * @param {Object} artifact
 */
function showLightbox(artifact) {
  const overlay = document.createElement("div");
  overlay.className = "wm-lightbox-overlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:pointer;";

  const img = document.createElement("img");
  img.src = `/api/artifacts/${artifact.id}/raw`;
  img.alt = artifact.label;
  img.style.cssText = "max-width:90vw;max-height:90vh;object-fit:contain;border-radius:4px;";

  overlay.append(img);
  overlay.addEventListener("click", () => overlay.remove());

  document.addEventListener("keydown", function handler(e) {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", handler);
    }
  });

  document.body.append(overlay);
}

/**
 * Get an SVG icon for the artifact type.
 * @param {string} type
 * @returns {string} SVG markup
 */
function getArtifactTypeIcon(type) {
  const icons = {
    document: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
    webview: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    file: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`,
  };
  return icons[type] || icons.file;
}
