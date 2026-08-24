import { renderMarkdownToHtml } from "../rendering/markdown.js";
import { toDisplayImageSrc } from "./file-paths.js";
import { uploadPastedImage } from "./image-paste.js";

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function createDisclosureButton({ text, expanded = false, controls }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-tiptap-comments__toggle";
  button.textContent = text;
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (controls) button.setAttribute("aria-controls", controls);
  return button;
}

function rewriteCommentImageSources(markdown, fileDirectory) {
  return String(markdown ?? "").replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt, rawSrc) => {
    return `![${alt}](${toDisplayImageSrc(fileDirectory, rawSrc)})`;
  });
}

function renderCommentBody(body, fileDirectory) {
  return renderMarkdownToHtml(rewriteCommentImageSources(body, fileDirectory));
}

function getImageFilesFromPaste(event) {
  return Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file) => file instanceof File);
}

function insertTextAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const prefix = textarea.value.slice(0, start);
  const suffix = textarea.value.slice(end);
  const spacerBefore = prefix && !prefix.endsWith("\n") ? "\n" : "";
  const spacerAfter = suffix && !suffix.startsWith("\n") ? "\n" : "";
  textarea.value = `${prefix}${spacerBefore}${text}${spacerAfter}${suffix}`;
  const nextPosition = prefix.length + spacerBefore.length + text.length;
  textarea.setSelectionRange(nextPosition, nextPosition);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function createImageUploadButton(textarea, deps) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.hidden = true;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-tiptap-comments__image";
  button.textContent = "Image";
  button.setAttribute("aria-label", "Add image to comment");
  button.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    void uploadCommentImages(Array.from(input.files ?? []), textarea, deps).finally(() => {
      input.value = "";
    });
  });
  return { button, input };
}

async function uploadCommentImages(files, textarea, deps) {
  const images = files.filter((file) => file instanceof File && String(file.type || "").startsWith("image/"));
  if (images.length === 0) return;
  let uploaded = 0;
  for (const image of images) {
    try {
      const savedName = await uploadPastedImage(image, deps.fileDirectory);
      insertTextAtCursor(textarea, `![${savedName}](${savedName})`);
      uploaded += 1;
    } catch (error) {
      deps.showToast?.(error instanceof Error ? error.message : "Failed to upload comment image", { type: "error" });
    }
  }
  if (uploaded > 0) {
    deps.showToast?.(`Uploaded ${uploaded} comment image${uploaded > 1 ? "s" : ""}`, { duration: 2000 });
  }
}

function wireCommentImagePaste(textarea, deps) {
  textarea.addEventListener("paste", (event) => {
    const images = getImageFilesFromPaste(event);
    if (images.length === 0) return;
    event.preventDefault();
    void uploadCommentImages(images, textarea, deps);
  });
}

function appendCommentFormActions(form, textarea, deps, submitButton) {
  const actions = document.createElement("div");
  actions.className = "wm-tiptap-comments__form-actions";
  const upload = createImageUploadButton(textarea, deps);
  actions.append(upload.button, upload.input, submitButton);
  form.append(actions);
  wireCommentImagePaste(textarea, deps);
}

function renderThread(thread, deps) {
  const item = document.createElement("article");
  item.className = "wm-tiptap-comments__thread";
  item.dataset.status = thread.status || "open";
  item.dataset.active = deps.activeThreadId === thread.id ? "true" : "false";
  item.dataset.threadId = thread.id;
  item.dataset.testid = "tiptap-comment-thread";
  item.tabIndex = 0;
  item.setAttribute("role", "button");
  item.setAttribute("aria-label", "Show comment anchor in document");
  item.setAttribute("aria-pressed", deps.activeThreadId === thread.id ? "true" : "false");
  item.addEventListener("click", () => {
    deps.onSelectThread?.(thread.id);
  });
  item.addEventListener("keydown", (event) => {
    if (event.target !== item) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    deps.onSelectThread?.(thread.id);
  });

  const header = document.createElement("div");
  header.className = "wm-tiptap-comments__thread-header";
  const quote = document.createElement("blockquote");
  quote.textContent = thread.anchor?.text || "Unanchored comment";
  header.append(quote);

  const statusButton = document.createElement("button");
  statusButton.type = "button";
  statusButton.className = "wm-tiptap-comments__status";
  statusButton.textContent = thread.status === "resolved" ? "Reopen" : "Resolve";
  statusButton.setAttribute("aria-label", thread.status === "resolved" ? "Reopen comment thread" : "Resolve comment thread");
  statusButton.addEventListener("click", (event) => {
    event.stopPropagation();
    deps.onSetStatus?.(thread.id, thread.status === "resolved" ? "open" : "resolved");
  });
  header.append(statusButton);
  item.append(header);

  if (thread.anchor?.blockHint) {
    const hint = document.createElement("div");
    hint.className = "wm-tiptap-comments__hint";
    hint.textContent = thread.anchor.blockHint;
    item.append(hint);
  }

  const messages = document.createElement("div");
  messages.className = "wm-tiptap-comments__messages";
  for (const message of thread.messages || []) {
    const row = document.createElement("div");
    row.className = "wm-tiptap-comments__message";
    const meta = document.createElement("div");
    meta.className = "wm-tiptap-comments__meta";
    meta.textContent = [message.author, formatTimestamp(message.createdAt)].filter(Boolean).join(" · ");
    const body = document.createElement("div");
    body.className = "wm-tiptap-comments__message-body";
    body.innerHTML = renderCommentBody(message.body, deps.fileDirectory);
    row.append(meta, body);
    messages.append(row);
  }
  item.append(messages);

  const footer = document.createElement("div");
  footer.className = "wm-tiptap-comments__thread-actions";
  const replyToggle = createDisclosureButton({ text: "Reply" });
  footer.append(replyToggle);
  item.append(footer);

  const replyForm = document.createElement("form");
  replyForm.className = "wm-tiptap-comments__reply";
  replyForm.hidden = true;
  const replyInput = document.createElement("textarea");
  replyInput.rows = 2;
  replyInput.placeholder = "Reply";
  replyInput.setAttribute("aria-label", "Reply to comment thread");
  const replyButton = document.createElement("button");
  replyButton.type = "submit";
  replyButton.className = "wm-button secondary";
  replyButton.textContent = "Send reply";
  replyForm.append(replyInput);
  appendCommentFormActions(replyForm, replyInput, deps, replyButton);
  replyToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = replyToggle.getAttribute("aria-expanded") === "true";
    replyToggle.setAttribute("aria-expanded", isOpen ? "false" : "true");
    replyForm.hidden = isOpen;
  });
  replyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.onAddReply?.(thread.id, replyInput.value);
  });
  replyForm.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  item.append(replyForm);

  return item;
}

