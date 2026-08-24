/**
 * Night Watch UI Helpers
 *
 * Shared constants and utility functions used by both the settings panel
 * and the dedicated Night Watchman page.
 */

export const STATUS_COLORS = {
  raw: "#8b5cf6",
  monitor: "#3b82f6",
  humanInput: "#f59e0b",
  // Legacy statuses from old reports still in DB
  continue: "#3b82f6",
  complete: "#22c55e",
  error: "#ef4444",
};

export const STATUS_LABELS = {
  raw: "Raw Input",
  monitor: "Monitor",
  humanInput: "Human Input",
  // Legacy
  continue: "Continue",
  complete: "Complete",
  error: "Error",
};

export function createStatusBadge(status) {
  const badge = document.createElement("span");
  badge.style.cssText = `
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    color: #fff;
    background: ${STATUS_COLORS[status] || "#6b7280"};
  `;
  badge.textContent = STATUS_LABELS[status] || status;
  return badge;
}

export function formatTimestamp(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Extract a project name from a working directory path.
 * Returns the last path segment, e.g. "/Users/example/code/wingmen" -> "wingmen"
 */
export function extractProjectName(workingDirectory) {
  if (!workingDirectory) return null;
  const segments = workingDirectory.replace(/\/+$/, "").split("/");
  return segments[segments.length - 1] || null;
}
