export function buildDocsFileDownloadUrl(path, options = {}) {
  const url = new URL("/api/docs/file/download", window.location.origin);
  url.searchParams.set("path", path);
  if (options.inline) {
    url.searchParams.set("inline", "1");
  }
  return `${url.pathname}${url.search}`;
}