export function createCommentsPanel({
  threads = [],
  onPrepareThread,
  onAddThread,
  onAddReply,
  onSetStatus,
  onSelectThread,
  onOpenChange,
  activeThreadId = null,
  defaultOpen = false,
  fileDirectory = "",
  showToast,
} = {}) {
  const deps = { onAddReply, onSetStatus, onSelectThread, activeThreadId, fileDirectory, showToast };
  const panel = document.createElement("aside");
  panel.className = "wm-tiptap-comments";
  panel.dataset.testid = "tiptap-comments-panel";
  panel.dataset.expanded = defaultOpen ? "true" : "false";
  panel.setAttribute("aria-label", "Markdown comments");
  const bodyId = `tiptap-comments-${Math.random().toString(36).slice(2)}`;

  const header = document.createElement("div");
  header.className = "wm-tiptap-comments__header";
  const headerText = document.createElement("div");
  headerText.className = "wm-tiptap-comments__header-text";
  const title = document.createElement("h3");
  title.textContent = "Comments";
  const count = document.createElement("span");
  count.className = "wm-tiptap-comments__count";
  count.textContent = String(threads.length);
  headerText.append(title, count);
  const panelToggle = createDisclosureButton({
    text: defaultOpen ? "Hide comments" : (threads.length > 0 ? "Show comments" : "Add comment"),
    expanded: defaultOpen,
    controls: bodyId,
  });
  header.append(headerText, panelToggle);
  panel.append(header);

  const body = document.createElement("div");
  body.id = bodyId;
  body.className = "wm-tiptap-comments__body";
  body.hidden = !defaultOpen;
  panel.append(body);

  const newToggle = createDisclosureButton({ text: "Comment on selection" });
  newToggle.classList.add("wm-tiptap-comments__new-toggle");
  body.append(newToggle);
  let pendingThreadAnchor = null;

  const form = document.createElement("form");
  form.className = "wm-tiptap-comments__new";
  form.hidden = true;
  const textarea = document.createElement("textarea");
  textarea.rows = 3;
  textarea.placeholder = "Comment on selection";
  textarea.setAttribute("aria-label", "New comment body");
  textarea.dataset.testid = "tiptap-new-comment-input";
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "wm-button";
  button.textContent = "Add comment";
  button.dataset.testid = "tiptap-add-comment-button";
  form.append(textarea);
  appendCommentFormActions(form, textarea, { fileDirectory, showToast }, button);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onAddThread?.(textarea.value, pendingThreadAnchor);
    pendingThreadAnchor = null;
  });
  newToggle.addEventListener("click", () => {
    const isOpen = newToggle.getAttribute("aria-expanded") === "true";
    if (!isOpen) {
      pendingThreadAnchor = onPrepareThread?.() ?? null;
      if (!pendingThreadAnchor) return;
    } else {
      pendingThreadAnchor = null;
    }
    newToggle.setAttribute("aria-expanded", isOpen ? "false" : "true");
    form.hidden = isOpen;
  });
  body.append(form);

  const list = document.createElement("div");
  list.className = "wm-tiptap-comments__list";
  if (threads.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wm-tiptap-comments__empty";
    empty.textContent = "No comments";
    list.append(empty);
  } else {
    for (const thread of threads) {
      list.append(renderThread(thread, deps));
    }
  }
  body.append(list);

  panelToggle.addEventListener("click", () => {
    const isOpen = panelToggle.getAttribute("aria-expanded") === "true";
    panelToggle.setAttribute("aria-expanded", isOpen ? "false" : "true");
    body.hidden = isOpen;
    panel.dataset.expanded = isOpen ? "false" : "true";
    onOpenChange?.(!isOpen);
    panelToggle.textContent = isOpen
      ? (threads.length > 0 ? "Show comments" : "Add comment")
      : "Hide comments";
  });

  return panel;
}
