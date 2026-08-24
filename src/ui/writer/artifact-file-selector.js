function getEntryPath(entry) {
  return entry?.path || entry?.absolutePath || "";
}

function getDisplayName(entry) {
  return typeof entry?.name === "string" && entry.name.length > 0 ? entry.name : getEntryPath(entry);
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const aDir = a?.type === "directory" ? 0 : 1;
    const bDir = b?.type === "directory" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return getDisplayName(a).localeCompare(getDisplayName(b));
  });
}

function createStatus(message, className = "wm-artifact-file-selector__status") {
  const status = document.createElement("div");
  status.className = className;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = message;
  return status;
}

export function createArtifactFileSelector({ initialPath = "", onSelect, showToast } = {}) {
  const panel = document.createElement("div");
  panel.className = "wm-writer-panel wm-artifact-file-selector";
  panel.dataset.testid = "live-artifact-file-selector";

  const header = document.createElement("div");
  header.className = "wm-artifact-file-selector__header";

  const title = document.createElement("h3");
  title.textContent = "Select artifact";

  const pathLabel = document.createElement("div");
  pathLabel.className = "wm-artifact-file-selector__path";
  pathLabel.dataset.testid = "live-artifact-file-selector-path";

  header.append(title, pathLabel);

  const breadcrumb = document.createElement("div");
  breadcrumb.className = "wm-artifact-file-selector__breadcrumb";
  breadcrumb.setAttribute("aria-label", "Artifact browser breadcrumb");

  const list = document.createElement("div");
  list.className = "wm-artifact-file-selector__list";
  list.dataset.testid = "live-artifact-file-selector-list";

  panel.append(header, breadcrumb, list);

  let currentPath = initialPath;
  let destroyed = false;
  let selecting = false;

  function renderBreadcrumb(absolutePath) {
    breadcrumb.innerHTML = "";

    const rootButton = document.createElement("button");
    rootButton.type = "button";
    rootButton.className = "wm-artifact-file-selector__crumb";
    rootButton.textContent = "/";
    rootButton.setAttribute("aria-label", "Open workspace root");
    rootButton.addEventListener("click", () => {
      void loadDirectory("");
    });
    breadcrumb.append(rootButton);

    const parts = String(absolutePath ?? "").split("/").filter(Boolean);
    let accumulated = "";
    for (const part of parts) {
      accumulated += `/${part}`;
      const separator = document.createElement("span");
      separator.className = "wm-artifact-file-selector__separator";
      separator.textContent = "/";
      breadcrumb.append(separator);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "wm-artifact-file-selector__crumb";
      button.textContent = part;
      button.title = accumulated;
      button.addEventListener("click", () => {
        void loadDirectory(accumulated);
      });
      breadcrumb.append(button);
    }
  }

  function renderParentRow(parentPath) {
    if (!parentPath) return;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "wm-artifact-file-selector__entry wm-artifact-file-selector__entry--dir";
    row.setAttribute("aria-label", "Open parent directory");
    row.textContent = "..";
    row.addEventListener("click", () => {
      void loadDirectory(parentPath);
    });
    list.append(row);
  }

  function renderEntry(entry) {
    const path = getEntryPath(entry);
    const name = getDisplayName(entry);
    const isDirectory = entry?.type === "directory";
    const row = document.createElement("button");
    row.type = "button";
    row.className = `wm-artifact-file-selector__entry ${isDirectory ? "wm-artifact-file-selector__entry--dir" : "wm-artifact-file-selector__entry--file"}`;
    row.disabled = selecting;
    row.dataset.testid = isDirectory ? "live-artifact-file-selector-directory" : "live-artifact-file-selector-file";
    row.setAttribute("aria-label", `${isDirectory ? "Open directory" : "Select artifact"} ${name}`);

    const icon = document.createElement("span");
    icon.className = "wm-artifact-file-selector__icon";
    icon.textContent = isDirectory ? "Folder" : "File";

    const label = document.createElement("span");
    label.className = "wm-artifact-file-selector__label";
    label.textContent = name;
    label.title = path;

    row.append(icon, label);
    row.addEventListener("click", () => {
      if (isDirectory) {
        void loadDirectory(path);
        return;
      }
      void selectFile(path);
    });
    list.append(row);
  }

  function renderEntries(data) {
    if (destroyed) return;
    const absolutePath = data?.absolutePath || data?.path || currentPath || "";
    currentPath = absolutePath;
    pathLabel.textContent = data?.displayPath || absolutePath || "Workspace";
    pathLabel.title = absolutePath;
    renderBreadcrumb(absolutePath);
    list.innerHTML = "";

    renderParentRow(data?.parent ?? null);

    const entries = Array.isArray(data?.entries) ? data.entries : Array.isArray(data?.items) ? data.items : [];
    if (entries.length === 0 && !data?.parent) {
      list.append(createStatus("Empty directory"));
      return;
    }
    for (const entry of sortEntries(entries)) {
      renderEntry(entry);
    }
  }

  async function loadDirectory(path) {
    currentPath = path || "";
    list.innerHTML = "";
    list.append(createStatus("Loading..."));
    const params = new URLSearchParams();
    if (currentPath) params.set("path", currentPath);
    params.set("showHidden", "false");

    try {
      const response = await fetch(`/api/docs/tree?${params}`);
      if (!response.ok) {
        throw new Error(response.statusText || `HTTP ${response.status}`);
      }
      const data = await response.json();
      renderEntries(data);
    } catch (error) {
      if (destroyed) return;
      const message = error instanceof Error ? error.message : "Failed to load files";
      list.innerHTML = "";
      list.append(createStatus(`Failed to load: ${message}`, "wm-artifact-file-selector__status wm-artifact-file-selector__status--error"));
    }
  }

  async function selectFile(filePath) {
    if (!filePath || selecting) return;
    selecting = true;
    list.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    try {
      await onSelect?.(filePath);
    } catch (error) {
      selecting = false;
      const message = error instanceof Error ? error.message : "Failed to select artifact";
      showToast?.(`Failed to pin artifact: ${message}`, { type: "error" });
      await loadDirectory(currentPath);
    }
  }

  void loadDirectory(initialPath || "");

  return {
    panel,
    cleanup() {
      destroyed = true;
    },
  };
}
