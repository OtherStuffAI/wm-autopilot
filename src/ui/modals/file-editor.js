/**
 * File editor overlay + worktree modal.
 *
 * Encapsulates Ace editor lifecycle, file load/save, and worktree creation.
 */

import {
  decodeBase64ToUint8Array,
  encodeUint8ArrayToBase64,
  decodeBytesToText,
  encodeTextToBytes,
} from "../core/encoding.js";
import { openConfirmDialog } from "../common/dialog-prompts.js";

/**
 * @param {object} deps
 * @param {object}            deps.state          - global UI state (reads .files, .fileEditor)
 * @param {function}          deps.render         - top-level render dispatcher
 * @param {function}          deps.loadFilesTree  - reloads the file browser tree
 * @param {function}          deps.applyAceTheme  - applies light/dark theme to ace
 * @param {HTMLElement}       deps.appRoot        - root DOM node to append overlays
 * @param {function}          deps.loadAceEditor  - async function that lazy-loads and returns the ace editor factory
 */
export function initFileEditor(deps) {
  const { state, render, loadFilesTree, applyAceTheme, appRoot, loadAceEditor } = deps;

  let aceEditorInstance = null;

  // ── Worktree helpers ──────────────────────────────────────────────

  const getWorktreeGitInfo = () => {
    const git = state.files.git;
    if (!git || typeof git !== "object") return null;
    return git;
  };

  const canCreateWorktree = () => {
    const git = getWorktreeGitInfo();
    if (!git) return false;
    return Boolean(git.isRepoRoot && git.hasGitMetadata);
  };

  const resetWorktreeModalState = (defaults = {}) => {
    const modal = state.files.worktreeModal;
    modal.branch = typeof defaults.branch === "string" ? defaults.branch : "";
    modal.startPoint = typeof defaults.startPoint === "string" ? defaults.startPoint : "";
    modal.error = null;
    modal.submitting = false;
  };

  const openWorktreeModal = () => {
    if (!canCreateWorktree()) return;
    const git = getWorktreeGitInfo();
    const modal = state.files.worktreeModal;
    resetWorktreeModalState({
      branch: "",
      startPoint: git?.currentBranch && git.currentBranch !== "HEAD" ? git.currentBranch : git?.headRef ?? "",
    });
    modal.open = true;
    renderWorktreeModal();
  };

  const closeWorktreeModal = () => {
    const modal = state.files.worktreeModal;
    if (!modal.open) return;
    modal.open = false;
    resetWorktreeModalState();
    renderWorktreeModal();
  };

  const requestCreateWorktree = async () => {
    const files = state.files;
    const git = getWorktreeGitInfo();
    if (!git) return;
    const modal = files.worktreeModal;
    const branch = modal.branch.trim();
    if (!branch) {
      modal.error = "Branch name is required";
      renderWorktreeModal();
      return;
    }

    modal.submitting = true;
    modal.error = null;
    renderWorktreeModal();

    try {
      const response = await fetch("/api/docs/worktrees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          directory: git.repoRoot ?? files.currentPath,
          branch,
          startPoint: modal.startPoint.trim() || null,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message = payload?.error ?? response.statusText ?? "Failed to create worktree";
        throw new Error(message);
      }
      const payload = await response.json().catch(() => ({}));
      if (payload?.repository) {
        files.git = payload.repository;
      } else {
        void loadFilesTree(files.currentPath);
      }
      modal.open = false;
      resetWorktreeModalState();
      renderWorktreeModal();
      await loadFilesTree(files.currentPath);
    } catch (error) {
      modal.submitting = false;
      modal.error = error instanceof Error ? error.message : "Failed to create worktree";
      renderWorktreeModal();
    }
  };

  // ── Ace editor lifecycle ──────────────────────────────────────────

  const destroyAceEditor = () => {
    if (!aceEditorInstance) return;
    const container = aceEditorInstance.container;
    aceEditorInstance.destroy();
    if (container) {
      container.textContent = "";
    }
    aceEditorInstance = null;
  };

  const setFileEditorState = (updater) => {
    const editor = state.fileEditor;
    if (!editor) return;
    updater(editor);
  };

  const resetFileEditorState = () => {
    setFileEditorState((editor) => {
      editor.open = false;
      editor.loading = false;
      editor.saving = false;
      editor.error = null;
      editor.saveError = null;
      editor.path = null;
      editor.relativePath = null;
      editor.displayPath = null;
      editor.name = null;
      editor.base64 = null;
      editor.content = "";
      editor.initialContent = "";
      editor.mtimeMs = null;
      editor.dirty = false;
      editor.requestId += 1;
    });
    destroyAceEditor();
  };

  const closeFileEditor = () => {
    resetFileEditorState();
    render();
  };

  const requestFileEditorClose = async () => {
    const editor = state.fileEditor;
    if (editor.saving) return;
    if (editor.dirty) {
      const confirmClose = await openConfirmDialog({
        title: "Discard Changes",
        description: "Discard unsaved changes?",
        confirmLabel: "Discard",
        testId: "file-editor-discard-dialog",
      });
      if (!confirmClose) return;
    }
    closeFileEditor();
  };

  const updateFileEditorControls = () => {
    const editor = state.fileEditor;
    const overlay = document.getElementById("wm-file-editor-overlay");
    if (!overlay || !editor.open) return;
    const saveButton = overlay.querySelector("#wm-file-editor-save");
    if (saveButton instanceof HTMLButtonElement) {
      saveButton.disabled = editor.saving || !editor.dirty;
    }
    const cancelButton = overlay.querySelector("#wm-file-editor-cancel");
    if (cancelButton instanceof HTMLButtonElement) {
      cancelButton.disabled = editor.saving;
    }
    const status = overlay.querySelector("#wm-file-editor-status");
    if (status instanceof HTMLElement) {
      if (editor.saveError) {
        status.textContent = editor.saveError;
        status.hidden = false;
      } else if (editor.saving) {
        status.textContent = "Saving\u2026";
        status.hidden = false;
      } else {
        status.textContent = "";
        status.hidden = true;
      }
    }
  };

  const ensureAceEditorMounted = async () => {
    const editor = state.fileEditor;
    if (!editor.open || editor.loading || editor.error) {
      destroyAceEditor();
      return;
    }

    const container = document.getElementById("wm-file-editor-ace");
    if (!container) {
      destroyAceEditor();
      return;
    }

    if (!aceEditorInstance) {
      const ace = await loadAceEditor();
      // Re-check state hasn't changed while loading
      if (!state.fileEditor.open) return;
      aceEditorInstance = ace.edit(container);
      aceEditorInstance.session.setMode("ace/mode/text");
      aceEditorInstance.session.setUseWrapMode(true);
      aceEditorInstance.setOptions({
        useWorker: false,
        showPrintMargin: false,
        behavioursEnabled: false,
        highlightActiveLine: true,
        highlightSelectedWord: false,
        enableBasicAutocompletion: false,
        enableLiveAutocompletion: false,
        enableSnippets: false,
        wrap: true,
        fontSize: 14,
        tabSize: 2,
      });
      aceEditorInstance.renderer.setScrollMargin(8, 8, 8, 8);
      aceEditorInstance.on("change", () => {
        if (!aceEditorInstance) return;
        const value = aceEditorInstance.getValue();
        const editorState = state.fileEditor;
        editorState.content = value;
        editorState.dirty = value !== editorState.initialContent;
        updateFileEditorControls();
      });
    }

    applyAceTheme(aceEditorInstance);
    const targetValue = editor.content ?? "";
    if (aceEditorInstance.getValue() !== targetValue) {
      const selection = aceEditorInstance.getSelectionRange();
      aceEditorInstance.setValue(targetValue, -1);
      if (!editor.loading) {
        aceEditorInstance.selection.setRange(selection, false);
      }
    }

    aceEditorInstance.resize(true);
    aceEditorInstance.focus();
    updateFileEditorControls();
  };

  const getFileEditorDisplayTitle = () => {
    const editor = state.fileEditor;
    if (editor.displayPath) return editor.displayPath;
    if (editor.name) return editor.name;
    if (editor.path) return editor.path;
    return "File Editor";
  };

  const openFileEditor = async (path, displayPath, name) => {
    if (!path) return;
    const editor = state.fileEditor;
    editor.open = true;
    editor.loading = true;
    editor.saving = false;
    editor.error = null;
    editor.saveError = null;
    editor.path = path;
    editor.displayPath = displayPath ?? null;
    editor.name = name ?? null;
    editor.content = "";
    editor.initialContent = "";
    editor.base64 = null;
    editor.dirty = false;
    editor.mtimeMs = null;
    editor.requestId += 1;
    const requestId = editor.requestId;
    render();

    try {
      const url = new URL("/api/docs/file/raw", window.location.origin);
      url.searchParams.set("path", path);
      const response = await fetch(url.toString(), { method: "GET" });
      if (!response.ok) {
        let message = response.statusText || "Failed to load file";
        try {
          const payload = await response.json();
          if (payload && typeof payload.error === "string") {
            message = payload.error;
          }
        } catch {
          // ignore json parse error
        }
        throw new Error(message);
      }

      const data = await response.json();
      if (editor.requestId !== requestId) return;
      const base64 = typeof data?.base64 === "string" ? data.base64 : "";
      const bytes = decodeBase64ToUint8Array(base64);
      const content = decodeBytesToText(bytes);
      editor.open = true;
      editor.loading = false;
      editor.error = null;
      editor.saveError = null;
      editor.path = data?.path ?? path;
      editor.relativePath = data?.relativePath ?? null;
      editor.displayPath = data?.displayPath ?? displayPath ?? null;
      editor.name = data?.name ?? name ?? null;
      editor.base64 = base64;
      editor.content = content;
      editor.initialContent = content;
      editor.mtimeMs = typeof data?.mtimeMs === "number" ? data.mtimeMs : null;
      editor.dirty = false;
    } catch (error) {
      if (editor.requestId !== requestId) return;
      editor.loading = false;
      editor.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (editor.requestId === requestId) {
        render();
      }
    }
  };

  const saveFileEditor = async () => {
    const editor = state.fileEditor;
    if (!editor.open || editor.loading || editor.saving || !editor.path) return;
    editor.saving = true;
    editor.saveError = null;
    updateFileEditorControls();
    const content = aceEditorInstance ? aceEditorInstance.getValue() : editor.content;
    editor.content = content;
    editor.dirty = content !== editor.initialContent;
    const bytes = encodeTextToBytes(content);
    const base64 = encodeUint8ArrayToBase64(bytes);

    try {
      const response = await fetch("/api/docs/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: editor.path,
          base64,
          expectedMtimeMs: editor.mtimeMs ?? undefined,
        }),
      });
      if (!response.ok) {
        let message = response.statusText || "Failed to save file";
        try {
          const payload = await response.json();
          if (payload && typeof payload.error === "string") {
            message = payload.error;
          }
        } catch {
          // ignore json parse error
        }
        throw new Error(message);
      }

      const data = await response.json();
      editor.initialContent = content;
      editor.content = content;
      editor.base64 = base64;
      editor.mtimeMs = typeof data?.mtimeMs === "number" ? data.mtimeMs : editor.mtimeMs;
      editor.dirty = false;
      editor.saving = false;
      editor.saveError = null;
      if (state.files.previewPath === editor.path) {
        state.files.previewContent = content;
      }
      updateFileEditorControls();
    } catch (error) {
      editor.saving = false;
      editor.saveError = error instanceof Error ? error.message : String(error);
      editor.dirty = editor.content !== editor.initialContent;
      updateFileEditorControls();
    }
  };

  // ── Renderers ─────────────────────────────────────────────────────

  const renderFileEditorOverlay = () => {
    const existing = document.getElementById("wm-file-editor-overlay");
    if (existing) existing.remove();

    const editor = state.fileEditor;
    if (!editor.open) {
      destroyAceEditor();
      return;
    }

    const overlay = document.createElement("div");
    overlay.id = "wm-file-editor-overlay";
    overlay.className = "wm-file-editor";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) requestFileEditorClose();
    });

    const dialog = document.createElement("div");
    dialog.className = "wm-file-editor__dialog";
    overlay.append(dialog);

    const header = document.createElement("div");
    header.className = "wm-file-editor__header";
    const heading = document.createElement("div");
    heading.className = "wm-file-editor__heading";
    const title = document.createElement("h2");
    title.textContent = editor.name ?? "Edit File";
    heading.append(title);

    const subtitleText = editor.name ? getFileEditorDisplayTitle() : editor.displayPath ?? editor.path ?? "";
    if (subtitleText) {
      const subtitle = document.createElement("p");
      subtitle.className = "wm-file-editor__subtitle";
      subtitle.textContent = subtitleText;
      heading.append(subtitle);
    }
    header.append(heading);
    dialog.append(header);

    const body = document.createElement("div");
    body.className = "wm-file-editor__body";
    dialog.append(body);

    if (editor.loading) {
      const message = document.createElement("p");
      message.className = "wm-file-editor__message";
      message.textContent = "Loading file\u2026";
      body.append(message);
    } else if (editor.error) {
      const message = document.createElement("p");
      message.className = "wm-file-editor__message";
      message.textContent = editor.error;
      body.append(message);
    } else {
      const editorContainer = document.createElement("div");
      editorContainer.id = "wm-file-editor-ace";
      editorContainer.className = "wm-file-editor__editor";
      body.append(editorContainer);
    }

    const footer = document.createElement("div");
    footer.className = "wm-file-editor__footer";
    const status = document.createElement("div");
    status.id = "wm-file-editor-status";
    status.className = "wm-file-editor__status";
    status.hidden = true;
    footer.append(status);

    const actions = document.createElement("div");
    actions.className = "wm-file-editor__actions";

    const cancelButton = document.createElement("button");
    cancelButton.id = "wm-file-editor-cancel";
    cancelButton.type = "button";
    cancelButton.className = "wm-button secondary";
    cancelButton.textContent = editor.error ? "Close" : "Cancel";
    cancelButton.addEventListener("click", () => requestFileEditorClose());
    actions.append(cancelButton);

    if (editor.error && editor.path) {
      const retryButton = document.createElement("button");
      retryButton.type = "button";
      retryButton.className = "wm-button";
      retryButton.textContent = "Retry";
      retryButton.addEventListener("click", () => {
        void openFileEditor(editor.path, editor.displayPath, editor.name);
      });
      actions.append(retryButton);
    } else if (!editor.loading) {
      const saveButton = document.createElement("button");
      saveButton.id = "wm-file-editor-save";
      saveButton.type = "button";
      saveButton.className = "wm-button";
      saveButton.textContent = "Save";
      saveButton.disabled = true;
      saveButton.addEventListener("click", () => void saveFileEditor());
      actions.append(saveButton);
    }

    footer.append(actions);
    dialog.append(footer);
    appRoot.append(overlay);

    updateFileEditorControls();
    if (!editor.loading && !editor.error) {
      requestAnimationFrame(() => ensureAceEditorMounted());
    } else {
      updateFileEditorControls();
    }
  };

  function renderWorktreeModal() {
    const existing = document.getElementById("wm-worktree-modal");
    if (existing) existing.remove();

    const modal = state.files.worktreeModal;
    if (!modal.open) return;

    const git = getWorktreeGitInfo();

    const overlay = document.createElement("div");
    overlay.id = "wm-worktree-modal";
    overlay.className = "wm-worktree-modal";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay && !modal.submitting) closeWorktreeModal();
    });

    const dialog = document.createElement("div");
    dialog.className = "wm-worktree-modal__dialog";
    overlay.append(dialog);

    const header = document.createElement("div");
    header.className = "wm-worktree-modal__header";
    const title = document.createElement("h2");
    title.textContent = "Create Worktree";
    header.append(title);
    if (git?.repoRoot) {
      const subtitle = document.createElement("p");
      subtitle.className = "wm-worktree-modal__subtitle";
      subtitle.textContent = git.repoRoot;
      header.append(subtitle);
    }
    dialog.append(header);

    const body = document.createElement("div");
    body.className = "wm-worktree-modal__body";
    dialog.append(body);

    const description = document.createElement("p");
    description.className = "wm-worktree-modal__description";
    if (git?.worktreeBase) {
      description.textContent = `New worktrees are created under ${git.worktreeBase}/<branch>`;
    } else {
      description.textContent = "New worktrees are created under .worktrees/<branch> in this repository.";
    }
    body.append(description);

    if (git?.worktreeError) {
      const warning = document.createElement("p");
      warning.className = "wm-worktree-modal__warning";
      warning.textContent = git.worktreeError;
      body.append(warning);
    }

    const form = document.createElement("form");
    form.className = "wm-worktree-modal__form";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (modal.submitting) return;
      void requestCreateWorktree();
    });

    const branchGroup = document.createElement("label");
    branchGroup.className = "wm-worktree-modal__field";
    const branchLabel = document.createElement("span");
    branchLabel.className = "wm-worktree-modal__label";
    branchLabel.textContent = "Feature branch";
    const branchInput = document.createElement("input");
    branchInput.type = "text";
    branchInput.required = true;
    branchInput.placeholder = "feature/amazing-update";
    branchInput.value = modal.branch;
    branchInput.disabled = modal.submitting;
    branchInput.addEventListener("input", (event) => {
      modal.branch = event.target.value;
    });
    branchGroup.append(branchLabel, branchInput);
    form.append(branchGroup);

    const startGroup = document.createElement("label");
    startGroup.className = "wm-worktree-modal__field";
    const startLabel = document.createElement("span");
    startLabel.className = "wm-worktree-modal__label";
    startLabel.textContent = "Start from (optional)";
    const startInput = document.createElement("input");
    startInput.type = "text";
    startInput.placeholder =
      git?.currentBranch && git.currentBranch !== "HEAD" ? git.currentBranch : git?.headRef || "main";
    startInput.value = modal.startPoint;
    startInput.disabled = modal.submitting;
    startInput.addEventListener("input", (event) => {
      modal.startPoint = event.target.value;
    });
    startGroup.append(startLabel, startInput);
    form.append(startGroup);

    const existingWorktrees = Array.isArray(git?.worktrees)
      ? git.worktrees.filter((worktree) => !worktree.primary)
      : [];

    if (existingWorktrees.length > 0) {
      const listWrapper = document.createElement("div");
      listWrapper.className = "wm-worktree-modal__existing";
      const listTitle = document.createElement("h3");
      listTitle.textContent = "Existing worktrees";
      listWrapper.append(listTitle);
      const list = document.createElement("ul");
      existingWorktrees.forEach((worktree) => {
        const item = document.createElement("li");
        const branch = worktree.branch ? ` (${worktree.branch})` : "";
        item.textContent = `${worktree.path}${branch}`;
        list.append(item);
      });
      listWrapper.append(list);
      form.append(listWrapper);
    }

    if (modal.error) {
      const error = document.createElement("p");
      error.className = "wm-worktree-modal__error";
      error.textContent = modal.error;
      form.append(error);
    }

    const actions = document.createElement("div");
    actions.className = "wm-worktree-modal__actions";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "wm-button secondary";
    cancelButton.textContent = "Cancel";
    cancelButton.disabled = modal.submitting;
    cancelButton.addEventListener("click", () => {
      if (modal.submitting) return;
      closeWorktreeModal();
    });
    actions.append(cancelButton);

    const submitButton = document.createElement("button");
    submitButton.type = "submit";
    submitButton.className = "wm-button";
    submitButton.textContent = modal.submitting ? "Creating..." : "Create Worktree";
    submitButton.disabled = modal.submitting;
    actions.append(submitButton);

    form.append(actions);
    body.append(form);
    appRoot.append(overlay);

    if (!modal.submitting) {
      requestAnimationFrame(() => {
        branchInput.focus();
        branchInput.select();
      });
    }
  }

  return {
    getWorktreeGitInfo,
    canCreateWorktree,
    openWorktreeModal,
    closeWorktreeModal,
    resetFileEditorState,
    closeFileEditor,
    getFileEditorDisplayTitle,
    openFileEditor,
    renderFileEditorOverlay,
    renderWorktreeModal,
    destroyAceEditor,
    ensureAceEditorMounted,
    requestFileEditorClose,
    getAceEditorInstance: () => aceEditorInstance,
  };
}
