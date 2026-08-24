/**
 * Directory browser and file transfer dialog.
 *
 * Handles directory autocomplete suggestions, the directory browser modal,
 * and the file move/copy transfer dialog. Also binds all associated DOM
 * event listeners so callers only interact via the returned public API.
 *
 * Depends on: state, various DOM elements (via DI), API helpers.
 */
import { openTextPromptDialog } from "../common/dialog-prompts.js";
import { showDialogElement } from "../common/dialog-element.js";

export function initDirectoryBrowser(deps) {
  const {
    state,
    // DOM — directory browser
    directoryInput,
    directorySuggestions,
    directoryDialog,
    directoryTitle,
    directoryList,
    directoryCurrent,
    directoryUpButton,
    directoryNewFolderButton,
    directoryUseButton,
    browseDirectoryButton,
    // DOM — file transfer
    fileTransferDialog,
    fileTransferTitle,
    fileTransferSource,
    fileTransferCurrent,
    fileTransferList,
    fileTransferSelected,
    fileTransferNameInput,
    fileTransferNameFeedback,
    fileTransferUpButton,
    fileTransferNewFolderButton,
    fileTransferConfirmButton,
    fileTransferCancelButton,
    // API functions
    createDirectoryEntry,
    moveFilesEntry,
    copyFilesEntry,
    resetFilesPreview,
    loadFilesTree,
    fetchConfig,
    getSessionDialogController,
    showToast,
  } = deps;

  // ── constants and internal state ──────────────────────────────────

  const DIRECTORY_SUGGESTION_DELAY = 160;
  const DIRECTORY_BROWSER_ROOT = "__root__";
  const DIRECTORY_BROWSER_ROOT_LABEL = "Allowed Directories";
  const FILE_TRANSFER_NAME_MAX_LENGTH = 200;

  let directorySuggestionTimer = null;
  let directorySuggestionRequestId = 0;

  const directoryBrowserState = {
    currentPath: "",
    parent: null,
    requestId: 0,
    onSelect: null,
    allowCreate: true,
    confirmLabel: "Use This Directory",
    title: "Select Directory",
    pendingResolve: null,
  };

  // ── directory suggestion helpers ──────────────────────────────────

  const parseDirectoryLookup = (rawValue) => {
    const defaultPath = state.config?.defaultDirectory ?? "";
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!value) {
      return { basePath: defaultPath, term: "" };
    }

    const hasTrailingSeparator = /[\\/]$/.test(value);
    if (hasTrailingSeparator) {
      return { basePath: value, term: "" };
    }

    const lastForward = value.lastIndexOf("/");
    const lastBackward = value.lastIndexOf("\\");
    const separatorIndex = Math.max(lastForward, lastBackward);

    if (separatorIndex === -1) {
      return { basePath: defaultPath, term: value };
    }

    return {
      basePath: value.slice(0, separatorIndex + 1),
      term: value.slice(separatorIndex + 1),
    };
  };

  const requestDirectoryData = async (path, query) => {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (query) params.set("query", query);
    const search = params.toString();
    const url = search ? `/api/directories?${search}` : "/api/directories";
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }
      return await response.json();
    } catch (error) {
      console.error("Failed to request directory data", error);
      return null;
    }
  };

  const fetchDocsDirectoryListing = async (path) => {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (state.files.showHidden) {
      params.set("showHidden", "1");
    }
    const response = await fetch(`/api/docs/tree?${params.toString()}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = data?.error ?? response.statusText ?? "Failed to load directory";
      throw new Error(message);
    }
    const payload = await response.json();
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    return {
      path: payload?.path ?? path ?? "",
      displayPath: payload?.displayPath ?? payload?.path ?? "",
      parent: payload?.parent ?? null,
      directories: entries.filter((entry) => entry?.type === "directory"),
    };
  };

  const populateDirectorySuggestions = (data) => {
    if (!directorySuggestions) return;
    directorySuggestions.innerHTML = "";
    if (!data) return;

    const seen = new Set();
    const addOption = (value) => {
      if (!value || seen.has(value)) return;
      seen.add(value);
      const option = document.createElement("option");
      option.value = value;
      directorySuggestions.append(option);
    };

    addOption(data.path);
    data.entries.forEach((entry) => addOption(entry.path));
  };

  const fetchDirectorySuggestions = async (value) => {
    if (!state.config) return;
    const requestId = ++directorySuggestionRequestId;
    const { basePath, term } = parseDirectoryLookup(value);
    let data = await requestDirectoryData(basePath, term);
    if (!data && basePath !== state.config.defaultDirectory) {
      data = await requestDirectoryData(state.config.defaultDirectory, term);
    }
    if (directorySuggestionRequestId !== requestId) return;
    populateDirectorySuggestions(data);
  };

  function scheduleDirectorySuggestions(value) {
    if (!directorySuggestions) return;
    if (directorySuggestionTimer) {
      clearTimeout(directorySuggestionTimer);
    }
    directorySuggestionTimer = setTimeout(() => {
      fetchDirectorySuggestions(value);
    }, DIRECTORY_SUGGESTION_DELAY);
  }

  // ── directory browser ─────────────────────────────────────────────

  const chooseDirectory = (path) => {
    if (typeof path !== "string" || path.length === 0) return;
    const selected = path;
    const onSelect = directoryBrowserState.onSelect;
    if (typeof onSelect === "function") {
      onSelect(selected);
    } else if (directoryInput) {
      directoryInput.value = selected;
      state.lastWorkingDirectory = selected;
      scheduleDirectorySuggestions(selected);
    }
    getSessionDialogController()?.syncWorktreeHint?.();
    directoryBrowserState.onSelect = null;
    if (directoryBrowserState.pendingResolve) {
      const resolve = directoryBrowserState.pendingResolve;
      directoryBrowserState.pendingResolve = null;
      resolve(selected);
    }
    if (directoryDialog?.open) {
      directoryDialog.close();
    }
  };

  const renderDirectoryBrowser = (data) => {
    if (!data) return;
    const isRootView = !data.path || data.path === DIRECTORY_BROWSER_ROOT;
    if (directoryCurrent) {
      const label = isRootView ? DIRECTORY_BROWSER_ROOT_LABEL : data.path;
      directoryCurrent.textContent = label;
    }
    if (directoryUpButton) {
      directoryUpButton.disabled = !data.parent;
    }
    if (directoryUseButton) {
      directoryUseButton.disabled = !(data.path && data.path.length > 0);
    }
    if (directoryNewFolderButton) {
      if (directoryBrowserState.allowCreate) {
        directoryNewFolderButton.hidden = false;
        directoryNewFolderButton.disabled = !data.path;
      } else {
        directoryNewFolderButton.hidden = true;
        directoryNewFolderButton.disabled = true;
      }
    }
    if (!directoryList) return;
    directoryList.innerHTML = "";
    if (!Array.isArray(data.entries) || data.entries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "directory-browser__empty";
      empty.textContent = "No subdirectories";
      directoryList.append(empty);
      return;
    }
    data.entries.forEach((entry) => {
      const item = document.createElement("li");
      item.className = "directory-browser__item";

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "directory-browser__folder";
      openButton.textContent = entry.name;
      openButton.addEventListener("click", () => {
        updateDirectoryBrowser(entry.path);
      });

      const selectButton = document.createElement("button");
      selectButton.type = "button";
      selectButton.className = "directory-browser__choose wm-button secondary";
      selectButton.textContent = "Select";
      selectButton.addEventListener("click", () => {
        chooseDirectory(entry.path);
      });

      item.append(openButton, selectButton);
      directoryList.append(item);
    });
  };

  const updateDirectoryBrowser = async (path) => {
    if (!state.config) return false;
    const requestId = ++directoryBrowserState.requestId;
    let data = await requestDirectoryData(path, undefined);
    if (!data && path && path !== state.config.defaultDirectory) {
      data = await requestDirectoryData(state.config.defaultDirectory, undefined);
    }
    if (directoryBrowserState.requestId !== requestId || !data) {
      return false;
    }
    directoryBrowserState.currentPath = typeof data.path === "string" ? data.path : "";
    directoryBrowserState.parent = data.parent;
    renderDirectoryBrowser(data);
    return true;
  };

  async function openDirectoryBrowser(options = {}) {
    if (!state.config) {
      try {
        await fetchConfig();
      } catch {
        // ignore config fetch failures; fallback prompt handles it
      }
    }

    const {
      initialPath,
      onSelect,
      allowCreate = true,
      confirmLabel = "Use This Directory",
      title = "Select Directory",
    } = options;

    const seedCandidate =
      (typeof initialPath === "string" && initialPath.trim().length > 0 ? initialPath.trim() : null) ??
      directoryInput?.value?.trim() ??
      state.lastWorkingDirectory ??
      state.config?.defaultDirectory ??
      "";

    directoryBrowserState.onSelect = typeof onSelect === "function" ? onSelect : null;
    directoryBrowserState.allowCreate = allowCreate;
    directoryBrowserState.confirmLabel = confirmLabel;
    directoryBrowserState.title = title;

    if (!directoryDialog) {
      const fallback = await openTextPromptDialog({
        title,
        description: "Enter the directory path to use.",
        label: "Directory path",
        value: seedCandidate,
        confirmLabel: "Use Directory",
        testId: "directory-browser-manual-path-dialog",
        validate: (value) => (value ? "" : "Directory path is required."),
      });
      if (fallback) {
        chooseDirectory(fallback);
      }
      return null;
    }

    if (directoryTitle) {
      directoryTitle.textContent = title;
    }
    if (directoryUseButton) {
      directoryUseButton.textContent = confirmLabel;
    }
    if (directoryNewFolderButton) {
      directoryNewFolderButton.hidden = !allowCreate;
      directoryNewFolderButton.disabled = !allowCreate;
    }

    if (directoryBrowserState.pendingResolve) {
      directoryBrowserState.pendingResolve(null);
      directoryBrowserState.pendingResolve = null;
    }

    const loaded = await updateDirectoryBrowser(seedCandidate);
    if (!loaded) {
      showToast("Unable to open directory browser for the requested path.", { type: "error" });
      directoryBrowserState.onSelect = null;
      return null;
    }

    showDialogElement(directoryDialog);
    return new Promise((resolve) => {
      directoryBrowserState.pendingResolve = resolve;
    });
  }

  // ── file helpers ──────────────────────────────────────────────────

  const promptCreateDirectoryAtPath = async (parentPath, { onSuccess } = {}) => {
    const basePath = typeof parentPath === "string" && parentPath.length > 0 ? parentPath : null;
    if (!basePath) {
      showToast("Select a parent directory first.", { type: "warning" });
      return false;
    }
    const trimmed = await openTextPromptDialog({
      title: "Create Folder",
      description: "Add a new folder inside the selected directory.",
      label: "Folder name",
      value: "New Folder",
      confirmLabel: "Create",
      testId: "directory-browser-create-folder-dialog",
      validate: (value) => (value ? "" : "Folder name cannot be empty."),
    });
    if (!trimmed) {
      return false;
    }
    try {
      const result = await createDirectoryEntry(basePath, trimmed);
      if (typeof onSuccess === "function") {
        await Promise.resolve(onSuccess(result));
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create folder";
      showToast(message, { type: "error" });
      return false;
    }
  };

  const getParentDirectoryPath = (filePath) => {
    if (typeof filePath !== "string" || filePath.length === 0) {
      return null;
    }
    const normalized = filePath.replace(/\\/g, "/");
    const index = normalized.lastIndexOf("/");
    if (index <= 0) {
      return null;
    }
    const prefix = normalized.slice(0, index);
    if (filePath.includes("\\")) {
      const backslashIndex = filePath.lastIndexOf("\\");
      if (backslashIndex > index) {
        return filePath.slice(0, backslashIndex);
      }
      return filePath.slice(0, index);
    }
    return filePath.slice(0, index);
  };

  // ── file transfer ─────────────────────────────────────────────────

  const applyFileTransferNameInput = (rawValue) => {
    const transfer = state.files.transfer;
    const value = typeof rawValue === "string" ? rawValue : "";
    transfer.destinationNameInput = value;
    const trimmed = value.trim();
    let error = null;
    let normalized = null;
    if (trimmed.length > 0) {
      if (trimmed.length > FILE_TRANSFER_NAME_MAX_LENGTH) {
        error = "File name is too long";
      } else if (trimmed === "." || trimmed === "..") {
        error = "File name is not allowed";
      } else if (/[\\/]/.test(trimmed)) {
        error = "File name cannot contain path separators";
      } else {
        normalized = trimmed;
      }
    }
    transfer.destinationName = normalized;
    transfer.nameError = error;
    if (fileTransferNameFeedback) {
      if (error) {
        fileTransferNameFeedback.textContent = error;
        fileTransferNameFeedback.hidden = false;
      } else {
        fileTransferNameFeedback.textContent = "";
        fileTransferNameFeedback.hidden = true;
      }
    }
    if (fileTransferNameInput) {
      if (error) {
        fileTransferNameInput.setAttribute("aria-invalid", "true");
      } else {
        fileTransferNameInput.removeAttribute("aria-invalid");
      }
    }
    syncFileTransferConfirmState();
  };

  const resetFileTransferState = () => {
    const transfer = state.files.transfer;
    transfer.mode = null;
    transfer.sourcePath = null;
    transfer.sourceName = null;
    transfer.sourceDisplayPath = null;
    transfer.destinationPath = null;
    transfer.destinationDisplayPath = null;
    transfer.destinationName = null;
    transfer.destinationNameInput = "";
    transfer.nameError = null;
    transfer.submitting = false;
    transfer.error = null;
    transfer.browser.currentPath = "";
    transfer.browser.parent = null;
    transfer.browser.selection = null;
    transfer.browser.requestId = 0;
    if (fileTransferList) {
      fileTransferList.innerHTML = "";
    }
    if (fileTransferSelected) {
      fileTransferSelected.textContent = "";
    }
    if (fileTransferNameInput) {
      fileTransferNameInput.value = "";
      fileTransferNameInput.placeholder = "";
      fileTransferNameInput.removeAttribute("aria-invalid");
    }
    if (fileTransferNameFeedback) {
      fileTransferNameFeedback.textContent = "";
      fileTransferNameFeedback.hidden = true;
    }
    if (fileTransferNewFolderButton) {
      fileTransferNewFolderButton.disabled = true;
    }
    syncFileTransferConfirmState();
  };

  const syncFileTransferConfirmState = () => {
    if (!fileTransferConfirmButton) return;
    const transfer = state.files.transfer;
    const mode = transfer.mode;
    if (!mode) {
      fileTransferConfirmButton.disabled = true;
      delete fileTransferConfirmButton.dataset.loading;
      fileTransferConfirmButton.textContent = "Confirm";
      return;
    }
    const disabled = transfer.submitting || !transfer.destinationPath || Boolean(transfer.nameError);
    fileTransferConfirmButton.disabled = disabled;
    if (transfer.submitting) {
      fileTransferConfirmButton.dataset.loading = "true";
    } else {
      delete fileTransferConfirmButton.dataset.loading;
    }
    if (transfer.submitting) {
      fileTransferConfirmButton.textContent = mode === "move" ? "Moving\u2026" : "Copying\u2026";
    } else {
      fileTransferConfirmButton.textContent = mode === "move" ? "Move Here" : "Copy Here";
    }
  };

  const setFileTransferSelection = (path, displayPath) => {
    const transfer = state.files.transfer;
    transfer.destinationPath = typeof path === "string" && path.length > 0 ? path : null;
    transfer.browser.selection = transfer.destinationPath;
    transfer.destinationDisplayPath =
      transfer.destinationPath && typeof displayPath === "string" && displayPath.length > 0
        ? displayPath
        : transfer.destinationPath;
    if (fileTransferSelected) {
      if (transfer.destinationDisplayPath) {
        fileTransferSelected.textContent = `Destination: ${transfer.destinationDisplayPath}`;
      } else {
        fileTransferSelected.textContent = "";
      }
    }
    if (fileTransferList) {
      fileTransferList.querySelectorAll(".directory-browser__item").forEach((item) => {
        if (!(item instanceof HTMLElement)) return;
        const itemPath = item.dataset.path;
        if (itemPath && transfer.destinationPath && itemPath === transfer.destinationPath) {
          item.dataset.selected = "true";
        } else {
          delete item.dataset.selected;
        }
      });
    }
    syncFileTransferConfirmState();
  };

  const renderFileTransferBrowser = (data) => {
    if (!data) return;
    const transfer = state.files.transfer;
    transfer.browser.currentPath = data.path ?? "";
    transfer.browser.parent = typeof data.parent?.path === "string" ? data.parent.path : null;

    if (fileTransferCurrent) {
      fileTransferCurrent.textContent = data.displayPath ?? data.path ?? "";
    }
    if (fileTransferUpButton) {
      fileTransferUpButton.disabled = !transfer.browser.parent;
    }
    if (fileTransferNewFolderButton) {
      fileTransferNewFolderButton.disabled = !(data.path && data.path.length > 0);
    }
    if (!fileTransferList) return;
    fileTransferList.innerHTML = "";

    const directories = Array.isArray(data.directories) ? data.directories : [];
    if (directories.length === 0) {
      const empty = document.createElement("li");
      empty.className = "directory-browser__empty";
      empty.textContent = "No subdirectories";
      fileTransferList.append(empty);
    } else {
      directories.forEach((entry) => {
        const item = document.createElement("li");
        item.className = "directory-browser__item";
        item.dataset.path = entry.path;
        item.dataset.displayPath = entry.displayPath ?? entry.path ?? "";

        const openButton = document.createElement("button");
        openButton.type = "button";
        openButton.className = "directory-browser__folder";
        openButton.textContent = entry.name;
        openButton.addEventListener("click", () => {
          void updateFileTransferBrowser(entry.path);
        });

        const chooseButton = document.createElement("button");
        chooseButton.type = "button";
        chooseButton.className = "wm-button secondary directory-browser__choose";
        chooseButton.textContent = "Select";
        chooseButton.addEventListener("click", () => {
          setFileTransferSelection(entry.path, entry.displayPath ?? entry.path ?? "");
        });

        item.append(openButton, chooseButton);
        fileTransferList.append(item);
      });
    }

    if (!transfer.destinationPath || transfer.destinationPath === transfer.browser.currentPath) {
      setFileTransferSelection(data.path ?? transfer.browser.currentPath, data.displayPath ?? data.path ?? "");
    } else {
      setFileTransferSelection(transfer.destinationPath, transfer.destinationDisplayPath);
    }
  };

  const updateFileTransferBrowser = async (path) => {
    const transfer = state.files.transfer;
    const requestId = ++transfer.browser.requestId;
    try {
      const data = await fetchDocsDirectoryListing(path);
      if (transfer.browser.requestId !== requestId) {
        return false;
      }
      renderFileTransferBrowser(data);
      return true;
    } catch (error) {
      if (transfer.browser.requestId === requestId) {
        const message = error instanceof Error ? error.message : "Failed to load directories";
        showToast(message, { type: "error" });
      }
      return false;
    }
  };

  const closeFileTransferDialog = () => {
    if (fileTransferDialog?.open) {
      fileTransferDialog.close();
    }
    resetFileTransferState();
    syncFileTransferConfirmState();
  };

  async function openFileTransferDialogForMode(mode) {
    if (!fileTransferDialog) return;
    if (mode !== "copy" && mode !== "move") return;
    const files = state.files;
    const sourcePath = typeof files.previewPath === "string" ? files.previewPath : null;
    if (!sourcePath || files.previewLoading) {
      return;
    }

    const transfer = state.files.transfer;
    transfer.mode = mode;
    transfer.sourcePath = sourcePath;
    transfer.sourceName =
      files.previewName ??
      (typeof sourcePath === "string" ? sourcePath.split(/[\\/]/).pop() ?? sourcePath : sourcePath);
    transfer.sourceDisplayPath =
      files.previewDisplayPath ?? files.previewName ?? transfer.sourceName ?? sourcePath;
    transfer.submitting = false;
    transfer.error = null;
    transfer.destinationPath = files.currentPath ?? getParentDirectoryPath(sourcePath);
    transfer.destinationDisplayPath = files.displayPath ?? transfer.destinationPath;

    const defaultName = transfer.sourceName ?? "";
    transfer.destinationNameInput = defaultName;
    applyFileTransferNameInput(defaultName);
    if (fileTransferNameInput) {
      fileTransferNameInput.value = defaultName;
      fileTransferNameInput.placeholder = transfer.sourceName ?? "";
      const focusInput = () => {
        if (fileTransferNameInput?.isConnected) {
          fileTransferNameInput.focus();
          try {
            const length = fileTransferNameInput.value.length;
            fileTransferNameInput.setSelectionRange(0, length);
          } catch {
            // ignore selection errors on unsupported inputs
          }
        }
      };
      if (typeof queueMicrotask === "function") {
        queueMicrotask(focusInput);
      } else {
        setTimeout(focusInput, 0);
      }
    }

    if (fileTransferTitle) {
      fileTransferTitle.textContent = mode === "move" ? "Move File To\u2026" : "Copy File To\u2026";
    }
    if (fileTransferSource) {
      fileTransferSource.textContent = transfer.sourceDisplayPath ?? transfer.sourcePath ?? "";
    }
    if (fileTransferList) {
      fileTransferList.innerHTML = "";
      const loading = document.createElement("li");
      loading.className = "directory-browser__status";
      loading.textContent = "Loading directories\u2026";
      fileTransferList.append(loading);
    }
    syncFileTransferConfirmState();
    if (!fileTransferDialog.open) {
      fileTransferDialog.showModal();
    }
    const initialPath =
      transfer.destinationPath ??
      files.currentPath ??
      getParentDirectoryPath(sourcePath) ??
      sourcePath;
    await updateFileTransferBrowser(initialPath);
  }

  const submitFileTransfer = async () => {
    const transfer = state.files.transfer;
    if (!transfer.mode || transfer.submitting) return;
    if (!transfer.sourcePath || !transfer.destinationPath) {
      showToast("Select a destination directory first.", { type: "warning" });
      return;
    }
    if (transfer.nameError) {
      showToast(transfer.nameError, { type: "warning" });
      return;
    }
    const sourcePath = transfer.sourcePath;
    const mode = transfer.mode;
    const destinationName = transfer.destinationName;
    transfer.submitting = true;
    syncFileTransferConfirmState();
    try {
      if (mode === "move") {
        await moveFilesEntry(transfer.sourcePath, transfer.destinationPath, destinationName ?? null);
      } else {
        await copyFilesEntry(transfer.sourcePath, transfer.destinationPath, destinationName ?? null);
      }
      const refreshPath = state.files.currentPath;
      const moved = mode === "move";
      closeFileTransferDialog();
      if (moved && state.files.previewPath === sourcePath) {
        resetFilesPreview();
      }
      await loadFilesTree(refreshPath);
    } catch (error) {
      transfer.submitting = false;
      syncFileTransferConfirmState();
      const message = error instanceof Error ? error.message : "File operation failed";
      showToast(message, { type: "error" });
    }
  };

  // ── bind event listeners ──────────────────────────────────────────

  // Directory input autocomplete
  if (directoryInput) {
    directoryInput.addEventListener("input", (event) => {
      scheduleDirectorySuggestions(event.target.value);
    });
    directoryInput.addEventListener("focus", () => {
      scheduleDirectorySuggestions(directoryInput.value);
    });
  }

  // "Browse" button opens directory browser
  browseDirectoryButton?.addEventListener("click", (event) => {
    event.preventDefault();
    const seed =
      directoryInput?.value?.trim() ||
      state.lastWorkingDirectory ||
      state.config?.defaultDirectory ||
      "";
    void openDirectoryBrowser({
      initialPath: seed,
      title: "Select Working Directory",
      confirmLabel: "Use This Directory",
      allowCreate: true,
      onSelect: (path) => {
        if (!directoryInput) return;
        directoryInput.value = path;
        state.lastWorkingDirectory = path;
        scheduleDirectorySuggestions(path);
      },
    });
  });

  // Directory browser navigation
  directoryUpButton?.addEventListener("click", (event) => {
    event.preventDefault();
    if (directoryBrowserState.parent) {
      updateDirectoryBrowser(directoryBrowserState.parent);
    }
  });

  directoryNewFolderButton?.addEventListener("click", async (event) => {
    event.preventDefault();
    if (!directoryBrowserState.allowCreate) return;
    const parentPath = directoryBrowserState.currentPath || directoryBrowserState.parent || state.config?.defaultDirectory || "";
    if (!parentPath) {
      showToast("Select a directory first.", { type: "warning" });
      return;
    }
    await promptCreateDirectoryAtPath(parentPath, {
      onSuccess: async () => {
        await updateDirectoryBrowser(parentPath);
      },
    });
  });

  directoryUseButton?.addEventListener("click", (event) => {
    event.preventDefault();
    if (directoryBrowserState.currentPath) {
      chooseDirectory(directoryBrowserState.currentPath);
    }
  });

  // Directory dialog cancel/close
  if (directoryDialog) {
    directoryDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      directoryDialog.close();
    });
    directoryDialog.addEventListener("close", () => {
      directoryBrowserState.requestId += 1;
      if (directoryBrowserState.pendingResolve) {
        const resolve = directoryBrowserState.pendingResolve;
        directoryBrowserState.pendingResolve = null;
        resolve(null);
      }
      directoryBrowserState.onSelect = null;
      directoryBrowserState.allowCreate = true;
      directoryBrowserState.confirmLabel = "Use This Directory";
      directoryBrowserState.title = "Select Directory";
    });
  }

  // File transfer dialog buttons
  fileTransferCancelButton?.addEventListener("click", (event) => {
    event.preventDefault();
    closeFileTransferDialog();
  });

  fileTransferDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeFileTransferDialog();
  });

  fileTransferDialog?.addEventListener("close", () => {
    resetFileTransferState();
    syncFileTransferConfirmState();
  });

  fileTransferNameInput?.addEventListener("input", (event) => {
    applyFileTransferNameInput(event.currentTarget?.value ?? "");
  });

  fileTransferUpButton?.addEventListener("click", (event) => {
    event.preventDefault();
    const parent = state.files.transfer.browser.parent;
    if (parent) {
      void updateFileTransferBrowser(parent);
    }
  });

  fileTransferNewFolderButton?.addEventListener("click", async (event) => {
    event.preventDefault();
    const parent =
      state.files.transfer.browser.currentPath ||
      state.files.transfer.browser.parent ||
      state.files.currentPath ||
      "";
    if (!parent) {
      showToast("Select a directory first.", { type: "warning" });
      return;
    }
    await promptCreateDirectoryAtPath(parent, {
      onSuccess: async (result) => {
        await updateFileTransferBrowser(parent);
        if (result?.path) {
          setFileTransferSelection(result.path, result?.displayPath ?? result.path);
        }
      },
    });
  });

  fileTransferConfirmButton?.addEventListener("click", async (event) => {
    event.preventDefault();
    await submitFileTransfer();
  });

  // ── public API ────────────────────────────────────────────────────

  return {
    scheduleDirectorySuggestions,
    openDirectoryBrowser,
    openFileTransferDialogForMode,
  };
}
