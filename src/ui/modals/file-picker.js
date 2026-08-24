import { escapeHtml } from "../core/icons.js";

/**
 * Lightweight file picker modal for selecting a file to pin as an artifact.
 * Uses /api/docs/tree to browse directories and select files.
 *
 * Exports:
 *   openFilePicker({ initialPath, onSelect }) -> Promise<string | null>
 */

/**
 * Opens a file picker dialog. Returns a promise that resolves to the selected
 * file path, or null if cancelled.
 */
export function openFilePicker({ initialPath } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "wm-file-picker-dialog";
    dialog.innerHTML = `
      <div class="wm-file-picker">
        <div class="wm-file-picker-header">
          <h3>Select File</h3>
          <button class="wm-file-picker-close" title="Cancel">&times;</button>
        </div>
        <div class="wm-file-picker-breadcrumb"></div>
        <div class="wm-file-picker-list"></div>
      </div>
    `;

    const closeBtn = dialog.querySelector(".wm-file-picker-close");
    const breadcrumb = dialog.querySelector(".wm-file-picker-breadcrumb");
    const listEl = dialog.querySelector(".wm-file-picker-list");

    let resolved = false;
    function finish(result) {
      if (resolved) return;
      resolved = true;
      dialog.close();
      dialog.remove();
      resolve(result);
    }

    closeBtn.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", () => finish(null));
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) finish(null);
    });

    async function loadDirectory(path) {
      listEl.innerHTML = '<div class="wm-file-picker-loading">Loading...</div>';

      const params = new URLSearchParams();
      if (path) params.set("path", path);
      params.set("showHidden", "false");

      try {
        const res = await fetch(`/api/docs/tree?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        renderBreadcrumb(data.absolutePath || path || "");
        renderEntries(data);
      } catch (err) {
        listEl.innerHTML = `<div class="wm-file-picker-error">Failed to load: ${escapeHtml(err.message)}</div>`;
      }
    }

    function renderBreadcrumb(currentPath) {
      if (!currentPath) {
        breadcrumb.textContent = "/";
        return;
      }
      const parts = currentPath.split("/").filter(Boolean);
      breadcrumb.innerHTML = "";

      // Root link
      const rootLink = document.createElement("span");
      rootLink.className = "wm-file-picker-crumb";
      rootLink.textContent = "/";
      rootLink.addEventListener("click", () => loadDirectory(""));
      breadcrumb.appendChild(rootLink);

      let accumulated = "";
      for (const part of parts) {
        accumulated += "/" + part;
        const sep = document.createTextNode(" / ");
        breadcrumb.appendChild(sep);

        const link = document.createElement("span");
        link.className = "wm-file-picker-crumb";
        link.textContent = part;
        const linkPath = accumulated;
        link.addEventListener("click", () => loadDirectory(linkPath));
        breadcrumb.appendChild(link);
      }
    }

    function renderEntries(data) {
      listEl.innerHTML = "";

      const entries = data.entries || data.items || [];
      if (entries.length === 0) {
        listEl.innerHTML = '<div class="wm-file-picker-empty">Empty directory</div>';
        return;
      }

      // Sort: directories first, then files, alphabetically
      const sorted = [...entries].sort((a, b) => {
        const aDir = a.type === "directory" ? 0 : 1;
        const bDir = b.type === "directory" ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return (a.name || "").localeCompare(b.name || "");
      });

      // Parent directory link
      if (data.parent) {
        const parentRow = document.createElement("div");
        parentRow.className = "wm-file-picker-entry wm-file-picker-entry--dir";
        parentRow.innerHTML = '<span class="wm-file-picker-icon">&#128194;</span> <span>..</span>';
        parentRow.addEventListener("click", () => loadDirectory(data.parent));
        listEl.appendChild(parentRow);
      }

      for (const entry of sorted) {
        const row = document.createElement("div");
        const isDir = entry.type === "directory";
        row.className = `wm-file-picker-entry ${isDir ? "wm-file-picker-entry--dir" : "wm-file-picker-entry--file"}`;

        const icon = isDir ? "&#128194;" : "&#128196;";
        row.innerHTML = `<span class="wm-file-picker-icon">${icon}</span> <span>${escapeText(entry.name || "")}</span>`;

        if (isDir) {
          row.addEventListener("click", () => loadDirectory(entry.path || entry.absolutePath));
        } else {
          row.addEventListener("click", () => finish(entry.path || entry.absolutePath));
        }

        listEl.appendChild(row);
      }
    }

    document.body.appendChild(dialog);
    dialog.showModal();
    loadDirectory(initialPath || "");
  });
}

function escapeText(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
