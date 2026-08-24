import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { gzipSync } from "bun";

// ── Gzip compression helper ────────────────────────────────────────

const COMPRESSIBLE_TYPES = new Set([
  "application/javascript",
  "text/css",
  "text/html",
  "application/json",
  "text/plain",
  "image/svg+xml",
]);

function isCompressible(contentType: string | null): boolean {
  if (!contentType) return false;
  const base = (contentType.split(";")[0] ?? "").trim();
  return COMPRESSIBLE_TYPES.has(base);
}

/**
 * Wraps a Response with gzip compression if the client accepts it and the
 * content type is compressible. Returns the original response unchanged for
 * non-compressible types, tiny payloads, or clients that don't accept gzip.
 */
export async function compressResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  const accept = request.headers.get("accept-encoding") ?? "";
  if (!accept.includes("gzip")) return response;

  const contentType = response.headers.get("content-type");
  if (!isCompressible(contentType)) return response;

  const body = await response.arrayBuffer();
  if (body.byteLength < 256) return new Response(body, { status: response.status, headers: response.headers });

  const compressed = gzipSync(new Uint8Array(body));
  const headers = new Headers(response.headers);
  headers.set("content-encoding", "gzip");
  headers.set("content-length", String(compressed.byteLength));
  headers.delete("content-length"); // let runtime set if needed
  headers.set("vary", "Accept-Encoding");
  return new Response(compressed, { status: response.status, headers });
}

// ── Vendor module gzip cache ────────────────────────────────────────

const vendorGzipCache = new Map<string, { data: Uint8Array; headers: Record<string, string> }>();

const uiAssetMap: Record<string, { url: URL; type: string }> = {
  "/app.js": { url: new URL("../ui/app.js", import.meta.url), type: "application/javascript; charset=utf-8" },
  "/styles.css": { url: new URL("../ui/styles.css", import.meta.url), type: "text/css; charset=utf-8" },
  "/identity/index.js": {
    url: new URL("../ui/identity/index.js", import.meta.url),
    type: "application/javascript; charset=utf-8",
  },
  "/todos/index.js": {
    url: new URL("../ui/todos/index.js", import.meta.url),
    type: "application/javascript; charset=utf-8",
  },
  "/logging/browser.js": {
    url: new URL("../ui/logging/browser.js", import.meta.url),
    type: "application/javascript; charset=utf-8",
  },
};

export interface VendorPackageDescriptor {
  root: string;
  boundary: string;
  entry: string;
}

export interface StaticAssetServiceOptions {
  publicRoot: string;
  publicRootBoundary: string;
  aceRoot: string;
  aceRootBoundary: string;
  vendorPackages: Record<string, VendorPackageDescriptor>;
}

export interface StaticAssetService {
  resolveUiAsset: (pathname: string) => Response | undefined;
  servePublicAsset: (pathname: string) => Response | undefined;
  serveAceBuildsAsset: (pathname: string) => Response | undefined;
  serveVendorModule: (pathname: string) => Promise<Response | undefined>;
  isUiAssetPath: (pathname: string) => boolean;
}

const require = createRequire(import.meta.url);

