export function getParentDirectory(filePath) {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : normalized;
}

export function isAbsoluteOrSchemePath(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (text.startsWith("/") || text.startsWith("#")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(text);
}

export function normalisePosixPath(path) {
  const input = String(path ?? "").replace(/\\/g, "/");
  const isAbs = input.startsWith("/");
  const out = [];
  for (const part of input.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    } else {
      out.push(part);
    }
  }
  return `${isAbs ? "/" : ""}${out.join("/")}`;
}

export function resolveMarkdownAssetPath(baseDir, rawSrc) {
  const source = String(rawSrc ?? "").trim();
  if (!source || isAbsoluteOrSchemePath(source)) return source;
  return normalisePosixPath(`${baseDir}/${source}`);
}

export function buildDocsDownloadUrl(docPath) {
  return `/api/docs/file/download?path=${encodeURIComponent(docPath)}&inline=1`;
}

export function toDisplayImageSrc(baseDir, rawSrc) {
  const source = String(rawSrc ?? "").trim();
  if (!source) return "";
  if (isAbsoluteOrSchemePath(source)) return source;
  return buildDocsDownloadUrl(resolveMarkdownAssetPath(baseDir, source));
}

export function rewriteImageSourcesForDisplay(doc, baseDir) {
  const clone = JSON.parse(JSON.stringify(doc || { type: "doc", content: [] }));
  visitNodes(clone, (node) => {
    if (node?.type !== "image") return;
    const rawSrc = node.attrs?.rawSrc || node.attrs?.src || "";
    node.attrs = {
      ...(node.attrs || {}),
      rawSrc,
      src: toDisplayImageSrc(baseDir, rawSrc),
    };
  });
  return clone;
}

function visitNodes(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const child of Array.isArray(node.content) ? node.content : []) {
    visitNodes(child, visitor);
  }
}
