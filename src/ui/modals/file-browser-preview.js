import {
  createCsvPreview,
  createJsonPreview,
  createPdfPreview,
} from "../files/preview-renderers.js";
import { buildDocsFileDownloadUrl } from "../files/download-url.js";
import { renderCodeToHtml, renderMarkdownToHtml } from "../rendering/markdown.js";
import { renderMermaidDiagrams } from "../rendering/mermaid.js";

export async function fetchFileBrowserDirectory(path, showHidden = false) {
  const url = new URL("/api/docs/tree", window.location.origin);
  if (path) {
    url.searchParams.set("path", path);
  }
  if (showHidden) {
    url.searchParams.set("showHidden", "1");
  }
  const response = await fetch(url.toString(), { method: "GET" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : response.statusText || "Failed to load directory");
  }
  return payload;
}

export async function fetchFileBrowserPreview(path) {
  const url = new URL("/api/docs/file", window.location.origin);
  url.searchParams.set("path", path);
  const response = await fetch(url.toString(), { method: "GET" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : response.statusText || "Failed to load file");
  }
  return payload;
}

function createImagePreview(preview) {
  const container = document.createElement("div");
  container.className = "wm-files-preview-image";

  const image = document.createElement("img");
  image.src = preview.previewUrl || buildDocsFileDownloadUrl(preview.path, { inline: true });
  image.alt = preview.name || "Image preview";
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

export function createFileBrowserPreviewContent(preview) {
  const body = document.createElement("div");
  body.className = "wm-command-file-browser__preview-body";

  if (!preview?.path) {
    body.dataset.empty = "true";
    body.textContent = "Select a previewable file.";
    return body;
  }

  if (preview.loading) {
    body.dataset.loading = "true";
    body.textContent = "Loading preview...";
    return body;
  }

  if (preview.error) {
    const error = document.createElement("div");
    error.className = "wm-files-browser__status";
    error.textContent = preview.error;
    body.append(error);
    return body;
  }

  if (preview.format === "image") {
    body.append(createImagePreview(preview));
    return body;
  }

  if (preview.format === "pdf") {
    body.append(createPdfPreview({
      previewName: preview.name,
      previewPath: preview.path,
    }, (path) => buildDocsFileDownloadUrl(path, { inline: true })));
    return body;
  }

  if (preview.format === "json" && preview.content !== null) {
    body.append(createJsonPreview(preview.content));
    return body;
  }

  if (preview.format === "csv" && preview.content !== null) {
    body.append(createCsvPreview(preview.content, preview.language));
    return body;
  }

  if (preview.format === "markdown" && preview.content !== null) {
    const article = document.createElement("article");
    article.className = "wm-files-preview-content";
    article.innerHTML = renderMarkdownToHtml(preview.content);
    requestAnimationFrame(() => {
      void renderMermaidDiagrams(article);
    });
    body.append(article);
    return body;
  }

  if (preview.content !== null) {
    const code = document.createElement("div");
    code.className = "wm-files-preview-code";
    code.innerHTML = renderCodeToHtml(preview.content, preview.language || "text");
    body.append(code);
    return body;
  }

  body.dataset.empty = "true";
  body.textContent = "Preview unavailable.";
  return body;
}

export function createPreviewStateFromPayload(payload, fallbackPath) {
  const resolvedPath = payload?.path ?? fallbackPath;
  return {
    path: resolvedPath,
    relativePath: payload?.relativePath ?? "",
    displayPath: payload?.displayPath ?? "",
    name: payload?.name ?? null,
    content: payload?.content ?? "",
    format: payload?.format ?? null,
    language: payload?.language ?? null,
    label: payload?.label ?? null,
    mimeType: payload?.mimeType ?? null,
    size: typeof payload?.size === "number" ? payload.size : null,
    previewUrl: payload?.format === "image"
      ? `/api/docs/file/download?path=${encodeURIComponent(resolvedPath)}&inline=1`
      : null,
    loading: false,
    error: null,
  };
}
