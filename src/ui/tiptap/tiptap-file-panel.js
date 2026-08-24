import { Editor } from "/vendor/tiptap-bundle.js";
import { createAutopilotTiptapExtensions } from "./extensions.js";
import { inspectMarkdownForRichEditing, markdownToProseMirrorDoc, proseMirrorDocToMarkdown } from "./markdown-codecs.js";
import { createTiptapToolbar } from "./toolbar.js";
import { getParentDirectory, rewriteImageSourcesForDisplay } from "./file-paths.js";
import { appendCommentMessage, combineMarkdownAndComments, createCommentThread, parseAutopilotCommentEndmatter } from "./comment-endmatter.js";
import { createCommentsPanel } from "./comments-panel.js";
import { handleImagePaste } from "./image-paste.js";
import { buildCommentAnchor } from "./comment-anchor.js";
import { createCommentAutosave } from "./comment-autosave.js";
import { createTiptapFileIo, decodeDocsFileContent } from "./file-io.js";
import { bindCommentAutosaveLifecycle } from "./comment-save-lifecycle.js";
import { renderTiptapConflictActions } from "./conflict-actions.js";
import { highlightCommentAnchor, markActiveCommentThread } from "./comment-highlight.js";
const POLL_INTERVAL_MS = 2500;

export function createTiptapFilePanel(sessionId, targetFile, deps = {}) {
  const { showToast } = deps;
  const panel = document.createElement("section");
  panel.className = "wm-writer-panel wm-tiptap-panel";
  panel.dataset.testid = "tiptap-file-panel";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Markdown file editor");
  if (sessionId) panel.dataset.sessionId = sessionId;

  let editor = null;
  let sourceEditor = null;
  let rawContent = "";
  let initialDocumentContent = "";
  let commentThreads = [];
  let lastMtimeMs = null;
  let mode = "rich";
  let dirty = false;
  let saving = false;
  let destroyed = false;
  let pollTimer = null;
  let warning = null, error = null;
  let statusMessage = "", statusType = "info", activeCommentThreadId = null;
  let commentsPanelOpen = typeof window !== "undefined" && window.matchMedia?.("(min-width: 900px)")?.matches;
  const fileDirectory = getParentDirectory(targetFile);
  const fileIo = createTiptapFileIo(targetFile, {
    getExpectedMtime: () => lastMtimeMs,
    setMtime: (value) => { lastMtimeMs = value; },
    onSaving: ({ renderSaving }) => {
      saving = true;
      if (renderSaving) render();
    },
  });
  const commentAutosave = createCommentAutosave({
    canSave: () => !destroyed && dirty && !saving,
    save: autosaveComments,
    onSuccess: () => setStatus("Autosaved comments", "success"),
    onError: (autosaveError) => {
      saving = false;
      const message = autosaveError instanceof Error ? autosaveError.message : "Failed to autosave comments";
      error = /changed since it was loaded/i.test(message)
        ? "This file changed on disk. Copy your draft or reload before saving."
        : message;
      render();
    },
  });
  const commentSaveLifecycle = bindCommentAutosaveLifecycle(commentAutosave);
  function setStatus(message, type = "info") {
    statusMessage = message || "";
    statusType = type;
    const status = panel.querySelector("[data-tiptap-status]");
    if (!status) return;
    status.textContent = statusMessage;
    status.dataset.type = statusType;
    status.hidden = !statusMessage;
  }
  function getEditorMarkdown(activeEditor = editor) {
    if (!activeEditor) return rawContent;
    return proseMirrorDocToMarkdown(activeEditor.getJSON());
  }
  function getCurrentMarkdown() {
    if (mode === "source") return sourceEditor?.value ?? rawContent;
    return getEditorMarkdown();
  }
  function getCurrentDocumentMarkdown() {
    return combineMarkdownAndComments(getCurrentMarkdown(), commentThreads);
  }
  function syncDirtyState() {
    dirty = getCurrentDocumentMarkdown() !== initialDocumentContent;
    updateControls();
  }

  function buildAnchorForSelection() {
    return buildCommentAnchor({ markdown: getCurrentMarkdown(), mode, editor, sourceEditor });
  }

  function createEditor(mount) {
    const content = rewriteImageSourcesForDisplay(markdownToProseMirrorDoc(rawContent), fileDirectory);
    editor = new Editor({
      element: mount,
      extensions: createAutopilotTiptapExtensions({ placeholder: "Start writing..." }),
      content,
      editorProps: {
        attributes: {
          "aria-label": "Markdown rich editor",
          "data-testid": "tiptap-editor",
        },
        handlePaste: (_view, event) => handleImagePaste(event, editor, {
          fileDirectory,
          showToast,
          onUploaded: () => {
            syncDirtyState();
            render();
          },
        }),
      },
      onUpdate({ editor: activeEditor }) {
        if (!activeEditor || destroyed) return;
        rawContent = getEditorMarkdown(activeEditor);
        syncDirtyState();
      },
      onFocus() {
        stopPolling();
      },
      onBlur() {
        if (!dirty) startPolling();
      },
    });
  }

  function updateControls() {
    const saveButton = panel.querySelector("[data-testid='tiptap-save-button']");
    if (saveButton instanceof HTMLButtonElement) {
      saveButton.disabled = saving || !dirty;
      saveButton.textContent = saving ? "Saving..." : dirty ? "Save" : "Saved";
    }
  }

  function destroyEditor() {
    if (editor) {
      editor.destroy();
      editor = null;
    }
  }

  async function handleSave() {
    if (saving || !dirty) return;
    commentAutosave.clear();
    const nextContent = getCurrentMarkdown();
    const nextDocumentContent = combineMarkdownAndComments(nextContent, commentThreads);
    try {
      await fileIo.saveFile(nextDocumentContent);
      rawContent = nextContent;
      initialDocumentContent = nextDocumentContent;
      dirty = false;
      saving = false;
      error = null;
      setStatus("Saved", "success");
      render();
      startPolling();
    } catch (saveError) {
      saving = false;
      const message = saveError instanceof Error ? saveError.message : "Failed to save file";
      error = /changed since it was loaded/i.test(message)
        ? "This file changed on disk. Copy your draft or reload before saving."
        : message;
      render();
    }
  }

  function toggleMode() {
    rawContent = getCurrentMarkdown();
    mode = mode === "source" ? "rich" : "source";
    render();
  }

  async function autosaveComments() {
    const nextContent = getCurrentMarkdown();
    const nextDocumentContent = combineMarkdownAndComments(nextContent, commentThreads);
    await fileIo.saveFile(nextDocumentContent, { renderSaving: false });
    rawContent = nextContent;
    initialDocumentContent = nextDocumentContent;
    dirty = false;
    saving = false;
    error = null;
    updateControls();
    startPolling();
  }

  function render() {
    if (destroyed) return;
    destroyEditor();
    panel.innerHTML = "";
    const markdownInfo = inspectMarkdownForRichEditing(rawContent);
    warning = markdownInfo.risky
      ? `Rich mode may normalize ${markdownInfo.reasons.join(", ")}. Use Source before saving if exact Markdown formatting matters.`
      : null;

    const status = document.createElement("div");
    status.className = "wm-tiptap-status";
    status.dataset.tiptapStatus = "true";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = statusMessage;
    status.dataset.type = statusType;
    status.hidden = !statusMessage;
    panel.append(status);

    if (error) {
      const conflict = document.createElement("div");
      conflict.className = "wm-tiptap-conflict";
      conflict.dataset.testid = "tiptap-conflict-banner";
      conflict.setAttribute("role", "alert");
      conflict.textContent = error;
      if (/changed on disk/i.test(error)) {
        renderTiptapConflictActions(conflict, {
          onReload: refreshContent,
          getDraftMarkdown: getCurrentMarkdown,
          showToast,
        });
      }
      panel.append(conflict);
    } else if (warning) {
      const warningEl = document.createElement("div");
      warningEl.className = "wm-tiptap-warning";
      warningEl.textContent = warning;
      panel.append(warningEl);
    }

    const workspace = document.createElement("div");
    workspace.className = "wm-tiptap-workspace";
    const body = document.createElement("div");
    body.className = "wm-tiptap-body";
    workspace.append(body);
    panel.append(workspace);

    if (mode === "source") {
      sourceEditor = document.createElement("textarea");
      sourceEditor.className = "wm-tiptap-source";
      sourceEditor.dataset.testid = "tiptap-source-editor";
      sourceEditor.setAttribute("aria-label", "Markdown source editor");
      sourceEditor.spellcheck = false;
      sourceEditor.value = rawContent;
      sourceEditor.addEventListener("input", () => {
        rawContent = sourceEditor.value;
        syncDirtyState();
      });
      body.append(sourceEditor);
    } else {
      sourceEditor = null;
      const mount = document.createElement("div");
      mount.className = "wm-tiptap-editor";
      mount.dataset.testid = "tiptap-editor-mount";
      body.append(mount);
      createEditor(mount);
    }

    const toolbar = createTiptapToolbar({
      editor,
      mode,
      dirty,
      saving,
      onSave: () => void handleSave(),
      onToggleMode: toggleMode,
    });
    panel.insertBefore(toolbar, workspace);
    workspace.append(createCommentsPanel({
      threads: commentThreads,
      onPrepareThread: () => {
        const anchor = buildAnchorForSelection();
        if (!anchor) setStatus("Select document text before adding a comment.", "error");
        return anchor;
      },
      onAddThread: addCommentThread,
      onAddReply: addCommentReply,
      onSetStatus: setCommentStatus,
      onSelectThread: selectCommentThread,
      activeThreadId: activeCommentThreadId,
      defaultOpen: commentsPanelOpen,
      onOpenChange: (open) => { commentsPanelOpen = open; },
      fileDirectory,
      showToast,
    }));
    updateControls();
  }

  async function checkForChanges() {
    if (destroyed || dirty || saving) return;
    try {
      const response = await fetch(`/api/docs/file/raw?path=${encodeURIComponent(targetFile)}`);
      if (!response.ok) return;
      const data = await response.json();
      const mtime = typeof data?.mtimeMs === "number" ? data.mtimeMs : null;
      if (mtime !== null && lastMtimeMs !== null && Math.abs(mtime - lastMtimeMs) > 1) {
        const content = decodeDocsFileContent(data);
        lastMtimeMs = mtime;
        applyLoadedMarkdown(content);
        setStatus("Reloaded external changes", "info");
        render();
      }
    } catch {
      // Polling is opportunistic.
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(checkForChanges, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function refreshContent() {
    try {
      error = null;
      applyLoadedMarkdown(await fileIo.loadFile());
      dirty = false;
      render();
      startPolling();
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : "Failed to load file";
      render();
    }
  }

  void refreshContent();

  function applyLoadedMarkdown(markdown) {
    const parsed = parseAutopilotCommentEndmatter(markdown);
    rawContent = parsed.body;
    commentThreads = parsed.threads;
    initialDocumentContent = parsed.error ? String(markdown ?? "") : combineMarkdownAndComments(rawContent, commentThreads);
    if (parsed.error) error = parsed.error;
  }

  function addCommentThread(body, preparedAnchor = null) {
    const anchor = preparedAnchor || buildAnchorForSelection();
    if (!anchor) {
      setStatus("Select document text before adding a comment.", "error");
      return;
    }
    const thread = createCommentThread({ anchor, body });
    if (!thread) {
      setStatus("Comment body is required.", "error");
      return;
    }
    commentThreads = [...commentThreads, thread];
    syncDirtyState();
    commentAutosave.queue();
    setStatus("Comment added. Autosaving...", "info");
    render();
  }

  function addCommentReply(threadId, body) {
    let changed = false;
    commentThreads = commentThreads.map((thread) => {
      if (thread.id !== threadId) return thread;
      const next = appendCommentMessage(thread, body);
      if (!next) return thread;
      changed = true;
      return next;
    });
    if (!changed) {
      setStatus("Reply body is required.", "error");
      return;
    }
    syncDirtyState();
    commentAutosave.queue();
    render();
  }

  function selectCommentThread(threadId) {
    activeCommentThreadId = threadId;
    const thread = commentThreads.find((item) => item.id === threadId);
    if (mode === "rich" && editor && highlightCommentAnchor(editor, thread)) {
      markActiveCommentThread(panel, threadId);
      return;
    }
    if (thread?.anchor?.text) setStatus(`Comment anchor: ${thread.anchor.text}`, "info");
    render();
  }

  function setCommentStatus(threadId, status) {
    commentThreads = commentThreads.map((thread) => (
      thread.id === threadId ? { ...thread, status: status === "resolved" ? "resolved" : "open" } : thread
    ));
    syncDirtyState();
    commentAutosave.queue();
    render();
  }

  return {
    panel,
    cleanup() {
      commentSaveLifecycle.flush();
      destroyed = true;
      stopPolling();
      commentAutosave.clear();
      commentSaveLifecycle.cleanup();
      destroyEditor();
    },
  };
}
