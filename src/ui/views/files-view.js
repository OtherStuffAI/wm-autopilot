/**
 * Files view renderer — file browser, preview, git commands, CRUD operations.
 *
 * Depends on: state, file API helpers, file editor, markdown renderer (via DI).
 */

import { createIconSvg, setIconButton, FILE_BROWSER_ICON_DEFS } from "../core/icons.js";
import { openConfirmDialog, openTextPromptDialog } from "../common/dialog-prompts.js";
import { copyTextToClipboard } from "../utils/clipboard.js";
import {
  FILES_SHOW_HIDDEN_STORAGE_KEY,
  FILES_BROWSER_SHELVED_STORAGE_KEY,
  FILES_FAVORITES_STORAGE_KEY,
} from "../state/index.js";
import {
  createCsvPreview,
  createJsonPreview,
  createPdfPreview,
} from "../files/preview-renderers.js";
import { buildDocsFileDownloadUrl } from "../files/download-url.js";
import { createFileEditingPanel } from "../writer/file-editing-panel.js";

/**
 * Show a small floating agent picker menu anchored to a button.
 * Calls onSelect(agentId) when an agent is chosen, then removes the menu.
 */
function showQuickAgentPicker(anchor, agents, onSelect) {
  // Remove any existing picker
  document.querySelectorAll(".wm-writer-agent-picker").forEach((el) => el.remove());

  const menu = document.createElement("div");
  menu.className = "wm-writer-agent-picker";

  agents.forEach((agent) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "wm-writer-agent-picker__item";
    item.textContent = agent.label || agent.id;
    item.addEventListener("click", () => {
      menu.remove();
      onSelect(agent.id);
    });
    menu.append(item);
  });

  // Position relative to the anchor
  const rect = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.zIndex = "1000";

  document.body.append(menu);

  // Close on outside click
  const closeHandler = (e) => {
    if (!menu.contains(e.target) && e.target !== anchor) {
      menu.remove();
      document.removeEventListener("click", closeHandler, true);
    }
  };
  // Delay to avoid immediate close from the button click
  requestAnimationFrame(() => {
    document.addEventListener("click", closeHandler, true);
  });
}

function buildDocsRawUrl(path) {
  return `/api/docs/file/raw?path=${encodeURIComponent(path)}`;
}

function createImagePreviewElement(files) {
  const container = document.createElement("div");
  container.className = "wm-files-preview-image";
  container.dataset.testid = "files-image-preview";

  const image = document.createElement("img");
  image.src = files.previewUrl || buildDocsFileDownloadUrl(files.previewPath, { inline: true });
  image.alt = files.previewName || "Image preview";
  image.decoding = "async";
  image.loading = "eager";

  const status = document.createElement("div");
  status.className = "wm-files-browser__status";
  status.textContent = "Image preview unavailable in this browser.";
  status.hidden = true;

  image.addEventListener("error", () => {
    image.hidden = true;
    status.hidden = false;
  });

  container.append(image, status);
  return container;
}

function getPreviewIconKey(format) {
  if (format === "image") return "fileImage";
  if (format === "markdown") return "fileText";
  if (format === "pdf") return "fileText";
  if (format === "csv") return "fileText";
  return "fileCode";
}

function getPreviewMetaLabel(entry) {
  return entry.previewLabel ?? (
    entry.previewFormat === "image"
      ? "Image"
      : entry.previewFormat === "markdown"
        ? "Markdown"
        : entry.previewFormat === "pdf"
          ? "PDF"
          : entry.previewFormat === "csv"
            ? "CSV"
            : entry.previewFormat === "json"
              ? "JSON"
              : "Code"
  );
}

function getFilesSurfaceCopy(surface) {
  if (surface === "docs") {
    return {
      title: "Docs",
      description: "Browse and preview workspace documentation.",
      testId: "docs-page-header",
    };
  }
  return {
    title: "Files",
    description: "Browse and preview workspace files.",
    testId: "files-page-header",
  };
}

function createFilesPageHeader(surface) {
  const copy = getFilesSurfaceCopy(surface);
  const header = document.createElement("header");
  header.className = "wm-files-page-header";
  header.dataset.testid = copy.testId;

  const title = document.createElement("h1");
  title.id = "files-page-title";
  title.textContent = copy.title;

  const description = document.createElement("p");
  description.textContent = copy.description;

  header.append(title, description);
  return header;
}

