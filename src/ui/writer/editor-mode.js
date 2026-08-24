const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);

export function getFileExtension(filePath) {
  const normalized = String(filePath ?? "").toLowerCase();
  const slash = normalized.lastIndexOf("/");
  const basename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dot = basename.lastIndexOf(".");
  return dot >= 0 ? basename.slice(dot) : "";
}

export function shouldUseTiptapForFile(filePath) {
  return MARKDOWN_EXTENSIONS.has(getFileExtension(filePath));
}
