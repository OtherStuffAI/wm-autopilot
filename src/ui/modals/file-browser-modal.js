import {
  createFileBrowserPreviewContent,
  createPreviewStateFromPayload,
  fetchFileBrowserDirectory,
  fetchFileBrowserPreview,
} from "./file-browser-preview.js";
import { createIconSvg, FILE_BROWSER_ICON_DEFS } from "../core/icons.js";

export function buildFilesRoutePath(relativePath) {
  const cleanPath = typeof relativePath === "string" ? relativePath.replace(/^\/+/, "") : "";
  if (!cleanPath) return "/files";
  return `/files/${cleanPath.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

export function sortFileBrowserEntries(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort((left, right) => {
    const leftDir = left?.type === "directory" ? 0 : 1;
    const rightDir = right?.type === "directory" ? 0 : 1;
    if (leftDir !== rightDir) return leftDir - rightDir;
    return String(left?.name ?? "").localeCompare(String(right?.name ?? ""), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

export function normalizeCommandFileBrowserFavourites(favourites) {
  if (!Array.isArray(favourites)) return [];
  const seen = new Set();
  const normalized = [];

  for (const favourite of favourites) {
    const path = typeof favourite?.path === "string" ? favourite.path.trim() : "";
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const fallbackName = path.replace(/\/+$/, "").split("/").filter(Boolean).pop() || path;
    const name = typeof favourite?.name === "string" && favourite.name.trim()
      ? favourite.name.trim()
      : fallbackName;
    normalized.push({ path, name });
  }

  return normalized;
}

function createFileBrowserEntryIcon(entryType) {
  const isDirectory = entryType === "directory";
  const icon = document.createElement("span");
  icon.className = "wm-command-file-browser__entry-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.append(createIconSvg(isDirectory ? FILE_BROWSER_ICON_DEFS.folder : FILE_BROWSER_ICON_DEFS.file));
  return icon;
}

export function openCommandFileBrowserModal({
  initialPath = "",
  favourites = [],
  getSession,
  onPinFile,
  showToast,
} = {}) {
  const existing = document.getElementById("command-file-browser-modal");
  if (existing instanceof HTMLDialogElement && existing.open) {
    existing.close();
  }
  existing?.remove();

  const dialog = document.createElement("dialog");
  dialog.id = "command-file-browser-modal";
  dialog.className = "wm-command-file-browser-modal";
  dialog.dataset.testid = "command-file-browser-modal";
  dialog.setAttribute("aria-labelledby", "command-file-browser-title");

  const shell = document.createElement("div");
  shell.className = "wm-command-file-browser";

  const header = document.createElement("header");
  header.className = "wm-command-file-browser__header";

  const titleWrap = document.createElement("div");
  const title = document.createElement("h2");
  title.id = "command-file-browser-title";
  title.textContent = "File Browser";
  const subtitle = document.createElement("p");
  subtitle.className = "wm-command-file-browser__subtitle";
  subtitle.setAttribute("aria-live", "polite");
  titleWrap.append(title, subtitle);

  const favouriteEntries = normalizeCommandFileBrowserFavourites(favourites);
  let favouritesControl = null;
  if (favouriteEntries.length > 0) {
    favouritesControl = document.createElement("label");
    favouritesControl.className = "wm-command-file-browser__favourites";
    const favouritesLabel = document.createElement("span");
    favouritesLabel.textContent = "Favourites";
    const favouritesSelect = document.createElement("select");
    favouritesSelect.dataset.testid = "command-file-browser-favourites";
    favouritesSelect.setAttribute("aria-label", "Jump to favourite folder");
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Jump to...";
    favouritesSelect.append(placeholder);
    favouriteEntries.forEach((favourite) => {
      const option = document.createElement("option");
      option.value = favourite.path;
      option.textContent = favourite.name;
      option.title = favourite.path;
      favouritesSelect.append(option);
    });
    favouritesSelect.addEventListener("change", () => {
      const path = favouritesSelect.value;
      favouritesSelect.value = "";
      if (path) {
        void loadDirectory(path);
      }
    });
    favouritesControl.append(favouritesLabel, favouritesSelect);
  }

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wm-button secondary wm-button--small";
  closeButton.textContent = "Close";
  closeButton.setAttribute("aria-label", "Close file browser");
  closeButton.dataset.testid = "command-file-browser-close";
  closeButton.addEventListener("click", () => dialog.close());
  if (favouritesControl) {
    header.append(titleWrap, favouritesControl, closeButton);
  } else {
    header.append(titleWrap, closeButton);
  }

  const content = document.createElement("div");
  content.className = "wm-command-file-browser__content";

  const browser = document.createElement("section");
  browser.className = "wm-command-file-browser__browser";
  browser.setAttribute("aria-label", "Files");

  const pathBar = document.createElement("div");
  pathBar.className = "wm-command-file-browser__pathbar";
  const upButton = document.createElement("button");
  upButton.type = "button";
  upButton.className = "wm-button secondary wm-button--small";
  upButton.textContent = "Up";
  upButton.dataset.testid = "command-file-browser-up";
  const pathLabel = document.createElement("code");
  pathLabel.className = "wm-command-file-browser__path";
  pathBar.append(upButton, pathLabel);

  const list = document.createElement("div");
  list.className = "wm-command-file-browser__list";
  list.dataset.testid = "command-file-browser-list";
  list.setAttribute("role", "listbox");
  browser.append(pathBar, list);

  const previewCard = document.createElement("section");
  previewCard.className = "wm-command-file-browser__preview";
  previewCard.setAttribute("aria-label", "File preview");

  const previewHeader = document.createElement("div");
  previewHeader.className = "wm-command-file-browser__preview-header";
  const previewTitle = document.createElement("h3");
  previewTitle.textContent = "Preview";
  const actions = document.createElement("div");
  actions.className = "wm-command-file-browser__actions";
  previewHeader.append(previewTitle, actions);

  const previewMount = document.createElement("div");
  previewMount.className = "wm-command-file-browser__preview-mount";
  previewCard.append(previewHeader, previewMount);
  content.append(browser, previewCard);

  const status = document.createElement("p");
  status.className = "wm-command-file-browser__status";
  status.setAttribute("aria-live", "polite");

  shell.append(header, content, status);
  dialog.append(shell);

  const state = {
    session: typeof getSession === "function" ? getSession() : null,
    currentPath: typeof initialPath === "string" ? initialPath : "",
    displayPath: "",
    parent: null,
    entries: [],
    loading: false,
    error: null,
    preview: null,
    actionPending: false,
  };

  function setStatus(message, type = "") {
    status.textContent = message ?? "";
    status.dataset.state = type;
  }

  function selectedSession() {
    return state.session;
  }

  function renderActions() {
    actions.innerHTML = "";
    const preview = state.preview;
    const hasFile = Boolean(preview?.path) && !preview.loading;
    const session = selectedSession();

    if (hasFile && preview.relativePath) {
      const openLink = document.createElement("a");
      openLink.className = "wm-button secondary wm-button--small";
      openLink.href = buildFilesRoutePath(preview.relativePath);
      openLink.target = "_blank";
      openLink.rel = "noopener noreferrer";
      openLink.textContent = "Open in Files";
      openLink.dataset.testid = "command-file-browser-open-files";
      actions.append(openLink);
    }

    const pinButton = document.createElement("button");
    pinButton.type = "button";
    pinButton.className = "wm-button secondary wm-button--small";
    pinButton.textContent = "Pin to Session";
    pinButton.disabled = !hasFile || !session || state.actionPending;
    pinButton.dataset.testid = "command-file-browser-pin";
    pinButton.addEventListener("click", () => void pinPreviewFile(false));
    actions.append(pinButton);

    const artifactButton = document.createElement("button");
    artifactButton.type = "button";
    artifactButton.className = "wm-button wm-button--small";
    artifactButton.textContent = "View Artifact";
    artifactButton.disabled = !hasFile || !session || state.actionPending;
    artifactButton.dataset.testid = "command-file-browser-view-artifact";
    artifactButton.addEventListener("click", () => void pinPreviewFile(true));
    actions.append(artifactButton);
  }

  function renderPreview() {
    const preview = state.preview;
    previewTitle.textContent = preview?.name ?? "Preview";
    if (preview?.label) {
      const badge = document.createElement("span");
      badge.className = "wm-files-preview__badge";
      badge.textContent = preview.label;
      previewTitle.append(document.createTextNode(" "), badge);
    }
    renderActions();
    previewMount.innerHTML = "";
    previewMount.append(createFileBrowserPreviewContent(preview));
  }

  function renderList() {
    subtitle.textContent = state.loading
      ? "Loading..."
      : state.displayPath || state.currentPath || "Workspace";
    pathLabel.textContent = state.displayPath || state.currentPath || "Workspace";
    pathLabel.title = state.currentPath || "";
    upButton.disabled = !state.parent || state.loading;
    list.innerHTML = "";

    if (state.loading) {
      const loading = document.createElement("p");
      loading.className = "wm-command-file-browser__empty";
      loading.textContent = "Loading...";
      list.append(loading);
      return;
    }

    if (state.error) {
      const error = document.createElement("p");
      error.className = "wm-command-file-browser__empty";
      error.textContent = state.error;
      list.append(error);
      return;
    }

    const rows = sortFileBrowserEntries(state.entries);
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-command-file-browser__empty";
      empty.textContent = "Empty directory";
      list.append(empty);
      return;
    }

    rows.forEach((entry) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "wm-command-file-browser__entry";
      row.dataset.type = entry.type || "file";
      row.dataset.testid = entry.type === "directory" ? "command-file-browser-directory" : "command-file-browser-file";
      row.setAttribute("role", "option");
      row.setAttribute("aria-label", `${entry.type === "directory" ? "Open folder" : "Preview file"} ${entry.name ?? ""}`);

      const icon = createFileBrowserEntryIcon(entry.type);

      const main = document.createElement("span");
      main.className = "wm-command-file-browser__entry-main";
      const name = document.createElement("span");
      name.className = "wm-command-file-browser__entry-name";
      name.textContent = entry.name ?? "";
      const meta = document.createElement("span");
      meta.className = "wm-command-file-browser__entry-meta";
      meta.textContent = entry.type === "directory"
        ? "Folder"
        : entry.previewLabel || (entry.previewable ? "Previewable" : "No preview");
      main.append(name, meta);

      row.append(icon, main);
      row.addEventListener("click", () => {
        if (entry.type === "directory") {
          void loadDirectory(entry.path || entry.absolutePath || entry.relativePath || "");
          return;
        }
        if (entry.previewable) {
          void loadPreview(entry.path || entry.absolutePath || entry.relativePath || "");
          return;
        }
        state.preview = {
          path: entry.path || entry.absolutePath || entry.relativePath || "",
          relativePath: entry.relativePath ?? "",
          displayPath: entry.displayPath ?? "",
          name: entry.name ?? null,
          content: null,
          format: null,
          label: entry.previewLabel ?? null,
          loading: false,
          error: "Preview not available for this file type.",
        };
        renderPreview();
      });
      list.append(row);
    });
  }

  function render() {
    renderList();
    renderPreview();
  }

  async function loadDirectory(path) {
    state.loading = true;
    state.error = null;
    render();
    try {
      const data = await fetchFileBrowserDirectory(path);
      state.currentPath = data?.path ?? path ?? "";
      state.displayPath = data?.displayPath ?? data?.relativePath ?? state.currentPath;
      state.parent = data?.parent ?? null;
      state.entries = Array.isArray(data?.entries) ? data.entries : [];
      state.loading = false;
      state.error = null;
      setStatus("");
      render();
    } catch (error) {
      state.loading = false;
      state.error = error instanceof Error ? error.message : "Failed to load directory";
      setStatus(state.error, "error");
      render();
    }
  }

  async function loadPreview(path) {
    if (!path) return;
    state.preview = { path, name: path.split("/").pop(), content: null, loading: true, error: null };
    renderPreview();
    try {
      state.preview = createPreviewStateFromPayload(await fetchFileBrowserPreview(path), path);
      setStatus("");
      renderPreview();
    } catch (error) {
      state.preview = {
        path,
        name: path.split("/").pop(),
        content: null,
        loading: false,
        error: error instanceof Error ? error.message : "Failed to load file",
      };
      setStatus(state.preview.error, "error");
      renderPreview();
    }
  }

  async function pinPreviewFile(openArtifact) {
    const filePath = state.preview?.path;
    if (!filePath || typeof onPinFile !== "function") return;
    state.actionPending = true;
    setStatus(openArtifact ? "Opening artifact..." : "Pinning file...");
    renderActions();
    try {
      await onPinFile(filePath, { openArtifact, session: state.session });
      setStatus(openArtifact ? "Artifact opened." : "Pinned to session.", "success");
      showToast?.(openArtifact ? "Artifact opened" : "Pinned file to session", { type: "success" });
      if (openArtifact) {
        dialog.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to pin file";
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
    } finally {
      state.actionPending = false;
      renderActions();
    }
  }

  upButton.addEventListener("click", () => {
    if (state.parent) {
      void loadDirectory(state.parent.path ?? state.parent);
    }
  });

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
  });

  document.body.append(dialog);
  render();
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "open");
  }
  void loadDirectory(state.currentPath);
}
