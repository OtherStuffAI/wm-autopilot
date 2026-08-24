/**
 * Writer panel component — block-based markdown editor that pairs with
 * a live agent session. Renders markdown blocks with click-to-edit.
 *
 * Exports:
 *   createWriterPanel(sessionId, targetFile, deps) -> { panel, cleanup }
 *   createWriterIcon(onToggle) -> HTMLButtonElement
 *   createWriterToolbar(currentMode, onModeChange, onClose) -> HTMLElement
 */

import { parseMarkdownBlocks, assembleBlocks } from "./block-parser.js";
import { renderMarkdownToHtml, renderCodeToHtml } from "../rendering/markdown.js";
import { renderMermaidDiagrams } from "../rendering/mermaid.js";
import { escapeHtml } from "../core/icons.js";
import {
  decodeBase64ToUint8Array,
  decodeBytesToText,
  encodeTextToBytes,
  encodeUint8ArrayToBase64,
} from "../core/encoding.js";

/**
 * Markdown extensions that should use block-based editing.
 * All other text files use single-block code editing.
 */
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);

/**
 * Map file extension to a syntax language hint for code rendering.
 */
const EXT_LANGUAGE_MAP = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".tsx": "typescript",
  ".json": "json", ".jsonc": "json",
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini", ".conf": "ini", ".env": "ini",
  ".py": "python",
  ".rb": "ruby",
  ".php": "php",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c", ".h": "c",
  ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
  ".kt": "kotlin", ".kts": "kotlin",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell",
  ".sql": "sql",
  ".css": "css",
  ".html": "html", ".htm": "html", ".xml": "html", ".svg": "html", ".vue": "html", ".svelte": "html",
};

function getFileExtension(filePath) {
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
}

function isMarkdownFile(filePath) {
  return MARKDOWN_EXTENSIONS.has(getFileExtension(filePath));
}

function detectLanguage(filePath) {
  return EXT_LANGUAGE_MAP[getFileExtension(filePath)] || "plaintext";
}

const POLL_INTERVAL_MS = 2500;

