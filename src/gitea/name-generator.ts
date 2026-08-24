/**
 * Repo Name Generator for Gitea
 *
 * Derives a kebab-case repository name from the project name
 * or working directory basename.
 */

import { basename } from "node:path";

/**
 * Sanitize a string to kebab-case suitable for a git repo name.
 * Strips non-alphanumeric characters (except hyphens), collapses runs,
 * trims leading/trailing hyphens, and lowercases.
 */
export function toKebab(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Derive a repo name from the project name or directory path.
 *
 * - If projectName is provided, sanitize it to kebab-case.
 * - Otherwise, use the directory basename.
 * - Falls back to "project" if both are empty after sanitization.
 */
export function deriveRepoName(projectName?: string, directory?: string): string {
  if (projectName && projectName.trim().length > 0) {
    const sanitized = toKebab(projectName.trim());
    if (sanitized) return sanitized;
  }

  if (directory) {
    const dirName = basename(directory);
    const sanitized = toKebab(dirName);
    if (sanitized) return sanitized;
  }

  return "project";
}
