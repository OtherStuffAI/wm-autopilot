/**
 * Path and directory utility functions extracted from server.ts.
 *
 * Pure helpers (no workspace dependency) are exported directly.
 * Functions that require a workspace resolver are returned from
 * `createPathUtils`, which binds them to the caller-supplied
 * `resolveWorkspace` and `projectRoot` values.
 */

import { basename, dirname, isAbsolute, join, normalize, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { realpath, stat } from "node:fs/promises";

import type { WorkspaceScope } from "../workspaces/workspace-scope";
import type { RequestAuthContext } from "../auth/request-context";
import { sanitizePath } from "./path-security";

// ---------------------------------------------------------------------------
// Module-level constants consumed by the directory browser
// ---------------------------------------------------------------------------

export const MAX_DIRECTORY_RESULTS = 50;
export const DIRECTORY_BROWSER_ROOT = "__root__";

// ---------------------------------------------------------------------------
// Pure helpers — no workspace dependency
// ---------------------------------------------------------------------------

/** Expands a leading `~` to the value of `HOME`. */
export const expandHomeDirectory = (input: string): string => {
  if (!input.startsWith("~")) {
    return input;
  }
  const home = Bun.env.HOME ?? "";
  return home ? input.replace("~", home) : input;
};

/**
 * Returns a home-relative representation (`~/…`) when the path is inside the
 * user's home directory, otherwise returns the path unchanged.
 */
export const formatHomeRelativePath = (absolute: string): string => {
  try {
    const home = homedir();
    if (!home) {
      return absolute;
    }
    const normalisedHome = normalize(home);
    if (absolute === normalisedHome) {
      return "~";
    }
    const prefix = normalisedHome.endsWith(sep) ? normalisedHome : `${normalisedHome}${sep}`;
    if (absolute.startsWith(prefix)) {
      const suffix = absolute.slice(prefix.length);
      return suffix.length > 0 ? `~${sep}${suffix}` : "~";
    }
  } catch {
    // Ignore homedir resolution errors and fall back to the basename below.
  }
  return absolute;
};

/** Returns a human-readable short name for a root directory. */
export const formatRootDirectoryName = (absolute: string): string => {
  const homeRelative = formatHomeRelativePath(absolute);
  if (homeRelative !== absolute) {
    return homeRelative;
  }
  const name = basename(absolute);
  return name.length > 0 ? name : absolute;
};

/**
 * Asserts that `absolute` starts with `base` after normalisation and returns
 * the normalised path.  Throws if the path escapes `base`.
 */
export const ensureWithinBase = (absolute: string, base: string) => {
  const normalized = normalize(absolute);
  const normalizedBase = normalize(base);
  if (!normalized.startsWith(normalizedBase)) {
    throw new Error("Invalid directory path");
  }
  return normalized;
};

// ---------------------------------------------------------------------------
// Workspace-dependent helpers — returned from the factory below
// ---------------------------------------------------------------------------

export interface PathUtils {
  ensureWithinAllowedDirectories: (candidate: string, scope?: WorkspaceScope) => string;
  toAbsoluteDirectory: (input: string, scope?: WorkspaceScope) => string;
  ensureDirectory: (input: string | null | undefined, scopeOverride?: WorkspaceScope) => Promise<string>;
  listRootDirectories: (query?: string, scopeOverride?: WorkspaceScope) => Promise<{
    path: string;
    parent: string | null;
    entries: Array<{ name: string; path: string }>;
  }>;
  resolveDirectoryParent: (directory: string, scopeOverride?: WorkspaceScope) => string | null;
  toProjectRelativePath: (absolute: string) => string;
}

/**
 * Binds the workspace-dependent path utilities to the given resolver and
 * project root.  Call this once during server initialisation and destructure
 * the returned object to get individual functions.
 */
export const createPathUtils = (
  resolveWorkspace: (context?: RequestAuthContext) => WorkspaceScope,
  projectRoot: string,
): PathUtils => {
  const ensureWithinAllowedDirectories = (candidate: string, scope?: WorkspaceScope): string => {
    const activeScope = scope ?? resolveWorkspace();
    if (activeScope.allowedDirectories.length === 0) {
      throw new Error("No allowed directories configured");
    }

    const sanitizedCandidate = sanitizePath(candidate);

    if (!isAbsolute(sanitizedCandidate)) {
      throw new Error("Path must be absolute");
    }

    const normalizedCandidate = normalize(sanitizedCandidate);

    for (const base of activeScope.allowedDirectories) {
      const normalizedBase = normalize(base);
      if (normalizedCandidate === normalizedBase ||
          normalizedCandidate.startsWith(normalizedBase + sep)) {
        return normalizedCandidate;
      }
    }

    throw new Error(`Directory outside permitted locations: ${normalizedCandidate}`);
  };

  const toAbsoluteDirectory = (input: string, scope?: WorkspaceScope): string => {
    const activeScope = scope ?? resolveWorkspace();
    const expanded = expandHomeDirectory(input);
    const candidate = isAbsolute(expanded)
      ? expanded
      : resolvePath(activeScope.defaultDirectory, expanded);
    const normalised = normalize(candidate);
    ensureWithinAllowedDirectories(normalised, activeScope);
    return normalised;
  };

  const ensureDirectory = async (
    input: string | null | undefined,
    scopeOverride?: WorkspaceScope,
  ): Promise<string> => {
    const activeScope = scopeOverride ?? resolveWorkspace();
    const source = input?.trim();
    const candidate = source && source.length > 0 ? source : activeScope.defaultDirectory;
    const absolute = toAbsoluteDirectory(candidate, activeScope);
    let resolved = absolute;

    try {
      resolved = await realpath(absolute);
    } catch {
      // realpath fails when the directory does not exist; keep the normalized path.
      resolved = absolute;
    } finally {
      ensureWithinAllowedDirectories(resolved, activeScope);
    }

    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(resolved);
    } catch {
      throw new Error(`Directory not found: ${resolved}`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }

    return resolved;
  };

  const listRootDirectories = async (query?: string, scopeOverride?: WorkspaceScope) => {
    const activeScope = scopeOverride ?? resolveWorkspace();
    const term = query?.trim().toLowerCase() ?? "";
    const seen = new Set<string>();
    const entries: Array<{ name: string; path: string }> = [];

    for (const absolute of activeScope.allowedDirectories) {
      if (seen.has(absolute)) {
        continue;
      }
      seen.add(absolute);
      let stats: Awaited<ReturnType<typeof stat>>;
      try {
        stats = await stat(absolute);
      } catch {
        continue;
      }
      if (!stats.isDirectory()) {
        continue;
      }
      entries.push({
        name: formatRootDirectoryName(absolute),
        path: absolute,
      });
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    const filtered = term.length === 0
      ? entries
      : entries.filter((entry) =>
          entry.name.toLowerCase().includes(term) || entry.path.toLowerCase().includes(term),
        );

    const limited = term.length === 0 ? filtered : filtered.slice(0, MAX_DIRECTORY_RESULTS);

    return {
      path: "",
      parent: null as string | null,
      entries: limited,
    };
  };

  const resolveDirectoryParent = (directory: string, scopeOverride?: WorkspaceScope): string | null => {
    const activeScope = scopeOverride ?? resolveWorkspace();
    for (const allowed of activeScope.allowedDirectories) {
      if (directory === allowed) {
        return DIRECTORY_BROWSER_ROOT;
      }
    }

    const candidate = dirname(directory);
    if (candidate === directory) {
      return null;
    }

    try {
      ensureWithinAllowedDirectories(candidate, activeScope);
      return candidate;
    } catch {
      return DIRECTORY_BROWSER_ROOT;
    }
  };

  const toProjectRelativePath = (absolute: string): string => {
    const normalized = normalize(absolute);
    if (!normalized.startsWith(projectRoot)) {
      return normalized;
    }
    if (normalized === projectRoot) {
      return ".";
    }
    const offset = projectRoot.endsWith("/") ? projectRoot.length : projectRoot.length + 1;
    return normalized.slice(offset);
  };

  return {
    ensureWithinAllowedDirectories,
    toAbsoluteDirectory,
    ensureDirectory,
    listRootDirectories,
    resolveDirectoryParent,
    toProjectRelativePath,
  };
};