function getScrollableAncestor(element) {
  let current = element?.parentElement ?? null;
  while (current) {
    const style = window.getComputedStyle(current);
    const canScrollY = /(auto|scroll)/.test(style.overflowY);
    if (canScrollY && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function resizeTextareaPreserveScroll(editor) {
  const scrollParent = getScrollableAncestor(editor);
  const parentScrollTop = scrollParent?.scrollTop ?? 0;
  const windowScrollY = window.scrollY;

  editor.style.height = "auto";
  editor.style.height = `${editor.scrollHeight}px`;

  if (scrollParent) {
    scrollParent.scrollTop = parentScrollTop;
  }
  window.scrollTo(window.scrollX, windowScrollY);
}

function focusEditorWithoutScroll(editor) {
  try {
    editor.focus({ preventScroll: true });
  } catch {
    editor.focus();
  }
}

function getParentDirectory(filePath) {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : normalized;
}

function guessImageExtension(mimeType) {
  const mime = String(mimeType ?? "").toLowerCase();
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  if (mime === "image/svg+xml") return "svg";
  if (mime === "image/bmp") return "bmp";
  if (mime === "image/heic") return "heic";
  if (mime === "image/heif") return "heif";
  return "png";
}

function createPastedImageFilename(file) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const random = Math.random().toString(36).slice(2, 8);
  const ext = guessImageExtension(file?.type);
  return `pasted-image-${stamp}-${random}.${ext}`;
}

function insertTextAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? start;
  const value = textarea.value ?? "";
  textarea.value = value.slice(0, start) + text + value.slice(end);
  const next = start + text.length;
  textarea.selectionStart = next;
  textarea.selectionEnd = next;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function createUploadMarkerId() {
  return Math.random().toString(36).slice(2, 10);
}

function buildUploadPlaceholder(markerId) {
  return `<!--UPL:${markerId}-->[Uploading...]`;
}

function replaceUploadPlaceholder(textarea, markerId, replacement) {
  const marker = buildUploadPlaceholder(markerId);
  const currentValue = textarea.value ?? "";
  const index = currentValue.indexOf(marker);
  if (index === -1) return false;
  textarea.value = currentValue.slice(0, index) + replacement + currentValue.slice(index + marker.length);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function isAbsoluteOrSchemePath(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (text.startsWith("/") || text.startsWith("#")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(text);
}

function normalisePosixPath(path) {
  const input = String(path ?? "").replace(/\\/g, "/");
  const isAbs = input.startsWith("/");
  const out = [];
  for (const part of input.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return `${isAbs ? "/" : ""}${out.join("/")}`;
}

function buildResolvedDocPath(baseDir, relativePath) {
  return normalisePosixPath(`${baseDir}/${relativePath}`);
}

function buildDocsDownloadUrl(docPath) {
  return `/api/docs/file/download?path=${encodeURIComponent(docPath)}`;
}

function rewriteMarkdownImagePathsForPreview(markdown, baseDir) {
  return String(markdown ?? "").replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (full, alt, rawUrl) => {
    if (isAbsoluteOrSchemePath(rawUrl)) return full;
    const resolved = buildResolvedDocPath(baseDir, rawUrl);
    const previewUrl = buildDocsDownloadUrl(resolved);
    return `![${alt}](${previewUrl})`;
  });
}

/**
 * Create the pencil icon button that toggles the writer panel.
 * @param {Function} onToggle
 * @returns {HTMLButtonElement}
 */
export function createWriterIcon(onToggle) {
  const btn = document.createElement("button");
  btn.className = "wm-writer-icon";
  btn.title = "Toggle writer panel";
  btn.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
  btn.addEventListener("click", onToggle);
  return btn;
}

/**
 * Create the writer toolbar with layout toggle and close buttons.
 * Reuses the webview toolbar CSS pattern.
 * @param {string} currentMode - 'chat-narrow' or 'app-narrow'
 * @param {Function} onModeChange - Called with new mode string
 * @param {Function} onClose - Called when close is clicked
 * @returns {HTMLElement}
 */
const WRITER_VIEW_MODES = [
  { mode: "app-narrow", label: "1/3", title: "Artifact one third" },
  { mode: "balanced", label: "1/2", title: "Artifact half width" },
  { mode: "chat-narrow", label: "2/3", title: "Artifact two thirds" },
];

function getWriterViewMode(currentMode) {
  return WRITER_VIEW_MODES.find((entry) => entry.mode === currentMode) ?? WRITER_VIEW_MODES[2];
}

function getNextWriterViewMode(currentMode) {
  const currentIndex = WRITER_VIEW_MODES.findIndex((entry) => entry.mode === currentMode);
  return WRITER_VIEW_MODES[(currentIndex + 1 + WRITER_VIEW_MODES.length) % WRITER_VIEW_MODES.length];
}

function createSideCollapseIcon(side) {
  const isLeft = side === "left";
  const arrowPath = isLeft ? "M9 18l-6-6 6-6" : "M15 18l6-6-6-6";
  const railPath = isLeft ? "M21 5v14" : "M3 5v14";
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${arrowPath}"/><path d="M3 12h18"/><path d="${railPath}"/></svg>`;
}

export function createWriterToolbar(currentMode, onModeChange, onClose) {
  const toolbar = document.createElement("div");
  toolbar.className = "wm-webview-toolbar";

  const modeGroup = document.createElement("div");
  modeGroup.className = "wm-webview-toolbar-modes";

  const isChatCollapsed = currentMode === "chat-collapsed";
  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.className = `wm-webview-mode-btn wm-writer-fullscreen-toggle${isChatCollapsed ? " active" : ""}`;
  fullscreenBtn.title = isChatCollapsed ? "Restore AI chat" : "Collapse AI chat";
  fullscreenBtn.setAttribute("aria-label", isChatCollapsed ? "Restore AI chat" : "Collapse AI chat");
  fullscreenBtn.setAttribute("aria-pressed", isChatCollapsed ? "true" : "false");
  fullscreenBtn.innerHTML = createSideCollapseIcon("left");
  fullscreenBtn.addEventListener("click", () => {
    onModeChange(isChatCollapsed ? "chat-narrow" : "chat-collapsed");
  });

  const cycleBaseMode = isChatCollapsed ? "chat-narrow" : currentMode;
  const currentViewMode = getWriterViewMode(cycleBaseMode);
  const viewSizeBtn = document.createElement("button");
  viewSizeBtn.className = "wm-webview-mode-btn wm-writer-view-cycle";
  viewSizeBtn.title = `${currentViewMode.title}; click to cycle`;
  viewSizeBtn.setAttribute("aria-label", "Cycle artifact view size");
  viewSizeBtn.textContent = currentViewMode.label;
  viewSizeBtn.addEventListener("click", () => {
    onModeChange(getNextWriterViewMode(cycleBaseMode).mode);
  });

  modeGroup.append(fullscreenBtn, viewSizeBtn);

  const actionsGroup = document.createElement("div");
  actionsGroup.className = "wm-webview-toolbar-actions";

  const closeBtn = document.createElement("button");
  closeBtn.className = "wm-webview-close-btn";
  closeBtn.title = "Collapse artifact";
  closeBtn.setAttribute("aria-label", "Collapse artifact");
  closeBtn.innerHTML = createSideCollapseIcon("right");
  closeBtn.addEventListener("click", onClose);

  actionsGroup.append(closeBtn);
  toolbar.append(modeGroup, actionsGroup);
  return toolbar;
}

/**
 * Create the writer panel for a target file.
 * Loads file content, renders blocks, and polls for external changes.
 *
 * @param {string} sessionId
 * @param {string} targetFile - Absolute path to the target file
 * @param {Object} deps
 * @param {Function} deps.showToast - Toast notification function
 * @returns {{ panel: HTMLElement, cleanup: Function }}
 */
export function createWriterPanel(sessionId, targetFile, deps) {
  const { showToast } = deps;
  const panel = document.createElement("div");
  panel.className = "wm-writer-panel";

  const blocksContainer = document.createElement("div");
  blocksContainer.className = "wm-writer-blocks";
  panel.append(blocksContainer);

  const mdMode = isMarkdownFile(targetFile);
  const codeLang = mdMode ? null : detectLanguage(targetFile);
  const fileDirectory = getParentDirectory(targetFile);

  let blocks = [];
  let rawContent = "";
  let lastMtimeMs = null;
  let editingIndex = -1;
  let pollTimer = null;
  let destroyed = false;
  let commitInProgress = false;

  async function uploadPastedImageToCurrentDirectory(file) {
    const parentDirectory = getParentDirectory(targetFile);
    const uploadName = createPastedImageFilename(file);
    const base64 = encodeUint8ArrayToBase64(new Uint8Array(await file.arrayBuffer()));
    const response = await fetch("/api/docs/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        directory: parentDirectory,
        name: uploadName,
        base64,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error ?? response.statusText ?? "Failed to upload pasted image";
      throw new Error(message);
    }
    return data?.name || uploadName;
  }

  async function handleEditorPaste(event, editor) {
    if (!mdMode) return;
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageFiles = items
      .filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file) => file instanceof File);

    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    const queued = imageFiles.map((file) => ({ file, markerId: createUploadMarkerId() }));
    const placeholders = queued.map(({ markerId }) => buildUploadPlaceholder(markerId));
    const prefix = editor.selectionStart > 0 ? "\n" : "";
    const suffix = editor.value.endsWith("\n") ? "" : "\n";
    insertTextAtCursor(editor, `${prefix}${placeholders.join("\n")}${suffix}`);
    focusEditorWithoutScroll(editor);

    let uploadedCount = 0;
    for (const item of queued) {
      try {
        const savedName = await uploadPastedImageToCurrentDirectory(item.file);
        replaceUploadPlaceholder(editor, item.markerId, `![${savedName}](${savedName})`);
        uploadedCount += 1;
      } catch (error) {
        replaceUploadPlaceholder(editor, item.markerId, "");
        const message = error instanceof Error ? error.message : "Failed to upload pasted image";
        showToast?.(message, { variant: "error" });
      }
    }

    if (uploadedCount > 0) {
      showToast?.(`Uploaded ${uploadedCount} image${uploadedCount > 1 ? "s" : ""}`, { duration: 2000 });
    }
  }

  // ── File operations ──────────────────────────────────────────

  async function loadFile() {
    try {
      const resp = await fetch(`/api/docs/file/raw?path=${encodeURIComponent(targetFile)}`);
      if (!resp.ok) {
        showError(`Failed to load file: ${resp.statusText}`);
        return null;
      }
      const data = await resp.json();
      const content = data.base64
        ? decodeBytesToText(decodeBase64ToUint8Array(data.base64))
        : "";
      lastMtimeMs = data.mtimeMs ?? null;
      return content;
    } catch (err) {
      showError(`Failed to load file: ${err.message}`);
      return null;
    }
  }

  async function saveFile(content) {
    try {
      const resp = await fetch("/api/docs/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: targetFile,
          base64: encodeUint8ArrayToBase64(encodeTextToBytes(content)),
          expectedMtimeMs: lastMtimeMs,
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 409) {
          showToast?.("File was modified externally. Reloading...", { duration: 3000 });
          await refreshContent();
          return false;
        }
        showToast?.(`Save failed: ${data.error ?? resp.statusText}`, { variant: "error" });
        return false;
      }
      const result = await resp.json();
      lastMtimeMs = result.mtimeMs ?? lastMtimeMs;
      return true;
    } catch (err) {
      showToast?.(`Save failed: ${err.message}`, { variant: "error" });
      return false;
    }
  }

  // ── Rendering ────────────────────────────────────────────────

  function showError(message) {
    blocksContainer.innerHTML = "";
    const el = document.createElement("div");
    el.className = "wm-writer-error";
    el.textContent = message;
    blocksContainer.append(el);
  }

  function showLoading() {
    blocksContainer.innerHTML = "";
    const el = document.createElement("div");
    el.className = "wm-writer-loading";
    el.textContent = "Loading\u2026";
    blocksContainer.append(el);
  }

  function renderBlocks() {
    blocksContainer.innerHTML = "";

    // Code-file mode: single editable block for the entire file
    if (!mdMode) {
      renderCodeFileView();
      return;
    }

    if (blocks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wm-writer-loading";
      empty.textContent = "Empty document";
      blocksContainer.append(empty);
      return;
    }

    blocks.forEach((block, index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "wm-writer-block";
      if (block.type === "frontmatter") {
        wrapper.classList.add("wm-writer-frontmatter");
      }
      wrapper.dataset.blockIndex = String(index);
      wrapper.dataset.blockType = block.type;

      if (editingIndex === index) {
        renderEditor(wrapper, block, index);
      } else {
        renderMdBlockView(wrapper, block, index);
      }

      blocksContainer.append(wrapper);
    });
  }

  /**
   * Render the entire file as a single code block (non-markdown mode).
   * Click to edit the whole file in a textarea.
   */
  function renderCodeFileView() {
    const wrapper = document.createElement("div");
    wrapper.className = "wm-writer-block";
    wrapper.dataset.blockIndex = "0";
    wrapper.dataset.blockType = "code-file";

    if (editingIndex === 0) {
      // Full-file editor
      const editor = document.createElement("textarea");
      editor.className = "wm-writer-block__editor";
      editor.value = rawContent;
      editor.spellcheck = false;

      function autoResize() {
        resizeTextareaPreserveScroll(editor);
      }
      editor.addEventListener("input", autoResize);
      editor.addEventListener("paste", (event) => {
        void handleEditorPaste(event, editor);
      });
      editor.addEventListener("keydown", (e) => {
        // Allow Tab to insert a tab character
        if (e.key === "Tab") {
          e.preventDefault();
          const start = editor.selectionStart;
          const end = editor.selectionEnd;
          editor.value = editor.value.substring(0, start) + "  " + editor.value.substring(end);
          editor.selectionStart = editor.selectionEnd = start + 2;
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          editingIndex = -1;
          renderBlocks();
        }
      });
      editor.addEventListener("blur", () => commitCodeFileEdit(editor));

      wrapper.append(editor);
      blocksContainer.append(wrapper);
      requestAnimationFrame(() => {
        autoResize();
        focusEditorWithoutScroll(editor);
      });
      return;
    }

    // Read-only rendered code view
    const rendered = document.createElement("div");
    rendered.className = "wm-writer-block__rendered wm-writer-code-file";
    rendered.dataset.language = codeLang;
    if (rawContent.trim().length === 0) {
      rendered.textContent = "Empty file";
    } else {
      rendered.innerHTML = renderCodeToHtml(rawContent, codeLang);
    }
    rendered.addEventListener("click", () => {
      editingIndex = 0;
      renderBlocks();
    });
    wrapper.append(rendered);
    blocksContainer.append(wrapper);
  }

  async function commitCodeFileEdit(editor) {
    if (commitInProgress) return;
    const newContent = editor.value;
    editingIndex = -1;

    if (newContent === rawContent) {
      renderBlocks();
      return;
    }

    commitInProgress = true;
    const saved = await saveFile(newContent);
    if (saved) {
      rawContent = newContent;
    }
    commitInProgress = false;
    renderBlocks();
  }

  function renderMdBlockView(wrapper, block, index) {
    const rendered = document.createElement("div");
    rendered.className = "wm-writer-block__rendered";

    if (block.type === "frontmatter") {
      rendered.innerHTML = `<pre><code>${escapeHtml(block.raw)}</code></pre>`;
    } else if (block.type === "hr") {
      rendered.innerHTML = "<hr />";
    } else {
      const previewMarkdown = rewriteMarkdownImagePathsForPreview(block.raw, fileDirectory);
      rendered.innerHTML = renderMarkdownToHtml(previewMarkdown);
      requestAnimationFrame(() => {
        void renderMermaidDiagrams(rendered);
      });
    }

    rendered.addEventListener("click", () => {
      if (editingIndex >= 0 && editingIndex !== index) {
        commitEdit();
      }
      editingIndex = index;
      renderBlocks();
    });

    wrapper.append(rendered);
  }

  function renderEditor(wrapper, block, index) {
    const editor = document.createElement("textarea");
    editor.className = "wm-writer-block__editor";
    editor.value = block.raw;
    editor.spellcheck = true;

    // Auto-height
    function autoResize() {
      resizeTextareaPreserveScroll(editor);
    }

    editor.addEventListener("input", autoResize);
    editor.addEventListener("paste", (event) => {
      void handleEditorPaste(event, editor);
    });

    editor.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit(index);
      }
    });

    editor.addEventListener("blur", () => {
      commitEdit();
    });

    wrapper.append(editor);
    // Focus after append
    requestAnimationFrame(() => {
      autoResize();
      focusEditorWithoutScroll(editor);
    });
  }

  // ── Edit operations ──────────────────────────────────────────

  async function commitEdit() {
    if (commitInProgress) return;
    if (editingIndex < 0 || editingIndex >= blocks.length) {
      editingIndex = -1;
      return;
    }
    const editor = blocksContainer.querySelector(".wm-writer-block__editor");
    if (!editor) {
      editingIndex = -1;
      renderBlocks();
      return;
    }

    commitInProgress = true;
    const newRaw = editor.value;
    const changedIndex = editingIndex;
    editingIndex = -1;

    if (newRaw === blocks[changedIndex].raw) {
      commitInProgress = false;
      renderBlocks();
      return;
    }

    // Build the full content with the edited block replaced
    const fullContent = blocks.map((b, idx) =>
      idx === changedIndex ? newRaw : b.raw
    ).join("\n\n");

    const saved = await saveFile(fullContent);
    if (saved) {
      blocks = parseMarkdownBlocks(fullContent);
    }
    commitInProgress = false;
    renderBlocks();
  }

  function cancelEdit(index) {
    editingIndex = -1;
    renderBlocks();
  }

  // ── Polling for external changes ─────────────────────────────

  async function checkForChanges() {
    if (destroyed || editingIndex >= 0) return;
    try {
      const resp = await fetch(`/api/docs/file/raw?path=${encodeURIComponent(targetFile)}`);
      if (!resp.ok) return;
      const data = await resp.json();
      const mtime = data.mtimeMs ?? null;
      if (mtime !== null && lastMtimeMs !== null && mtime !== lastMtimeMs) {
        const content = data.base64
          ? decodeBytesToText(decodeBase64ToUint8Array(data.base64))
          : "";
        lastMtimeMs = mtime;
        rawContent = content;
        blocks = mdMode ? parseMarkdownBlocks(content) : [];
        renderBlocks();
      }
    } catch {
      // Silently skip poll errors
    }
  }

  async function refreshContent() {
    const content = await loadFile();
    if (content !== null) {
      rawContent = content;
      blocks = mdMode ? parseMarkdownBlocks(content) : [];
      editingIndex = -1;
      renderBlocks();
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

  // ── Lifecycle ────────────────────────────────────────────────

  function cleanup() {
    destroyed = true;
    stopPolling();
  }

  // Initial load
  showLoading();
  loadFile().then((content) => {
    if (destroyed) return;
    if (content !== null) {
      rawContent = content;
      blocks = mdMode ? parseMarkdownBlocks(content) : [];
      renderBlocks();
      startPolling();
    }
  });

  return { panel, cleanup };
}