const resolvePackageRoot = (specifier: string) => {
  try {
    const packageJsonPath = require.resolve(`${specifier}/package.json`);
    return normalize(join(packageJsonPath, ".."));
  } catch (error) {
    try {
      let current = dirname(require.resolve(specifier));
      while (current && current !== dirname(current)) {
        if (existsSync(join(current, "package.json"))) {
          return normalize(current);
        }
        current = dirname(current);
      }
    } catch {
      // Fall through to the original warning.
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[static] failed to resolve package root for ${specifier}: ${message}`);
    return undefined;
  }
};

const withBoundary = (path: string) => path.endsWith(sep) ? path : `${path}${sep}`;

export const createProjectStaticAssetService = (projectRoot: string): StaticAssetService => {
  const resolvedAceBuildsRoot = resolvePackageRoot("ace-builds");
  const aceBuildsRoot = resolvedAceBuildsRoot ?? normalize(join(projectRoot, "node_modules", "ace-builds"));
  const vendorPackages: Record<string, VendorPackageDescriptor> = {};
  const registerVendorPackage = (name: string, relative: string, entry = "index.js") => {
    const root = resolvePackageRoot(name);
    if (!root) return;
    const resolved = normalize(join(root, relative));
    vendorPackages[name] = {
      root: resolved,
      boundary: withBoundary(resolved),
      entry,
    };
  };

  registerVendorPackage("@noble/hashes", "esm");
  registerVendorPackage("@noble/ciphers", "esm");
  registerVendorPackage("@scure/base", join("lib", "esm"));
  // @noble/curves v2 publishes its browser ESM files from the package root.
  // v1 used an `esm/` directory, so keeping the old root makes every curves
  // import (including secp256k1 used by browser signing) resolve to a 404.
  registerVendorPackage("@noble/curves", "");
  registerVendorPackage("mermaid", "dist", "mermaid.esm.min.mjs");
  registerVendorPackage("nostr-tools", join("lib", "esm"));
  registerVendorPackage("dexie", "dist", "dexie.mjs");
  registerVendorPackage("alpinejs", "dist", "module.esm.js");
  registerVendorPackage("@xterm/xterm", "", join("lib", "xterm.mjs"));
  registerVendorPackage("@xterm/addon-fit", "", join("lib", "addon-fit.mjs"));
  registerVendorPackage("@tiptap/core", "dist");
  registerVendorPackage("@tiptap/starter-kit", "dist");
  registerVendorPackage("@tiptap/extension-blockquote", "dist");
  registerVendorPackage("@tiptap/extension-bold", "dist");
  registerVendorPackage("@tiptap/extension-code", "dist");
  registerVendorPackage("@tiptap/extension-code-block", "dist");
  registerVendorPackage("@tiptap/extension-document", "dist");
  registerVendorPackage("@tiptap/extension-hard-break", "dist");
  registerVendorPackage("@tiptap/extension-heading", "dist");
  registerVendorPackage("@tiptap/extension-horizontal-rule", "dist");
  registerVendorPackage("@tiptap/extension-image", "dist");
  registerVendorPackage("@tiptap/extension-italic", "dist");
  registerVendorPackage("@tiptap/extension-link", "dist");
  registerVendorPackage("@tiptap/extension-list", "dist");
  registerVendorPackage("@tiptap/extension-paragraph", "dist");
  registerVendorPackage("@tiptap/extension-placeholder", "dist");
  registerVendorPackage("@tiptap/extension-strike", "dist");
  registerVendorPackage("@tiptap/extension-task-item", "dist");
  registerVendorPackage("@tiptap/extension-task-list", "dist");
  registerVendorPackage("@tiptap/extension-text", "dist");
  registerVendorPackage("@tiptap/extension-underline", "dist");
  registerVendorPackage("@tiptap/extensions", "dist");
  registerVendorPackage("@tiptap/pm", "dist");
  registerVendorPackage("linkifyjs", "dist", "linkify.mjs");

  const publicRoot = normalize(join(projectRoot, "public"));
  return createStaticAssetService({
    publicRoot,
    publicRootBoundary: withBoundary(publicRoot),
    aceRoot: aceBuildsRoot,
    aceRootBoundary: withBoundary(aceBuildsRoot),
    vendorPackages,
  });
};

const resolveUiAsset = (pathname: string): Response | undefined => {
  const asset = uiAssetMap[pathname];
  if (!asset) return undefined;
  const file = Bun.file(asset.url);
  if (!file.size) return undefined;
  return new Response(file, {
    headers: {
      "content-type": asset.type,
      "cache-control": "no-cache",
    },
  });
};

export const createStaticAssetService = (options: StaticAssetServiceOptions): StaticAssetService => {
  const { publicRoot, publicRootBoundary, aceRoot, aceRootBoundary, vendorPackages } = options;
  const uiAssetPaths = new Set(Object.keys(uiAssetMap));
  const vendorPackageNames = Object.keys(vendorPackages);
  const uiRootPath = normalize(fileURLToPath(new URL("../ui", import.meta.url)));
  const uiRootBoundary = uiRootPath.endsWith(sep) ? uiRootPath : `${uiRootPath}${sep}`;

  const isWithinUiBoundary = (candidate: string) => {
    return candidate === uiRootPath || candidate.startsWith(uiRootBoundary);
  };

  const deriveUiAssetType = (extension: string, fallback?: string) => {
    switch (extension) {
      case ".js":
      case ".mjs":
        return "application/javascript; charset=utf-8";
      case ".css":
        return "text/css; charset=utf-8";
      case ".json":
      case ".map":
        return "application/json; charset=utf-8";
      default:
        return fallback;
    }
  };

  const resolveDynamicUiAsset = (pathname: string): Response | undefined => {
    const ext = extname(pathname).toLowerCase();
    if (!ext) return undefined;
    if (!pathname.startsWith("/")) return undefined;
    const relativePath = pathname.slice(1);
    if (!relativePath) return undefined;

    const candidate = normalize(join(uiRootPath, relativePath));
    if (!isWithinUiBoundary(candidate)) {
      console.warn(`[static] rejected ui asset outside boundary: ${pathname}`);
      return undefined;
    }

    const file = Bun.file(candidate);
    if (!file.size) return undefined;

    const type = deriveUiAssetType(ext, file.type || undefined);
    return new Response(file, {
      headers: {
        ...(type ? { "content-type": type } : {}),
        "cache-control": "no-cache",
      },
    });
  };

  const rewriteVendorModuleSpecifiers = (source: string) => {
    if (vendorPackageNames.length === 0) {
      return source;
    }
    let updated = source;
    for (const packageName of vendorPackageNames) {
      if (!updated.includes(packageName)) continue;
      const vendorPrefix = `/vendor/${packageName}`;
      updated = updated.replaceAll(`'${packageName}`, `'${vendorPrefix}`);
      updated = updated.replaceAll(`"${packageName}`, `"${vendorPrefix}`);
      updated = updated.replaceAll(`\`${packageName}`, `\`${vendorPrefix}`);
    }
    return updated;
  };

  const servePublicAsset = (pathname: string): Response | undefined => {
    const normalized = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    if (!normalized) return undefined;
    const candidate = normalize(join(publicRoot, normalized));
    if (!candidate.startsWith(publicRootBoundary)) {
      console.warn(`[static] rejected public asset outside boundary: ${pathname}`);
      return undefined;
    }
    const file = Bun.file(candidate);
    if (!file.size) return undefined;

    const type = file.type || undefined;
    return new Response(file, {
      headers: {
        ...(type ? { "content-type": type } : {}),
        "cache-control": "public, max-age=3600",
      },
    });
  };

  const serveAceBuildsAsset = (pathname: string): Response | undefined => {
    if (!pathname.startsWith("/ace-builds/")) return undefined;
    const suffix = pathname.slice("/ace-builds/".length);
    if (suffix.length === 0) return undefined;
    const candidate = normalize(join(aceRoot, suffix));
    if (!candidate.startsWith(aceRootBoundary)) {
      return undefined;
    }
    const file = Bun.file(candidate);
    if (!file.size) return undefined;
    const ext = extname(candidate).toLowerCase();
    const type =
      ext === ".js" || ext === ".mjs"
        ? "application/javascript; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : file.type || undefined;
    return new Response(file, {
      headers: {
        ...(type ? { "content-type": type } : {}),
        "cache-control": "public, max-age=86400",
      },
    });
  };

  const serveVendorModule = async (pathname: string): Promise<Response | undefined> => {
    if (!pathname.startsWith("/vendor/")) return undefined;
    const suffix = pathname.slice("/vendor/".length);
    if (!suffix) return undefined;

    const segments = suffix.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) return undefined;
    if (segments.some((segment) => segment === "." || segment === "..")) return undefined;

    let packageName: string;
    let relativeSegments: string[];
    const firstSegment = segments[0];
    if (!firstSegment) return undefined;
    if (firstSegment.startsWith("@")) {
      if (segments.length < 2) return undefined;
      const scopePackage = segments[1];
      if (!scopePackage) return undefined;
      packageName = `${firstSegment}/${scopePackage}`;
      relativeSegments = segments.slice(2);
    } else {
      packageName = firstSegment;
      relativeSegments = segments.slice(1);
    }
    if (relativeSegments.some((segment) => segment === "." || segment === "..")) return undefined;

    const vendor = vendorPackages[packageName];
    if (!vendor) return undefined;
    const relativePath = relativeSegments.length > 0 ? join(...relativeSegments) : vendor.entry;
    const resolveCandidate = (basePath: string) => {
      const normalized = normalize(join(vendor.root, basePath));
      if (!normalized.startsWith(vendor.boundary)) {
        return undefined;
      }
      const attemptPaths: string[] = [];
      const extension = extname(normalized);
      if (extension) {
        attemptPaths.push(normalized);
      } else {
        attemptPaths.push(`${normalized}.js`, join(normalized, "index.js"));
        if (vendor.entry && vendor.entry !== "index.js") {
          attemptPaths.push(join(normalized, vendor.entry));
        }
      }
      for (const attempt of attemptPaths) {
        const attemptFile = Bun.file(attempt);
        if (attemptFile.size) {
          return { file: attemptFile, path: attempt };
        }
      }
      return undefined;
    };

    const resolved = resolveCandidate(relativePath);
    if (!resolved) {
      console.warn(`[static] failed to resolve vendor asset: ${pathname}`);
      return undefined;
    }

    const { file, path: resolvedPath } = resolved;
    const extension = extname(resolvedPath).toLowerCase();
    const type =
      extension === ".js" || extension === ".mjs"
        ? "application/javascript; charset=utf-8"
        : extension === ".css"
          ? "text/css; charset=utf-8"
          : extension === ".json" || extension === ".map"
            ? "application/json; charset=utf-8"
            : file.type || undefined;

    const headers: Record<string, string> = {
      ...(type ? { "content-type": type } : {}),
      "cache-control": "public, max-age=86400",
    };

    if (extension === ".js" || extension === ".mjs") {
      // Cache rewritten + gzipped vendor JS to avoid repeated work
      const cached = vendorGzipCache.get(pathname);
      if (cached) {
        return new Response(cached.data, { headers: { ...cached.headers } });
      }
      const source = await file.text();
      const rewritten = rewriteVendorModuleSpecifiers(source);
      const compressed = gzipSync(new TextEncoder().encode(rewritten) as Uint8Array<ArrayBuffer>);
      const gzHeaders: Record<string, string> = {
        ...headers,
        "content-encoding": "gzip",
        "vary": "Accept-Encoding",
      };
      vendorGzipCache.set(pathname, { data: compressed, headers: gzHeaders });
      return new Response(compressed, { headers: { ...gzHeaders } });
    }

    return new Response(file, { headers });
  };

  return {
    resolveUiAsset: (pathname: string) => resolveUiAsset(pathname) ?? resolveDynamicUiAsset(pathname),
    servePublicAsset,
    serveAceBuildsAsset,
    serveVendorModule,
    isUiAssetPath: (pathname: string) => {
      if (uiAssetPaths.has(pathname)) return true;
      const ext = extname(pathname).toLowerCase();
      if (!ext) return false;
      if (!pathname.startsWith("/")) return false;
      const relativePath = pathname.slice(1);
      if (!relativePath) return false;
      const candidate = normalize(join(uiRootPath, relativePath));
      if (!isWithinUiBoundary(candidate)) return false;
      const file = Bun.file(candidate);
      return file.size > 0;
    },
  };
};
