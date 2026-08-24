/**
 * Markdown block parser — splits a markdown document into discrete blocks
 * for the writer panel. Each block can be independently edited and re-rendered.
 *
 * Exports:
 *   parseMarkdownBlocks(markdown) -> MarkdownBlock[]
 *   assembleBlocks(blocks) -> string
 */

/**
 * @typedef {'frontmatter'|'heading'|'code'|'blockquote'|'list'|'table'|'hr'|'paragraph'} BlockType
 *
 * @typedef {Object} MarkdownBlock
 * @property {BlockType} type
 * @property {string} raw - The raw markdown text of this block
 * @property {number} startLine - 0-based start line in the original document
 * @property {number} endLine - 0-based end line (inclusive)
 * @property {Object} [meta] - Optional metadata
 * @property {string} [meta.language] - Code fence language
 * @property {number} [meta.level] - Heading level (1-6)
 */

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const FENCE_RE = /^(`{3,}|~{3,})/;
const UL_RE = /^[-*+]\s/;
const OL_RE = /^\d+\.\s/;
const BLOCKQUOTE_RE = /^>\s?/;
const TABLE_SEP_RE = /^\|?[\s-:|]+\|[\s-:|]*$/;

/**
 * Parse a markdown string into an array of blocks.
 * @param {string} markdown
 * @returns {MarkdownBlock[]}
 */
export function parseMarkdownBlocks(markdown) {
  if (!markdown) return [];

  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  const len = lines.length;

  // Check for frontmatter (must be very first line)
  if (lines[0] === "---") {
    const start = 0;
    let end = -1;
    for (let j = 1; j < len; j++) {
      if (lines[j] === "---") {
        end = j;
        break;
      }
    }
    if (end > 0) {
      blocks.push({
        type: "frontmatter",
        raw: lines.slice(start, end + 1).join("\n"),
        startLine: start,
        endLine: end,
      });
      i = end + 1;
      // Skip blank lines after frontmatter
      while (i < len && lines[i].trim() === "") i++;
    }
  }

  // Accumulator for current paragraph / generic text
  let paraLines = [];
  let paraStart = -1;

  function flushParagraph() {
    if (paraLines.length === 0) return;
    blocks.push({
      type: "paragraph",
      raw: paraLines.join("\n"),
      startLine: paraStart,
      endLine: paraStart + paraLines.length - 1,
    });
    paraLines = [];
    paraStart = -1;
  }

  while (i < len) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line — flush paragraph
    if (trimmed === "") {
      flushParagraph();
      i++;
      continue;
    }

    // Code fence
    const fenceMatch = trimmed.match(FENCE_RE);
    if (fenceMatch) {
      flushParagraph();
      const fence = fenceMatch[1];
      const language = trimmed.slice(fence.length).trim();
      const start = i;
      i++;
      while (i < len) {
        if (lines[i].trim().startsWith(fence.charAt(0).repeat(fence.length))) {
          i++;
          break;
        }
        i++;
      }
      blocks.push({
        type: "code",
        raw: lines.slice(start, i).join("\n"),
        startLine: start,
        endLine: i - 1,
        meta: { language: language || undefined },
      });
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(HEADING_RE);
    if (headingMatch) {
      flushParagraph();
      blocks.push({
        type: "heading",
        raw: line,
        startLine: i,
        endLine: i,
        meta: { level: headingMatch[1].length },
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (HR_RE.test(trimmed)) {
      flushParagraph();
      blocks.push({
        type: "hr",
        raw: line,
        startLine: i,
        endLine: i,
      });
      i++;
      continue;
    }

    // Blockquote
    if (BLOCKQUOTE_RE.test(trimmed)) {
      flushParagraph();
      const start = i;
      while (i < len && (BLOCKQUOTE_RE.test(lines[i].trim()) || (lines[i].trim() !== "" && i > start))) {
        i++;
      }
      blocks.push({
        type: "blockquote",
        raw: lines.slice(start, i).join("\n"),
        startLine: start,
        endLine: i - 1,
      });
      continue;
    }

    // Table (detect by separator line following a header line)
    if (i + 1 < len && trimmed.includes("|") && TABLE_SEP_RE.test(lines[i + 1].trim())) {
      flushParagraph();
      const start = i;
      // Consume header + separator + body rows
      while (i < len && lines[i].trim() !== "" && lines[i].includes("|")) {
        i++;
      }
      blocks.push({
        type: "table",
        raw: lines.slice(start, i).join("\n"),
        startLine: start,
        endLine: i - 1,
      });
      continue;
    }

    // List (unordered or ordered)
    if (UL_RE.test(trimmed) || OL_RE.test(trimmed)) {
      flushParagraph();
      const start = i;
      while (i < len) {
        const cur = lines[i].trim();
        if (cur === "") {
          // Check if next non-blank line continues the list
          let peek = i + 1;
          while (peek < len && lines[peek].trim() === "") peek++;
          if (peek < len && (UL_RE.test(lines[peek].trim()) || OL_RE.test(lines[peek].trim()) || lines[peek].startsWith("  "))) {
            i = peek;
            continue;
          }
          break;
        }
        if (UL_RE.test(cur) || OL_RE.test(cur) || lines[i].startsWith("  ") || lines[i].startsWith("\t")) {
          i++;
          continue;
        }
        break;
      }
      blocks.push({
        type: "list",
        raw: lines.slice(start, i).join("\n"),
        startLine: start,
        endLine: i - 1,
      });
      continue;
    }

    // Default: accumulate paragraph
    if (paraStart < 0) {
      paraStart = i;
    }
    paraLines.push(line);
    i++;
  }

  flushParagraph();
  return blocks;
}

/**
 * Re-assemble blocks into a markdown string, preserving original formatting.
 * Joins blocks with double-newline separators for round-trippability.
 * @param {MarkdownBlock[]} blocks
 * @returns {string}
 */
export function assembleBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  return blocks.map((b) => b.raw).join("\n\n") + "\n";
}
