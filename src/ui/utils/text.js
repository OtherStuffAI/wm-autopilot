/**
 * Text formatting utilities for UI content.
 */

/**
 * Collapse multiple consecutive blank lines into a maximum of two.
 * This prevents large swathes of empty space from TUI-style agent output.
 * Handles:
 * - Lines containing only whitespace (spaces/tabs)
 * - Lines containing only whitespace + TUI box-drawing characters
 * @param {string} text - The text to normalize
 * @returns {string} - Text with collapsed blank lines
 */
export function collapseNewlines(text) {
  if (!text) return "";

  // Match 3+ consecutive lines that are effectively blank:
  // - Only whitespace, OR
  // - Whitespace + single box-drawing character + whitespace
  // Box chars: ┃ │ ║ (common TUI vertical borders)
  const blankLinePattern = /\n([ \t]*[┃│║]?[ \t]*\n){2,}/g;
  let result = text.replace(blankLinePattern, "\n\n");

  // Also collapse pure consecutive newlines (no whitespace between)
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}
