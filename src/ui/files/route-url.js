export const FILES_ROUTE_PREFIX = "/files";
export const DOCS_ROUTE_PREFIX = "/docs";

export function isDocsRoutePath(pathname) {
  return pathname === DOCS_ROUTE_PREFIX || pathname.startsWith(`${DOCS_ROUTE_PREFIX}/`);
}

export function isFilesRoutePath(pathname) {
  return pathname === FILES_ROUTE_PREFIX || pathname.startsWith(`${FILES_ROUTE_PREFIX}/`);
}

export function getFilesRoutePrefixForPath(pathname) {
  return isDocsRoutePath(pathname) ? DOCS_ROUTE_PREFIX : FILES_ROUTE_PREFIX;
}

export function getFilesSurfaceFromPath(pathname) {
  return isDocsRoutePath(pathname) ? "docs" : "files";
}

export function buildFilesPreviewRoutePath(filePath, options = {}) {
  const path = typeof filePath === "string" ? filePath.trim() : "";
  const routePrefix = options.routePrefix === DOCS_ROUTE_PREFIX ? DOCS_ROUTE_PREFIX : FILES_ROUTE_PREFIX;
  if (!path) return routePrefix;
  return `${routePrefix}/${encodeURIComponent(path)}`;
}

function normalizeWorkspaceRoot(value) {
  const root = typeof value === "string" ? value.trim() : "";
  if (!root || !root.startsWith("/")) return "";
  return root.replace(/\/+$/, "") || "/";
}

function buildRouteFromRelativePath(relativePath, routePrefix) {
  const cleaned = String(relativePath ?? "")
    .split("/")
    .filter((part) => part.length > 0);
  if (cleaned.length === 0) return routePrefix;
  return `${routePrefix}/${cleaned.map((part) => encodeURIComponent(part)).join("/")}`;
}

export function buildFilesRouteForWorkspacePath(filePath, options = {}) {
  const path = typeof filePath === "string" ? filePath.trim() : "";
  const defaultDirectory = normalizeWorkspaceRoot(options.defaultDirectory);
  const routePrefix = options.routePrefix === DOCS_ROUTE_PREFIX ? DOCS_ROUTE_PREFIX : FILES_ROUTE_PREFIX;
  if (!path || !path.startsWith("/") || !defaultDirectory) return null;
  const rootBoundary = defaultDirectory === "/" ? "/" : `${defaultDirectory}/`;
  if (path !== defaultDirectory && !path.startsWith(rootBoundary)) return null;
  const relativePath = defaultDirectory === "/" ? path.slice(1) : path.slice(rootBoundary.length);
  return buildRouteFromRelativePath(relativePath, routePrefix);
}

export function rewriteWorkspaceUrlToFilesRoute(value, options = {}) {
  const rawUrl = typeof value === "string" ? value.trim() : "";
  if (!rawUrl) return null;
  const baseUrl = options.baseUrl || globalThis.window?.location?.origin || "http://localhost";
  let parsed;
  let base;
  try {
    parsed = new URL(rawUrl, baseUrl);
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.origin !== base.origin) return null;
  let filePath;
  try {
    filePath = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const filesRoute = buildFilesRouteForWorkspacePath(filePath, options);
  if (!filesRoute) return null;
  return `${filesRoute}${parsed.search}${parsed.hash}`;
}