export function initFilesView(deps) {
  const {
    state,
    getCurrentRoute,
    getFilesSurface,
    render,
    // File tree / preview
    loadFilesTree,
    loadFilesPreview,
    resetFilesPreview,
    showFilesPreviewUnavailable,
    // File API
    createFilesDirectory,
    createFilesTextFile,
    uploadFilesBinary,
    deleteFilesEntry,
    // File editor (stubs — late-bound)
    openFileEditor,
    // Directory browser
    openFileTransferDialogForMode,
    // File move
    moveFilesEntry,
    // Session launcher for writer mode
    launchSession,
    getConfig,
    showToast,
  } = deps;

  // ── Active writer panel (persisted across re-renders) ──────────
  let activeFileWriter = null; // { path, panel, cleanup }

  // ── File CRUD helpers ───────────────────────────────────────────

  const promptCreateDirectory = async () => {
    const files = state.files;
    if (files.loading) return;
    const parentPath = files.currentPath;
    const name = await openTextPromptDialog({
      title: "Create Folder",
      description: "Add a new folder inside the current directory.",
      label: "Folder name",
      value: "New Folder",
      confirmLabel: "Create",
      testId: "files-create-folder-dialog",
      validate: (value) => (value ? "" : "Folder name is required."),
    });
    if (!name) return;
    files.loading = true;
    if (getCurrentRoute() === "files") render();
    try {
      const result = await createFilesDirectory(parentPath, name);
      await loadFilesTree(result?.path ?? parentPath);
    } catch (error) {
      files.loading = false;
      if (getCurrentRoute() === "files") render();
      const message = error instanceof Error ? error.message : "Failed to create directory";
      showToast(message, { type: "error" });
    }
  };

  const promptCreateFile = async () => {
    const files = state.files;
    if (files.loading) return;
    const parentPath = files.currentPath;
    const name = await openTextPromptDialog({
      title: "Create File",
      description: "Add a new text file inside the current directory.",
      label: "File name",
      value: "notes.txt",
      confirmLabel: "Create",
      testId: "files-create-file-dialog",
      validate: (value) => (value ? "" : "File name is required."),
    });
    if (!name) return;
    files.loading = true;
    if (getCurrentRoute() === "files") render();
    try {
      const result = await createFilesTextFile(parentPath, name, "");
      await loadFilesTree(parentPath);
      if (result?.path) {
        if (result.previewable) {
          void loadFilesPreview(result.path);
        } else {
          resetFilesPreview();
          if (getCurrentRoute() === "files") render();
        }
        void openFileEditor(result.path, result.displayPath ?? null, result.name ?? null);
      }
    } catch (error) {
      files.loading = false;
      if (getCurrentRoute() === "files") render();
      const message = error instanceof Error ? error.message : "Failed to create file";
      showToast(message, { type: "error" });
    }
  };

  const uploadSelectedFile = async (file) => {
    if (!(file instanceof File)) return;
    const files = state.files;
    if (files.loading || files.uploading) return;
    const parentPath = files.currentPath;
    files.uploading = true;
    if (getCurrentRoute() === "files") render();
    try {
      const result = await uploadFilesBinary(parentPath, file);
      await loadFilesTree(parentPath);
      if (result?.path && result.previewable) {
        void loadFilesPreview(result.path);
      }
    } catch (error) {
      files.uploading = false;
      if (getCurrentRoute() === "files") render();
      const message = error instanceof Error ? error.message : "Failed to upload file";
      showToast(message, { type: "error" });
      return;
    }
    files.uploading = false;
    if (getCurrentRoute() === "files") render();
  };

  const promptUploadFile = () => {
    const files = state.files;
    if (files.loading || files.uploading) return;
    const input = document.createElement("input");
    input.type = "file";
    input.hidden = true;
    input.addEventListener("change", () => {
      const [selected] = input.files ?? [];
      if (selected) {
        void uploadSelectedFile(selected);
      }
      input.remove();
    });
    input.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    document.body.append(input);
    input.click();
  };

  // ── Main renderer ───────────────────────────────────────────────

  const { initFilesFromUrl } = deps;

  const renderFiles = () => {
    const files = state.files;
    if (!files.initialized) {
      files.initialized = true;
      if (typeof initFilesFromUrl === "function") {
        initFilesFromUrl();
      } else {
        void loadFilesTree();
      }
    }

    // ── Shared drag-and-drop handlers (function declarations for hoisting) ──
    function handleDragOver(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      e.currentTarget.dataset.dragover = "true";
    }
    function handleDragLeave(e) {
      // Only clear highlight when actually leaving the element, not entering a child
      if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;
      delete e.currentTarget.dataset.dragover;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "wm-files";
    const filesSurface = typeof getFilesSurface === "function" ? getFilesSurface() : "files";
    wrapper.dataset.surface = filesSurface;
    wrapper.setAttribute("aria-labelledby", "files-page-title");

    const surfaceCopy = getFilesSurfaceCopy(filesSurface);
    const pageHeader = createFilesPageHeader(filesSurface);

    const layout = document.createElement("div");
    layout.className = "wm-files-layout";
    if (files.browserShelved) {
      layout.dataset.shelved = "true";
    }

    const browserCard = document.createElement("section");
    browserCard.className = "wm-card wm-files-browser";

    const browserHeader = document.createElement("div");
    browserHeader.className = "wm-files-browser__header";

    const headerButton = document.createElement("button");
    headerButton.type = "button";
    headerButton.className = "wm-files-browser__info";
    headerButton.setAttribute("aria-expanded", "true");
    const headerTitle = document.createElement("h2");
    headerTitle.textContent = surfaceCopy.title;
    const pathLabel = document.createElement("span");
    pathLabel.className = "wm-files-browser__path";
    pathLabel.textContent = files.displayPath ?? "Workspace";
    headerButton.append(headerTitle, pathLabel);

    const controls = document.createElement("div");
    controls.className = "wm-files-browser__controls";

    const upButton = document.createElement("button");
    upButton.type = "button";
    upButton.className = "wm-files-toolbar-btn";
    setIconButton(upButton, "arrowUp", "Go up one directory");
    upButton.disabled = files.loading || !files.parent?.path;
    upButton.addEventListener("click", () => {
      if (files.loading) return;
      if (files.parent?.path) {
        void loadFilesTree(files.parent.path);
      }
    });

    // ── Drop target: "Go up" accepts dragged items → moves to parent dir ──
    if (files.parent?.path) {
      upButton.addEventListener("dragover", handleDragOver);
      upButton.addEventListener("dragleave", handleDragLeave);
      upButton.addEventListener("drop", async (e) => {
        e.preventDefault();
        delete e.currentTarget.dataset.dragover;
        const sourcePath = e.dataTransfer.getData("text/plain");
        if (!sourcePath) return;
        try {
          await moveFilesEntry(sourcePath, files.parent.path, null);
          await loadFilesTree(files.currentPath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to move item";
          showToast(msg, { type: "error" });
        }
      });
    }

    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "wm-files-toolbar-btn";
    setIconButton(refreshButton, "refresh", "Refresh directory contents");
    refreshButton.disabled = files.loading;
    refreshButton.addEventListener("click", () => {
      if (files.loading) return;
      void loadFilesTree(files.currentPath);
    });

    const toggleHiddenButton = document.createElement("button");
    toggleHiddenButton.type = "button";
    toggleHiddenButton.className = "wm-files-toolbar-btn";
    toggleHiddenButton.disabled = files.loading;
    const syncHiddenButtonIcon = () => {
      const iconKey = files.showHidden ? "eyeOff" : "eye";
      const label = files.showHidden ? "Hide hidden files" : "Show hidden files";
      setIconButton(toggleHiddenButton, iconKey, label);
      toggleHiddenButton.setAttribute("aria-pressed", files.showHidden ? "true" : "false");
    };
    syncHiddenButtonIcon();
    toggleHiddenButton.addEventListener("click", () => {
      if (files.loading) return;
      files.showHidden = !files.showHidden;
      syncHiddenButtonIcon();
      try {
        localStorage.setItem(FILES_SHOW_HIDDEN_STORAGE_KEY, files.showHidden ? "true" : "false");
      } catch {
        // Ignore storage failures
      }
      void loadFilesTree(files.currentPath);
      if (getCurrentRoute() === "files") {
        render();
      }
    });

    const newFolderButton = document.createElement("button");
    newFolderButton.type = "button";
    newFolderButton.className = "wm-files-toolbar-btn";
    setIconButton(newFolderButton, "folderPlus", "Create new folder");
    newFolderButton.disabled = files.loading;
    newFolderButton.addEventListener("click", () => {
      if (files.loading) return;
      void promptCreateDirectory();
    });

    const newFileButton = document.createElement("button");
    newFileButton.type = "button";
    newFileButton.className = "wm-files-toolbar-btn";
    setIconButton(newFileButton, "filePlus", "Create new file");
    newFileButton.disabled = files.loading;
    newFileButton.addEventListener("click", () => {
      if (files.loading) return;
      void promptCreateFile();
    });

    const uploadButton = document.createElement("button");
    uploadButton.type = "button";
    uploadButton.className = "wm-files-toolbar-btn";
    const syncUploadButtonState = () => {
      uploadButton.disabled = files.loading || files.uploading;
      setIconButton(uploadButton, "upload", files.uploading ? "Uploading\u2026" : "Upload file");
      if (files.uploading) {
        uploadButton.dataset.loading = "true";
      } else {
        delete uploadButton.dataset.loading;
      }
    };
    syncUploadButtonState();
    uploadButton.addEventListener("click", () => {
      if (files.loading || files.uploading) return;
      promptUploadFile();
    });

    const shelveButton = document.createElement("button");
    shelveButton.type = "button";
    shelveButton.className = "wm-files-browser__shelve";
    setIconButton(shelveButton, "sidebarClose", "Collapse sidebar");
    shelveButton.addEventListener("click", () => {
      files.browserShelved = true;
      try {
        localStorage.setItem(FILES_BROWSER_SHELVED_STORAGE_KEY, "true");
      } catch { /* ignore */ }
      if (getCurrentRoute() === "files") render();
    });

    const agentButton = document.createElement("button");
    agentButton.type = "button";
    agentButton.className = "wm-files-toolbar-btn wm-files-toolbar-btn--agent";
    setIconButton(agentButton, "terminal", "Start agent session here");
    agentButton.disabled = files.loading || !files.currentPath;
    agentButton.addEventListener("click", () => {
      if (files.loading || !files.currentPath) return;
      const config = typeof getConfig === "function" ? getConfig() : null;
      const agents = config?.agents ?? [];
      if (agents.length === 0) {
        showToast("No agents available.", { type: "warning" });
        return;
      }
      showQuickAgentPicker(agentButton, agents, (agentId) => {
        if (typeof launchSession === "function") {
          launchSession(agentId, files.currentPath, "", null, {
            openInNewTab: true,
          });
        }
      });
    });

    controls.append(
      upButton,
      refreshButton,
      toggleHiddenButton,
      newFolderButton,
      newFileButton,
      uploadButton,
      agentButton,
    );

    browserHeader.append(headerButton, controls);

    const list = document.createElement("ul");
    list.className = "wm-files-browser__list";
    list.id = "files-browser-list";
    headerButton.setAttribute("aria-controls", list.id);

    const collapsed = Boolean(files.browserCollapsed);
    const setBrowserCollapsed = (next) => {
      files.browserCollapsed = next;
      if (next) {
        browserCard.dataset.collapsed = "true";
        list.hidden = true;
        list.setAttribute("aria-hidden", "true");
        headerButton.setAttribute("aria-expanded", "false");
      } else {
        delete browserCard.dataset.collapsed;
        list.hidden = false;
        list.removeAttribute("aria-hidden");
        headerButton.setAttribute("aria-expanded", "true");
      }
    };
    setBrowserCollapsed(collapsed);
    headerButton.addEventListener("click", () => {
      setBrowserCollapsed(!files.browserCollapsed);
    });
    headerButton.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " " || event.key === "Space") {
        event.preventDefault();
        setBrowserCollapsed(!files.browserCollapsed);
      }
    });

    // ── Favourite folder helpers ──────────────────────────────────
    function isFavourite(path) {
      return files.favourites.some((f) => f.path === path);
    }
    function toggleFavourite(path, name) {
      if (isFavourite(path)) {
        files.favourites = files.favourites.filter((f) => f.path !== path);
      } else {
        files.favourites = [...files.favourites, { path, name }];
      }
      try {
        localStorage.setItem(FILES_FAVORITES_STORAGE_KEY, JSON.stringify(files.favourites));
      } catch { /* ignore */ }
      if (getCurrentRoute() === "files") render();
    }

    // ── Favourites section (above file list) ──────────────────────
    let favsSection = null;
    if (files.favourites.length > 0) {
      favsSection = document.createElement("div");
      favsSection.className = "wm-files-favourites";
      const favsLabel = document.createElement("span");
      favsLabel.className = "wm-files-favourites__label";
      favsLabel.textContent = "Favourites";
      favsSection.append(favsLabel);
      files.favourites.forEach((fav) => {
        const favItem = document.createElement("button");
        favItem.type = "button";
        favItem.className = "wm-files-favourites__item";
        const favIcon = createIconSvg(FILE_BROWSER_ICON_DEFS.starFilled);
        favIcon.classList.add("wm-files-favourites__star");
        const favName = document.createElement("span");
        favName.textContent = fav.name;
        favItem.append(favIcon, favName);
        favItem.addEventListener("click", () => {
          void loadFilesTree(fav.path);
        });
        const unstarBtn = document.createElement("button");
        unstarBtn.type = "button";
        unstarBtn.className = "wm-files-favourites__unstar";
        setIconButton(unstarBtn, "star", "Remove from favourites");
        unstarBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleFavourite(fav.path, fav.name);
        });
        const wrapper = document.createElement("div");
        wrapper.className = "wm-files-favourites__entry";
        wrapper.append(favItem, unstarBtn);
        favsSection.append(wrapper);
      });
    }

    if (files.error) {
      const item = document.createElement("li");
      item.className = "wm-files-browser__status";
      item.textContent = files.error;
      list.append(item);
    } else {
      const entries = Array.isArray(files.entries) ? files.entries : [];
      if (entries.length === 0 && !files.loading) {
        const empty = document.createElement("li");
        empty.className = "wm-files-browser__status";
        empty.textContent = "Directory is empty.";
        list.append(empty);
      }

      entries.forEach((entry) => {
        const item = document.createElement("li");
        item.className = "wm-files-browser__item";
        item.dataset.type = entry.type;
        if (entry.type === "file" && entry.path === files.previewPath) {
          item.dataset.selected = "true";
        }

        const button = document.createElement("button");
        button.type = "button";

        // ── Drag source: every entry is draggable ──
        button.draggable = true;
        button.addEventListener("dragstart", (e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", entry.path);
          e.dataTransfer.setData("application/x-wingman-name", entry.name);
        });

        const name = document.createElement("span");
        name.className = "wm-files-browser__name";
        const iconKey =
          entry.type === "directory"
            ? "folder"
            : entry.previewable
              ? getPreviewIconKey(entry.previewFormat)
              : "ban";
        const iconDefinition = FILE_BROWSER_ICON_DEFS[iconKey] ?? FILE_BROWSER_ICON_DEFS.file;
        const icon = createIconSvg(iconDefinition);
        const iconWrapper = document.createElement("span");
        iconWrapper.className = "wm-files-browser__icon";
        iconWrapper.setAttribute("aria-hidden", "true");
        iconWrapper.append(icon);
        const label = document.createElement("span");
        label.textContent = entry.name;
        name.append(iconWrapper, label);
        button.append(name);

        const meta = document.createElement("span");
        meta.className = "wm-files-browser__meta";
        if (entry.type === "directory") {
          meta.textContent = "Folder";
        } else if (entry.previewable) {
          meta.textContent = getPreviewMetaLabel(entry);
        } else {
          meta.textContent = "Preview unavailable";
        }
        button.append(meta);

        if (entry.type === "directory") {
          button.addEventListener("click", () => {
            if (files.loading) return;
            void loadFilesTree(entry.path);
          });

          // ── Drop target: folders accept dragged items ──
          item.addEventListener("dragover", handleDragOver);
          item.addEventListener("dragleave", handleDragLeave);
          item.addEventListener("drop", async (e) => {
            e.preventDefault();
            delete e.currentTarget.dataset.dragover;
            const sourcePath = e.dataTransfer.getData("text/plain");
            if (!sourcePath || sourcePath === entry.path) return;
            try {
              await moveFilesEntry(sourcePath, entry.path, null);
              await loadFilesTree(files.currentPath);
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Failed to move item";
              showToast(msg, { type: "error" });
            }
          });
        } else if (entry.previewable) {
          button.addEventListener("click", () => {
            if (files.previewPath !== entry.path || files.previewError) {
              void loadFilesPreview(entry.path);
            } else if (!files.previewLoading) {
              void loadFilesPreview(entry.path);
            }
          });
        } else {
          button.addEventListener("click", () => {
            showFilesPreviewUnavailable(entry);
          });
        }

        // Delete button (hover-reveal, all entries)
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "wm-files-browser__delete";
        setIconButton(deleteBtn, "trash", `Delete ${entry.type === "directory" ? "folder" : "file"}`);
        deleteBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const displayName = entry.name || entry.path;
          const confirmed = await openConfirmDialog({
            title: "Delete Entry",
            description: `Delete "${displayName}"? This cannot be undone.`,
            confirmLabel: "Delete",
            testId: "files-delete-entry-dialog",
          });
          if (!confirmed) return;
          deleteBtn.disabled = true;
          try {
            await deleteFilesEntry(entry.path);
            if (entry.path === files.previewPath) {
              resetFilesPreview();
            }
            await loadFilesTree(files.currentPath);
          } catch (err) {
            deleteBtn.disabled = false;
            const msg = err instanceof Error ? err.message : "Failed to delete";
            showToast(msg, { type: "error" });
          }
        });

        // Star toggle for folders
        if (entry.type === "directory") {
          const starred = isFavourite(entry.path);
          const starBtn = document.createElement("button");
          starBtn.type = "button";
          starBtn.className = "wm-files-browser__star" + (starred ? " wm-files-browser__star--active" : "");
          setIconButton(starBtn, starred ? "starFilled" : "star", starred ? "Remove from favourites" : "Add to favourites");
          starBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleFavourite(entry.path, entry.name);
          });
          item.append(button, starBtn, deleteBtn);
        } else {
          item.append(button, deleteBtn);
        }
        list.append(item);
      });

      if (files.uploading && !files.loading) {
        const uploadingItem = document.createElement("li");
        uploadingItem.className = "wm-files-browser__status";
        uploadingItem.textContent = "Uploading file\u2026";
        list.append(uploadingItem);
      }

      if (files.loading) {
        const loadingItem = document.createElement("li");
        loadingItem.className = "wm-files-browser__status";
        loadingItem.textContent = "Loading\u2026";
        list.append(loadingItem);
      }
    }

    if (favsSection) {
      browserCard.append(shelveButton, browserHeader, favsSection, list);
    } else {
      browserCard.append(shelveButton, browserHeader, list);
    }

    const previewCard = document.createElement("section");
    previewCard.className = "wm-card wm-files-preview";

    const previewHeader = document.createElement("div");
    previewHeader.className = "wm-files-preview__header";

    const previewTitle = document.createElement("h2");
    previewTitle.className = "wm-files-preview__title";
    previewTitle.textContent = files.previewName ?? "Preview";
    if (files.previewLabel) {
      const formatBadge = document.createElement("span");
      formatBadge.className = "wm-files-preview__badge";
      formatBadge.textContent = files.previewLabel;
      previewTitle.append(document.createTextNode(" "), formatBadge);
    }
    previewHeader.append(previewTitle);

    // ── Compact icon toolbar ────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.className = "wm-files-preview__toolbar";
    const hasFileSelection = typeof files.previewPath === "string" && !files.previewLoading;
    const isImagePreview = files.previewFormat === "image";
    const isPdfPreview = files.previewFormat === "pdf";
    const isJsonPreview = files.previewFormat === "json";
    const isCsvPreview = files.previewFormat === "csv";
    const isStructuredPreview = isJsonPreview || isCsvPreview;
    const isBinaryPreview = isImagePreview || isPdfPreview;
    const canEdit = hasFileSelection && !files.previewError && !isBinaryPreview && files.previewContent !== null;
    const canUseWriter = canEdit && !isStructuredPreview;

    /** Helper: create a small icon button for the toolbar */
    function toolbarButton(iconKey, label, extraClass) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wm-files-toolbar-btn" + (extraClass ? " " + extraClass : "");
      setIconButton(btn, iconKey, label);
      return btn;
    }

    // Copy file path
    const copyablePath = files.previewDisplayPath || files.previewPath || null;
    if (copyablePath) {
      const copyPathBtn = toolbarButton("clipboardCopy", "Copy file path");
      copyPathBtn.addEventListener("click", async () => {
        const success = await copyTextToClipboard(copyablePath);
        if (success) {
          copyPathBtn.dataset.copied = "true";
          setTimeout(() => { if (copyPathBtn.isConnected) delete copyPathBtn.dataset.copied; }, 1600);
        }
      });
      toolbar.append(copyPathBtn);
    }

    // Edit file
    if (canEdit) {
      const editBtn = toolbarButton("pencil", "Edit file");
      editBtn.addEventListener("click", () => {
        void openFileEditor(files.previewPath, files.previewDisplayPath ?? null, files.previewName ?? null);
      });
      toolbar.append(editBtn);
    }

    // Writer
    if (canUseWriter) {
      const writerBtn = toolbarButton("penTool", "Writer");
      writerBtn.addEventListener("click", () => {
        const config = typeof getConfig === "function" ? getConfig() : null;
        const agents = config?.agents ?? [];
        if (agents.length === 0) {
          showToast("No agents available.", { type: "warning" });
          return;
        }
        showQuickAgentPicker(writerBtn, agents, (agentId) => {
          if (typeof launchSession === "function") {
            launchSession(agentId, files.currentPath, files.previewName ?? "", null, {
              targetFile: files.previewPath,
            });
          }
        });
      });
      toolbar.append(writerBtn);
    }

    if (hasFileSelection) {
      if (isPdfPreview) {
        const openPdfBtn = toolbarButton("link", "Open PDF in browser");
        openPdfBtn.dataset.testid = "files-open-pdf-toolbar-button";
        openPdfBtn.addEventListener("click", () => {
          const targetPath = typeof files.previewPath === "string" ? files.previewPath : null;
          if (!targetPath) return;
          window.open(buildDocsFileDownloadUrl(targetPath, { inline: true }), "_blank", "noopener");
        });
        toolbar.append(openPdfBtn);
      }

      // Download
      const downloadBtn = toolbarButton("download", "Download file");
      downloadBtn.dataset.testid = "files-download-button";
      downloadBtn.addEventListener("click", () => {
        const targetPath = typeof files.previewPath === "string" ? files.previewPath : null;
        if (!targetPath) return;
        const downloadUrl = buildDocsFileDownloadUrl(targetPath);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = files.previewName || "";
        a.style.display = "none";
        document.body.append(a);
        a.click();
        a.remove();
      });
      toolbar.append(downloadBtn);

      // Copy URL
      const copyUrlBtn = toolbarButton("link", "Copy URL");
      copyUrlBtn.addEventListener("click", async () => {
        const targetPath = typeof files.previewPath === "string" ? files.previewPath : null;
        if (!targetPath) return;
        const rawPath = isImagePreview || isPdfPreview
          ? buildDocsFileDownloadUrl(targetPath, { inline: true })
          : buildDocsRawUrl(targetPath);
        const rawUrl = `${window.location.origin}${rawPath}`;
        const success = await copyTextToClipboard(rawUrl);
        if (success) {
          copyUrlBtn.dataset.copied = "true";
          setTimeout(() => { if (copyUrlBtn.isConnected) delete copyUrlBtn.dataset.copied; }, 1600);
        } else {
          showToast("Unable to copy the file URL.", { type: "error" });
        }
      });
      toolbar.append(copyUrlBtn);

      // Copy file to…
      const copyToBtn = toolbarButton("clipboardCopy", "Copy file to\u2026");
      copyToBtn.addEventListener("click", () => {
        void openFileTransferDialogForMode("copy");
      });
      toolbar.append(copyToBtn);

      // Move file to…
      const moveToBtn = toolbarButton("arrowRightCircle", "Move file to\u2026");
      moveToBtn.addEventListener("click", () => {
        void openFileTransferDialogForMode("move");
      });
      toolbar.append(moveToBtn);

      // Delete — red destructive
      const deleteBtn = toolbarButton("trash", "Delete file", "wm-files-toolbar-btn--danger");
      deleteBtn.addEventListener("click", async () => {
        const targetPath = typeof files.previewPath === "string" ? files.previewPath : null;
        if (!targetPath) return;
        const displayName = files.previewName ?? files.previewDisplayPath ?? targetPath;
        const confirmed = await openConfirmDialog({
          title: "Delete File",
          description: `Delete "${displayName}"? This cannot be undone.`,
          confirmLabel: "Delete",
          testId: "files-delete-preview-dialog",
        });
        if (!confirmed) return;
        deleteBtn.disabled = true;
        deleteBtn.dataset.loading = "true";
        try {
          await deleteFilesEntry(targetPath);
          resetFilesPreview();
          render();
          await loadFilesTree(state.files.currentPath);
        } catch (error) {
          deleteBtn.disabled = false;
          delete deleteBtn.dataset.loading;
          const message = error instanceof Error ? error.message : "Failed to delete file";
          showToast(message, { type: "error" });
        }
      });
      toolbar.append(deleteBtn);
    }

    if (toolbar.childElementCount > 0) {
      previewHeader.append(toolbar);
    }

    const previewBody = document.createElement("div");
    previewBody.className = "wm-files-preview__body";

    // Clean up stale writer panel when file changes or view state changes
    const shouldHaveWriter = canUseWriter;
    if (activeFileWriter && (!shouldHaveWriter || activeFileWriter.path !== files.previewPath)) {
      activeFileWriter.cleanup();
      activeFileWriter = null;
    }

    if (files.previewLoading) {
      previewBody.dataset.loading = "true";
      previewBody.textContent = "Loading preview\u2026";
    } else if (files.previewError) {
      const error = document.createElement("div");
      error.className = "wm-files-browser__status";
      error.textContent = files.previewError;
      previewBody.append(error);
    } else if (isImagePreview && files.previewPath) {
      previewBody.append(createImagePreviewElement(files));
    } else if (isPdfPreview && files.previewPath) {
      previewBody.append(createPdfPreview(files, (path) => buildDocsFileDownloadUrl(path, { inline: true })));
    } else if (isJsonPreview && files.previewContent !== null) {
      previewBody.append(createJsonPreview(files.previewContent));
    } else if (isCsvPreview && files.previewContent !== null) {
      previewBody.append(createCsvPreview(files.previewContent, files.previewLanguage));
    } else if (files.previewContent !== null) {
      // Reuse existing writer panel if same file, otherwise create a new one
      if (activeFileWriter && activeFileWriter.path === files.previewPath) {
        previewBody.append(activeFileWriter.panel);
      } else {
        const { panel: writerEl, cleanup } = createFileEditingPanel(null, files.previewPath, { showToast });
        activeFileWriter = { path: files.previewPath, panel: writerEl, cleanup };
        previewBody.append(writerEl);
      }
    } else {
      previewBody.dataset.empty = "true";
      previewBody.textContent = "Select a previewable file to view.";
    }

    previewCard.append(previewHeader, previewBody);

    // Shelve/unshelve: hide browser card and show floating unshelve button
    if (files.browserShelved) {
      browserCard.style.display = "none";
      const unshelveButton = document.createElement("button");
      unshelveButton.type = "button";
      unshelveButton.className = "wm-button secondary wm-button-icon wm-files-unshelve";
      setIconButton(unshelveButton, "sidebarOpen", "Expand sidebar");
      unshelveButton.addEventListener("click", () => {
        files.browserShelved = false;
        try {
          localStorage.setItem(FILES_BROWSER_SHELVED_STORAGE_KEY, "false");
        } catch { /* ignore */ }
        if (getCurrentRoute() === "files") render();
      });
      previewCard.prepend(unshelveButton);
    }

    layout.append(browserCard, previewCard);
    wrapper.append(pageHeader, layout);
    return wrapper;
  };

  return { renderFiles };
}
