import {
  readFileAsUint8Array,
  encodeUint8ArrayToBase64,
} from "../core/encoding.js";

/**
 * Initialise files-related API helpers.
 *
 * @param {object} deps
 * @param {object} deps.state          - global UI state (files sub-object is mutated)
 * @param {() => string} deps.getCurrentRoute - getter for the mutable currentRoute variable
 * @param {() => void} deps.render     - re-render the UI
 * @param {string} deps.FILES_ROUTE    - route prefix, e.g. "/files"
 * @param {() => string} [deps.getFilesRoutePrefix] - returns the visible files/docs route prefix
 */
export function initFilesApi({ state, getCurrentRoute, render, FILES_ROUTE, getFilesRoutePrefix }) {

  function resetFilesPreview() {
    state.files.previewPath = null;
    state.files.previewRelativePath = null;
    state.files.previewDisplayPath = "";
    state.files.previewName = null;
    state.files.previewContent = null;
    state.files.previewLoading = false;
    state.files.previewError = null;
    state.files.previewFormat = null;
    state.files.previewLanguage = null;
    state.files.previewLabel = null;
    state.files.previewMimeType = null;
    state.files.previewSize = null;
    state.files.previewUrl = null;
  }

  /**
   * Build the browser URL for the current files view state and update the address bar.
   * Format: /files/<relativePath>[?file=<filename>]
   */
  function updateFilesUrl({ replace = false } = {}) {
    if (getCurrentRoute() !== "files") return;
    const routePrefix = typeof getFilesRoutePrefix === "function" ? getFilesRoutePrefix() : FILES_ROUTE;
    const dirRelative = state.files.relativePath || "";
    const slug = dirRelative ? `${routePrefix}/${dirRelative}` : routePrefix;
    const fileRelative = state.files.previewRelativePath || "";
    let target = slug;
    if (fileRelative) {
      target = `${routePrefix}/${fileRelative}`;
    }
    if (window.location.pathname === target) return;
    const stateObj = { route: "files" };
    if (replace) {
      window.history.replaceState(stateObj, "", target);
    } else {
      window.history.pushState(stateObj, "", target);
    }
  }

  /**
   * Extract a docs-root-relative path from the current URL when on the files route.
   * Returns { slug } where slug is the path after /files/.
   */
  function parseFilesPathFromUrl() {
    const pathname = window.location.pathname;
    const routePrefix = typeof getFilesRoutePrefix === "function" ? getFilesRoutePrefix() : FILES_ROUTE;
    const prefix = `${routePrefix}/`;
    if (!pathname.startsWith(prefix)) {
      return { slug: null };
    }
    const slug = decodeURIComponent(pathname.slice(prefix.length));
    return { slug: slug || null };
  }

  /**
   * Navigate to a files URL slug — tries as directory first, falls back to
   * loading parent directory + file preview if the slug points to a file.
   */
  async function navigateToFilesSlug(slug) {
    if (!slug) {
      void loadFilesTree();
      return;
    }
    const files = state.files;
    // Probe the slug to see if it's a directory or file
    try {
      const probeUrl = new URL("/api/docs/tree", window.location.origin);
      probeUrl.searchParams.set("path", slug);
      if (files.showHidden) probeUrl.searchParams.set("showHidden", "1");
      const response = await fetch(probeUrl.toString(), { method: "GET" });
      if (response.ok) {
        // It's a directory — load it via the normal path
        void loadFilesTree(slug);
        return;
      }
    } catch {
      // fall through to file attempt
    }
    // Slug is likely a file — load parent directory, then preview the file
    const lastSlash = slug.lastIndexOf("/");
    const parentSlug = lastSlash > 0 ? slug.slice(0, lastSlash) : null;
    await loadFilesTree(parentSlug || undefined);
    // The backend resolveDocsPath handles relative paths, so pass the slug directly
    void loadFilesPreview(slug);
  }

  async function loadFilesTree(path) {
    const files = state.files;
    const targetPath = typeof path === "string" && path.length > 0 ? path : files.currentPath;
    if (typeof path === "string" && path.length > 0 && path !== files.currentPath) {
      resetFilesPreview();
    }
    files.loading = true;
    files.error = null;

    try {
      const url = new URL("/api/docs/tree", window.location.origin);
      if (targetPath) {
        url.searchParams.set("path", targetPath);
      }
      if (files.showHidden) {
        url.searchParams.set("showHidden", "1");
      }
      const response = await fetch(url.toString(), { method: "GET" });
      if (!response.ok) {
        let message = response.statusText || "Failed to load directory";
        try {
          const payload = await response.json();
          if (payload && typeof payload.error === "string") {
            message = payload.error;
          }
        } catch {
          // ignore json parsing error
        }
        throw new Error(message);
      }

      const data = await response.json();
      files.currentPath = data?.path ?? targetPath ?? files.currentPath;
      files.relativePath = data?.relativePath ?? "";
      files.displayPath = data?.displayPath ?? (files.relativePath ? `Workspace/${files.relativePath}` : "Workspace");
      files.parent = data?.parent ?? null;
      files.entries = Array.isArray(data?.entries) ? data.entries : [];
      files.git = data?.git ?? null;
      files.loading = false;
      files.error = null;

      if (files.previewPath) {
        const exists = files.entries.some((entry) => entry.path === files.previewPath);
        if (!exists) {
          resetFilesPreview();
        }
      }
      updateFilesUrl({ replace: true });
    } catch (error) {
      files.loading = false;
      files.error = error instanceof Error ? error.message : String(error);
      files.entries = [];
      files.git = null;
      if (typeof path === "string" && path.length > 0) {
        files.currentPath = path;
      }
    } finally {
      if (getCurrentRoute() === "files") {
        render();
      }
    }
  }

  async function loadFilesPreview(path) {
    if (!path) return;
    const files = state.files;
    files.previewPath = path;
    files.previewRelativePath = "";
    files.previewDisplayPath = "";
    files.previewName = null;
    files.previewContent = null;
    files.previewError = null;
    files.previewLoading = true;
    files.previewFormat = null;
    files.previewLanguage = null;
    files.previewLabel = null;
    files.previewMimeType = null;
    files.previewSize = null;
    files.previewUrl = null;
    if (getCurrentRoute() === "files") {
      render();
    }

    try {
      const url = new URL("/api/docs/file", window.location.origin);
      url.searchParams.set("path", path);
      const response = await fetch(url.toString(), { method: "GET" });
      if (!response.ok) {
        let message = response.statusText || "Failed to load file";
        try {
          const payload = await response.json();
          if (payload && typeof payload.error === "string") {
            message = payload.error;
          }
        } catch {
          // ignore json parse error
        }
        throw new Error(message);
      }

      const data = await response.json();
      files.previewPath = data?.path ?? path;
      files.previewRelativePath = data?.relativePath ?? "";
      files.previewDisplayPath = data?.displayPath ?? (
        files.previewRelativePath ? `Workspace/${files.previewRelativePath}` : ""
      );
      files.previewName = data?.name ?? null;
      files.previewContent = data?.content ?? "";
      files.previewFormat = data?.format ?? null;
      files.previewLanguage = data?.language ?? null;
      files.previewLabel = data?.label ?? null;
      files.previewMimeType = data?.mimeType ?? null;
      files.previewSize = typeof data?.size === "number" ? data.size : null;
      files.previewUrl = data?.format === "image"
        ? `/api/docs/file/download?path=${encodeURIComponent(files.previewPath)}&inline=1`
        : null;
      files.previewLoading = false;
      files.previewError = null;
      updateFilesUrl();
    } catch (error) {
      files.previewLoading = false;
      files.previewError = error instanceof Error ? error.message : String(error);
      files.previewContent = null;
    } finally {
      if (getCurrentRoute() === "files") {
        render();
      }
    }
  }

  function showFilesPreviewUnavailable(entry) {
    const files = state.files;
    files.previewPath = entry?.path ?? null;
    files.previewRelativePath = entry?.relativePath ?? "";
    files.previewDisplayPath = entry?.displayPath ?? "";
    files.previewName = entry?.name ?? null;
    files.previewFormat = null;
    files.previewLanguage = null;
    files.previewLabel = entry?.previewLabel ?? null;
    files.previewMimeType = null;
    files.previewSize = null;
    files.previewUrl = null;
    files.previewContent = null;
    files.previewLoading = false;
    files.previewError = "Preview not available for this file type.";
    updateFilesUrl();
    if (getCurrentRoute() === "files") {
      render();
    }
  }

  async function createFilesDirectory(parentPath, name) {
    const response = await fetch("/api/docs/directory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent: parentPath, name }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = data?.error ?? response.statusText ?? "Failed to create directory";
      throw new Error(message);
    }
    return response.json();
  }

  async function createFilesTextFile(parentPath, name, content = "") {
    const response = await fetch("/api/docs/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: parentPath, name, content }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = data?.error ?? response.statusText ?? "Failed to create file";
      throw new Error(message);
    }
    return response.json();
  }

  async function uploadFilesBinary(parentPath, file) {
    const bytes = await readFileAsUint8Array(file);
    const base64 = encodeUint8ArrayToBase64(bytes);
    const response = await fetch("/api/docs/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: parentPath, name: file.name, base64 }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = data?.error ?? response.statusText ?? "Failed to upload file";
      throw new Error(message);
    }
    return response.json();
  }

  async function deleteFilesEntry(path) {
    const response = await fetch("/api/docs/file", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = data?.error ?? response.statusText ?? "Failed to delete file";
      throw new Error(message);
    }
    return response.json();
  }

  async function createDirectoryEntry(parent, name) {
    const response = await fetch("/api/directories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent, name }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = data?.error ?? response.statusText ?? "Failed to create folder";
      throw new Error(message);
    }
    return response.json();
  }

  async function copyFilesEntry(path, targetDirectory, name) {
    const payload = { path, targetDirectory };
    if (typeof name === "string" && name.trim().length > 0) {
      payload.name = name.trim();
    }
    const response = await fetch("/api/docs/file/copy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = data?.error ?? response.statusText ?? "Failed to copy file";
      throw new Error(message);
    }
    return response.json();
  }

  async function moveFilesEntry(path, targetDirectory, name) {
    const payload = { path, targetDirectory };
    if (typeof name === "string" && name.trim().length > 0) {
      payload.name = name.trim();
    }
    const response = await fetch("/api/docs/file/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = data?.error ?? response.statusText ?? "Failed to move file";
      throw new Error(message);
    }
    return response.json();
  }

  return {
    resetFilesPreview,
    updateFilesUrl,
    parseFilesPathFromUrl,
    navigateToFilesSlug,
    loadFilesTree,
    loadFilesPreview,
    showFilesPreviewUnavailable,
    createFilesDirectory,
    createFilesTextFile,
    uploadFilesBinary,
    deleteFilesEntry,
    createDirectoryEntry,
    copyFilesEntry,
    moveFilesEntry,
  };
}
