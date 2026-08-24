import { escapeHtml } from "../core/icons.js";
import { cleanAgentOutputText } from "./agent-output-format.js";
import { renderMarkdownToHtml } from "./markdown.js";

const MAX_RENDERED_MESSAGE_CACHE_ENTRIES = 600;
const renderedMessageHtmlCache = new Map();

function getWorkspaceLinksConfig(options = {}) {
  const defaultDirectory =
    typeof options.config?.defaultDirectory === "string" && options.config.defaultDirectory.length > 0
      ? options.config.defaultDirectory
      : null;
  if (!defaultDirectory) return null;
  return {
    defaultDirectory,
    baseUrl: globalThis.window?.location?.origin,
  };
}

function getWorkspaceLinksCacheKey(workspaceLinks) {
  if (!workspaceLinks) return "";
  return [
    workspaceLinks.defaultDirectory ?? "",
    workspaceLinks.baseUrl ?? "",
  ].join("|");
}

function hashText(value) {
  const text = String(value ?? "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildRenderedMessageCacheKey(text, options = {}, workspaceLinks = null) {
  const textLength = String(text ?? "").length;
  const explicitKey = typeof options.cacheKey === "string" && options.cacheKey.length > 0
    ? options.cacheKey
    : null;
  const updatedAt =
    typeof options.cacheUpdatedAt === "string" && options.cacheUpdatedAt.length > 0
      ? options.cacheUpdatedAt
      : null;
  const textVersion = explicitKey && updatedAt ? updatedAt : hashText(text);
  return [
    explicitKey ?? "content",
    textLength,
    textVersion,
    options.cleanAgentText === true ? "clean" : "raw",
    getWorkspaceLinksCacheKey(workspaceLinks),
  ].join("::");
}

function readRenderedMessageCache(cacheKey) {
  if (!renderedMessageHtmlCache.has(cacheKey)) {
    return null;
  }
  const html = renderedMessageHtmlCache.get(cacheKey);
  renderedMessageHtmlCache.delete(cacheKey);
  renderedMessageHtmlCache.set(cacheKey, html);
  return html;
}

function writeRenderedMessageCache(cacheKey, html) {
  renderedMessageHtmlCache.set(cacheKey, html);
  while (renderedMessageHtmlCache.size > MAX_RENDERED_MESSAGE_CACHE_ENTRIES) {
    const oldestKey = renderedMessageHtmlCache.keys().next().value;
    renderedMessageHtmlCache.delete(oldestKey);
  }
}

export function clearChatMessageHtmlCache() {
  renderedMessageHtmlCache.clear();
}

export function getChatMessageHtmlCacheStats() {
  return {
    size: renderedMessageHtmlCache.size,
    maxSize: MAX_RENDERED_MESSAGE_CACHE_ENTRIES,
  };
}

export function getChatMessageHtmlCacheOptions(message, context = {}) {
  if (!message || typeof message !== "object") {
    return {};
  }

  const stableId = message.id ?? message.messageId ?? message.createdAt ?? null;
  if (stableId === null || stableId === undefined || stableId === "") {
    return {};
  }

  const role = String(message.role ?? message.type ?? "assistant").toLowerCase();
  const sessionPart =
    typeof context.sessionId === "string" && context.sessionId.length > 0
      ? context.sessionId
      : "session";
  const updatedAt =
    typeof message.updatedAt === "string" && message.updatedAt.length > 0
      ? message.updatedAt
      : typeof message.createdAt === "string" && message.createdAt.length > 0
        ? message.createdAt
        : "";

  return {
    cacheKey: `${sessionPart}:${role}:${stableId}`,
    cacheUpdatedAt: updatedAt,
  };
}

export function renderChatMessageHtml(content, options = {}) {
  const text = options.cleanAgentText
    ? cleanAgentOutputText(content)
    : String(content ?? "").replace(/\r\n?/g, "\n");
  const workspaceLinks = getWorkspaceLinksConfig(options);
  const cacheKey = buildRenderedMessageCacheKey(text, options, workspaceLinks);
  const cachedHtml = readRenderedMessageCache(cacheKey);
  if (cachedHtml !== null) {
    return cachedHtml;
  }
  const html = renderMarkdownToHtml(text, {
    workspaceLinks,
  });
  writeRenderedMessageCache(cacheKey, html);
  return html;
}

function formatWorkingNotesLabels(label) {
  return {
    collapsed: `Show ${label.toLowerCase()}`,
    expanded: `Hide ${label.toLowerCase()}`,
  };
}

export function renderWorkingNotesHtml(content, options = {}) {
  const body = renderChatMessageHtml(content, options);
  const label = options.workingNotesLabel === "Tools" ? "Tools" : "Thinking";
  const labels = formatWorkingNotesLabels(label);
  const kind = label.toLowerCase();
  const panelKey =
    typeof options.workingNotesKey === "string" && options.workingNotesKey.length > 0
      ? ` data-working-notes-key="${escapeHtml(options.workingNotesKey)}"`
      : "";
  const openAttribute = options.workingNotesOpen === true ? " open" : "";
  return [
    `<details class="wm-message-working-notes" data-testid="message-working-notes" data-working-notes-kind="${kind}" data-working-notes-panel${panelKey}${openAttribute}>`,
    `<summary aria-label="Toggle ${kind} messages" data-testid="message-working-notes-summary">`,
    `<span class="wm-message-working-notes__summary-collapsed">${escapeHtml(labels.collapsed)}</span>`,
    `<span class="wm-message-working-notes__summary-expanded">${escapeHtml(labels.expanded)}</span>`,
    '</summary>',
    `<div class="wm-message-working-notes__body">${body}</div>`,
    `<button type="button" class="wm-message-working-notes__close" aria-label="Close ${kind} messages" data-testid="message-working-notes-close" data-working-notes-close data-working-notes-ignore-toggle>Close ${kind} messages</button>`,
    '</details>',
  ].join("");
}
