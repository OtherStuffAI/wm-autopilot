/**
 * Markdown and code-block rendering utilities.
 *
 * Depends on escapeHtml / escapeAttribute / sanitizeLanguageClass from core/icons.js.
 */

import { escapeHtml, escapeAttribute, sanitizeLanguageClass } from "../core/icons.js";
import { rewriteWorkspaceUrlToFilesRoute } from "../files/route-url.js";

const CODE_COPY_ICON_SVG =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M15 3H7a2 2 0 0 0-2 2v10h2V5h8V3zm4 4h-8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zm0 12h-8V9h8v10z"/></svg>';

export function rewriteUploadedAssetUrl(value) {
  if (value === null || value === undefined) return "";
  const trimmed = String(value).trim();
  if (!trimmed || !/^file:\/\//i.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "file:") return trimmed;
    const decodedPath = decodeURIComponent(parsed.pathname);
    const uploadMatch = decodedPath.match(/(?:^|\/)tmp\/uploads\/(images|files)\/(.+)$/);
    if (!uploadMatch) return trimmed;
    return `/uploads/${uploadMatch[1]}/${encodeURI(uploadMatch[2])}`;
  } catch {
    return trimmed;
  }
}

export const sanitizeImageSrc = (value) => {
  if (value === null || value === undefined) return "#";
  const trimmed = rewriteUploadedAssetUrl(value);
  if (!trimmed || /\s/.test(trimmed)) return "#";
  const explicitlyAllowed = /^(https?:\/\/|\/|\.{1,2}\/|#)/i.test(trimmed);
  if (explicitlyAllowed) {
    return escapeHtml(trimmed).replace(/"/g, "&quot;");
  }
  // Relative paths are allowed, but block arbitrary URI schemes like javascript:
  if (trimmed.includes(":")) return "#";
  return escapeHtml(trimmed).replace(/"/g, "&quot;");
};

function renderMermaidBlock(source) {
  return `<div class="wm-mermaid" data-testid="markdown-mermaid-diagram"><pre class="wm-mermaid__source"><code>${escapeHtml(source)}</code></pre></div>`;
}

function renderCodeBlockHtml(source, languageClass) {
  const classAttr = languageClass ? ` class="language-${languageClass}"` : "";
  const languageLabel = languageClass
    ? `<span class="wm-markdown-code-block__language">${escapeHtml(languageClass)}</span>`
    : "";
  const highlightedCode = renderHighlightedCodeInnerHtml(source, languageClass);
  return [
    '<div class="wm-markdown-code-block" data-testid="markdown-code-block">',
    '<div class="wm-markdown-code-block__toolbar" data-copy-exclude>',
    languageLabel,
    `<button type="button" class="wm-markdown-code-block__copy" aria-label="Copy code block" title="Copy code block" data-testid="markdown-code-copy" data-code-block-copy>${CODE_COPY_ICON_SVG}</button>`,
    '</div>',
    `<pre><code${classAttr}>${highlightedCode}</code></pre>`,
    '</div>',
  ].join("");
}

function renderImageHtml(alt, url) {
  const safeUrl = sanitizeImageSrc(url);
  const safeAlt = escapeHtml(alt || "uploaded image").replace(/"/g, "&quot;");
  const safeLabel = `Open ${safeAlt} preview`;
  return [
    `<a class="wm-inline-image-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer" aria-label="${safeLabel}" data-testid="inline-image-preview-link">`,
    `<img class="wm-inline-image" src="${safeUrl}" alt="${safeAlt}" loading="lazy" />`,
    "</a>",
  ].join("");
}

function resolveMarkdownLinkHref(url, options = {}) {
  const workspaceRoute = rewriteWorkspaceUrlToFilesRoute(url, {
    defaultDirectory: options.workspaceLinks?.defaultDirectory,
    baseUrl: options.workspaceLinks?.baseUrl,
  });
  return workspaceRoute ?? url;
}

export const renderInlineMarkdown = (text, options = {}) => {
  if (!text) return "";
  let working = String(text);
  const placeholders = [];
  const createPlaceholder = (html) => {
    const token = `@@MD${placeholders.length}@@`;
    placeholders.push(html);
    return token;
  };

  working = working.replace(/`([^`]+)`/g, (_, code) =>
    createPlaceholder(`<code>${escapeHtml(code)}</code>`),
  );

  working = working.replace(/\\?!\[([^\]]*)\]\\?\(([^)\\\s]+)\\?\)/g, (_, alt, url) => {
    return createPlaceholder(renderImageHtml(alt, url));
  });

  working = working.replace(/\[([^\]]+)\]\\?\(([^)\\\s]+)\\?\)/g, (_, label, url) => {
    const safeUrl = escapeAttribute(resolveMarkdownLinkHref(url, options));
    const safeLabel = escapeHtml(label);
    return createPlaceholder(
      `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`,
    );
  });

  working = working.replace(/\bhttps?:\/\/[^\s<>()]+/g, (url) => {
    const safeUrl = escapeAttribute(resolveMarkdownLinkHref(url, options));
    const safeLabel = escapeHtml(url);
    return createPlaceholder(
      `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`,
    );
  });

  working = working.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, (_, __, content) =>
    createPlaceholder(`<strong>${renderInlineMarkdown(content, options)}</strong>`),
  );

  working = working.replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, (_, __, content) =>
    createPlaceholder(`<em>${renderInlineMarkdown(content, options)}</em>`),
  );

  working = working.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, (_, content) =>
    createPlaceholder(`<del>${renderInlineMarkdown(content, options)}</del>`),
  );

  const escaped = escapeHtml(working);
  return escaped.replace(/@@MD(\d+)@@/g, (_, index) => placeholders[Number(index)] ?? "");
};

/** Detect a GFM table separator row: |---|---|  or  |:---:|---:|  etc. */
const TABLE_SEP_RE = /^\|?[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)+\|?\s*$/;
const ORDERED_LIST_RE = /^\s*(\d+)[.)]\s+(.*)$/;
const UNORDERED_LIST_RE = /^\s*[-*+]\s+(.*)$/;

/** Split a pipe-table row into cell strings. */
function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((c) => c.trim());
}

/** Parse alignment from a separator row. Returns array of 'left'|'center'|'right'. */
function parseTableAlignments(sepLine) {
  return splitTableRow(sepLine).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

export const renderMarkdownToHtml = (markdown, options = {}) => {
  if (!markdown) return "";
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let inCodeBlock = false;
  let codeLanguage = "";
  let codeBuffer = [];
  let listStack = [];
  let paragraph = "";
  let inBlockquote = false;

  const closeParagraph = () => {
    if (paragraph) {
      html += `<p>${paragraph.trim()}</p>`;
      paragraph = "";
    }
  };

  const renderListNode = (node) => `<${node.type}>${node.items.join("")}</${node.type}>`;

  const appendNestedListToParent = (parentNode, nestedHtml) => {
    if (parentNode.items.length === 0) {
      parentNode.items.push(`<li>${nestedHtml}</li>`);
      return;
    }
    const lastIndex = parentNode.items.length - 1;
    parentNode.items[lastIndex] = parentNode.items[lastIndex].replace(/<\/li>$/, `${nestedHtml}</li>`);
  };

  const closeListToLevel = (targetLevel = 0) => {
    while (listStack.length > targetLevel) {
      const node = listStack.pop();
      if (!node) break;
      const rendered = renderListNode(node);
      const parentNode = listStack[listStack.length - 1];
      if (parentNode) {
        appendNestedListToParent(parentNode, rendered);
      } else {
        html += rendered;
      }
    }
  };

  const closeList = () => {
    closeListToLevel(0);
  };

  const getIndentWidth = (raw) => {
    let width = 0;
    for (const ch of raw) {
      if (ch === " ") width += 1;
      else if (ch === "\t") width += 4;
      else break;
    }
    return width;
  };

  const getListLevel = (rawLine) => {
    // Treat every 3 leading spaces as one nesting level.
    return Math.floor(getIndentWidth(rawLine) / 3) + 1;
  };

  const isListContinuationAfterBlank = (startIndex) => {
    if (listStack.length === 0) {
      return false;
    }

    for (let nextIndex = startIndex + 1; nextIndex < lines.length; nextIndex++) {
      const nextLine = lines[nextIndex].replace(/\s+$/, "");
      const nextTrimmed = nextLine.trim();
      if (!nextTrimmed) {
        continue;
      }
      if (nextTrimmed.startsWith(">") || nextTrimmed.startsWith("```")) {
        return false;
      }
      const nextType = ORDERED_LIST_RE.test(nextLine)
        ? "ol"
        : UNORDERED_LIST_RE.test(nextLine)
          ? "ul"
          : null;
      if (!nextType) {
        return false;
      }
      const nextLevel = Math.min(getListLevel(nextLine), listStack.length + 1);
      const currentAtLevel = listStack[nextLevel - 1];
      return Boolean(currentAtLevel && currentAtLevel.type === nextType);
    }

    return false;
  };

  const addListItem = (type, rawLine, content) => {
    let level = getListLevel(rawLine);
    if (level > listStack.length + 1) {
      level = listStack.length + 1;
    }

    if (listStack.length > level) {
      closeListToLevel(level);
    }

    if (listStack.length === level) {
      const current = listStack[level - 1];
      if (current && current.type !== type) {
        closeListToLevel(level - 1);
      }
    }

    while (listStack.length < level) {
      const parent = listStack[listStack.length - 1];
      if (parent && parent.items.length === 0) {
        parent.items.push("<li></li>");
      }
      listStack.push({ type, items: [] });
    }

    const current = listStack[level - 1];
    if (current.type !== type) {
      closeListToLevel(level - 1);
      while (listStack.length < level) {
        const parent = listStack[listStack.length - 1];
        if (parent && parent.items.length === 0) {
          parent.items.push("<li></li>");
        }
        listStack.push({ type, items: [] });
      }
    }

    const target = listStack[level - 1];
    target.items.push(`<li>${content}</li>`);
  };

  const closeBlockquote = () => {
    if (inBlockquote) {
      html += "</blockquote>";
      inBlockquote = false;
    }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    const line = rawLine.replace(/\s+$/, "");
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        const languageClass = sanitizeLanguageClass(codeLanguage);
        const code = codeBuffer.join("\n");
        if (languageClass === "mermaid") {
          html += renderMermaidBlock(code);
        } else {
          html += renderCodeBlockHtml(code, languageClass);
        }
        inCodeBlock = false;
        codeLanguage = "";
        codeBuffer = [];
      } else {
        closeParagraph();
        closeList();
        closeBlockquote();
        inCodeBlock = true;
        codeLanguage = line.slice(3).trim();
        codeBuffer = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(rawLine);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeParagraph();
      if (!isListContinuationAfterBlank(idx)) {
        closeList();
      }
      closeBlockquote();
      continue;
    }

    if (trimmed.startsWith(">")) {
      closeParagraph();
      closeList();
      if (!inBlockquote) {
        inBlockquote = true;
        html += "<blockquote>";
      }
      const quote = trimmed.replace(/^>\s?/, "");
      html += `<p>${renderInlineMarkdown(quote, options)}</p>`;
      continue;
    }

    if (inBlockquote) {
      closeBlockquote();
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      closeParagraph();
      closeList();
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      html += `<h${level}>${renderInlineMarkdown(text, options)}</h${level}>`;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeParagraph();
      closeList();
      html += "<hr />";
      continue;
    }

    // GFM table: header row followed by separator row
    if (
      trimmed.includes("|") &&
      idx + 1 < lines.length &&
      TABLE_SEP_RE.test(lines[idx + 1].trim())
    ) {
      closeParagraph();
      closeList();
      closeBlockquote();
      const headerCells = splitTableRow(trimmed);
      const alignments = parseTableAlignments(lines[idx + 1]);
      idx++; // skip separator

      const alignAttr = (i) => {
        const a = alignments[i];
        return a && a !== "left" ? ` style="text-align:${a}"` : "";
      };

      let tableHtml = "<table><thead><tr>";
      headerCells.forEach((cell, i) => {
        tableHtml += `<th${alignAttr(i)}>${renderInlineMarkdown(cell, options)}</th>`;
      });
      tableHtml += "</tr></thead><tbody>";

      // Consume body rows
      while (idx + 1 < lines.length) {
        const nextLine = lines[idx + 1].trim();
        if (!nextLine || !nextLine.includes("|")) break;
        idx++;
        const bodyCells = splitTableRow(nextLine);
        tableHtml += "<tr>";
        headerCells.forEach((_, i) => {
          const cellContent = i < bodyCells.length ? bodyCells[i] : "";
          tableHtml += `<td${alignAttr(i)}>${renderInlineMarkdown(cellContent, options)}</td>`;
        });
        tableHtml += "</tr>";
      }

      tableHtml += "</tbody></table>";
      html += tableHtml;
      continue;
    }

    const orderedMatch = line.match(ORDERED_LIST_RE);
    if (orderedMatch) {
      closeParagraph();
      const content = renderInlineMarkdown(orderedMatch[2], options);
      addListItem("ol", rawLine, content);
      continue;
    }

    const unorderedMatch = line.match(UNORDERED_LIST_RE);
    if (unorderedMatch) {
      closeParagraph();
      const content = renderInlineMarkdown(unorderedMatch[1], options);
      addListItem("ul", rawLine, content);
      continue;
    }

    closeList();
    if (paragraph) {
      paragraph += ` ${renderInlineMarkdown(trimmed, options)}`;
    } else {
      paragraph = renderInlineMarkdown(trimmed, options);
    }
  }

  if (inCodeBlock) {
    const languageClass = sanitizeLanguageClass(codeLanguage);
    const code = codeBuffer.join("\n");
    if (languageClass === "mermaid") {
      html += renderMermaidBlock(code);
    } else {
      html += renderCodeBlockHtml(code, languageClass);
    }
  }
  closeParagraph();
  closeList();
  closeBlockquote();
  return html.trim();
};

const CODE_KEYWORDS = {
  javascript: [
    "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
    "else", "export", "extends", "finally", "for", "from", "function", "if", "import", "in", "instanceof",
    "let", "new", "return", "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with", "yield", "await",
  ],
  typescript: [
    "abstract", "any", "as", "asserts", "async", "await", "boolean", "break", "case", "catch", "class", "const",
    "constructor", "continue", "declare", "default", "delete", "do", "else", "enum", "export", "extends", "false",
    "finally", "for", "from", "function", "get", "if", "implements", "import", "in", "infer", "instanceof", "interface",
    "is", "keyof", "let", "module", "namespace", "never", "new", "null", "number", "object", "package", "private", "protected",
    "public", "readonly", "require", "return", "set", "static", "string", "super", "switch", "symbol", "this", "throw", "true",
    "try", "type", "typeof", "undefined", "unique", "unknown", "var", "void", "while", "with", "yield",
  ],
  go: [
    "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go",
    "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
  ],
  json: ["true", "false", "null"],
  yaml: ["true", "false", "null", "yes", "no", "on", "off"],
  toml: ["true", "false"],
  ini: ["true", "false"],
  rust: [
    "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let",
    "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait",
    "true", "type", "unsafe", "use", "where", "while",
  ],
  python: [
    "and", "as", "assert", "break", "class", "continue", "def", "del", "elif", "else", "except", "False", "finally", "for",
    "from", "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return",
    "True", "try", "while", "with", "yield",
  ],
  shell: [
    "if", "then", "else", "elif", "fi", "for", "while", "in", "do", "done", "case", "esac", "function", "select",
  ],
  ruby: [
    "BEGIN", "END", "alias", "and", "begin", "break", "case", "class", "def", "defined?", "do", "else", "elsif",
    "end", "ensure", "false", "for", "if", "in", "module", "next", "nil", "not", "or", "redo", "rescue", "retry",
    "return", "self", "super", "then", "true", "undef", "unless", "until", "when", "while", "yield",
  ],
  php: [
    "abstract", "and", "array", "as", "break", "callable", "case", "catch", "class", "clone", "const", "continue",
    "declare", "default", "die", "do", "echo", "else", "elseif", "empty", "enddeclare", "endfor", "endforeach",
    "endif", "endswitch", "endwhile", "eval", "exit", "extends", "final", "finally", "fn", "for", "foreach", "function",
    "global", "goto", "if", "implements", "include", "include_once", "instanceof", "interface", "isset", "list",
    "namespace", "new", "or", "print", "private", "protected", "public", "require", "require_once", "return", "static",
    "switch", "throw", "trait", "try", "unset", "use", "var", "while", "xor", "yield",
  ],
  java: [
    "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const", "continue", "default",
    "do", "double", "else", "enum", "extends", "final", "finally", "float", "for", "if", "implements", "import",
    "instanceof", "int", "interface", "long", "native", "new", "package", "private", "protected", "public", "return",
    "short", "static", "strictfp", "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try",
    "void", "volatile", "while",
  ],
  c: [
    "auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum", "extern", "float",
    "for", "goto", "if", "inline", "int", "long", "register", "restrict", "return", "short", "signed", "sizeof",
    "static", "struct", "switch", "typedef", "union", "unsigned", "void", "volatile", "while",
  ],
  cpp: [
    "alignas", "alignof", "and", "asm", "auto", "bool", "break", "case", "catch", "char", "class", "concept", "const",
    "constexpr", "continue", "decltype", "default", "delete", "do", "double", "else", "enum", "explicit", "export",
    "extern", "false", "float", "for", "friend", "if", "inline", "int", "long", "mutable", "namespace", "new", "noexcept",
    "nullptr", "operator", "private", "protected", "public", "return", "short", "signed", "sizeof", "static", "struct",
    "switch", "template", "this", "throw", "true", "try", "typedef", "typename", "union", "unsigned", "using", "virtual",
    "void", "volatile", "while",
  ],
  csharp: [
    "abstract", "as", "base", "bool", "break", "case", "catch", "class", "const", "continue", "decimal", "default",
    "delegate", "do", "double", "else", "enum", "event", "explicit", "extern", "false", "finally", "fixed", "float",
    "for", "foreach", "if", "implicit", "in", "int", "interface", "internal", "is", "lock", "long", "namespace", "new",
    "null", "object", "operator", "out", "override", "params", "private", "protected", "public", "readonly", "ref",
    "return", "sealed", "short", "sizeof", "stackalloc", "static", "string", "struct", "switch", "this", "throw", "true",
    "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort", "using", "virtual", "void", "volatile", "while",
  ],
  swift: [
    "Any", "as", "associatedtype", "break", "case", "catch", "class", "continue", "defer", "deinit", "do", "else", "enum",
    "extension", "fallthrough", "false", "fileprivate", "for", "func", "guard", "if", "import", "in", "init", "inout",
    "internal", "is", "let", "nil", "open", "operator", "private", "protocol", "public", "repeat", "return", "self",
    "static", "struct", "subscript", "super", "switch", "throw", "throws", "true", "try", "typealias", "var", "where",
    "while",
  ],
  kotlin: [
    "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is", "null",
    "object", "package", "return", "super", "this", "throw", "true", "try", "typealias", "typeof", "val", "var", "when",
    "while",
  ],
  sql: [
    "alter", "and", "as", "between", "by", "case", "create", "delete", "desc", "distinct", "drop", "else", "end", "exists",
    "false", "from", "group", "having", "in", "insert", "into", "is", "join", "left", "like", "limit", "not", "null", "on",
    "or", "order", "outer", "right", "select", "set", "table", "then", "true", "union", "update", "values", "when", "where",
  ],
  css: ["@import", "@media", "@supports", "@keyframes", "from", "to"],
  html: ["doctype", "html", "head", "body", "div", "span", "script", "style", "link", "meta", "title"],
  plaintext: [],
};

export const buildKeywordPattern = (keywords) => {
  if (!keywords || keywords.length === 0) return null;
  const escaped = keywords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![A-Za-z0-9_$@-])(${escaped.join("|")})(?![A-Za-z0-9_$-])`, "gi");
};

const CODE_KEYWORD_PATTERNS = Object.fromEntries(
  Object.entries(CODE_KEYWORDS).map(([language, keywords]) => [language, buildKeywordPattern(keywords)]),
);

const CODE_LANGUAGE_ALIASES = {
  bash: "shell",
  cjs: "javascript",
  htm: "html",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  sh: "shell",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
};

function normalizeCodeLanguage(language = "plaintext") {
  const normalized = sanitizeLanguageClass(language) || "plaintext";
  const aliased = CODE_LANGUAGE_ALIASES[normalized] ?? normalized;
  return CODE_KEYWORDS[aliased] ? aliased : "plaintext";
}

export function renderHighlightedCodeInnerHtml(content, language = "plaintext") {
  const normalizedLanguage = normalizeCodeLanguage(language);
  const escaped = escapeHtml(content ?? "");
  const replacements = [];
  const createToken = (html) => {
    const token = `__WM_TOKEN_${replacements.length}__`;
    replacements.push({ token, html });
    return token;
  };

  let working = escaped;

  if (normalizedLanguage === "json") {
    working = working.replace(/(&quot;[^&]*?&quot;)(?=\s*:)/g, (match) =>
      createToken(`<span class="token key">${match}</span>`),
    );
  } else if (normalizedLanguage === "yaml" || normalizedLanguage === "toml" || normalizedLanguage === "ini") {
    working = working.replace(/^(\s*)([^\s:#][^:]*)(?=\s*:)/gm, (full, indent, key) => {
      return `${indent}${createToken(`<span class="token key">${key}</span>`)}`;
    });
  }

  if (
    normalizedLanguage === "javascript" ||
    normalizedLanguage === "typescript" ||
    normalizedLanguage === "go" ||
    normalizedLanguage === "rust" ||
    normalizedLanguage === "java" ||
    normalizedLanguage === "c" ||
    normalizedLanguage === "cpp" ||
    normalizedLanguage === "csharp" ||
    normalizedLanguage === "php" ||
    normalizedLanguage === "swift" ||
    normalizedLanguage === "kotlin" ||
    normalizedLanguage === "css"
  ) {
    working = working.replace(/(\/\/[^\n]*)/g, (match) => createToken(`<span class="token comment">${match}</span>`));
    working = working.replace(/(\/\*[\s\S]*?\*\/)/g, (match) =>
      createToken(`<span class="token comment">${match}</span>`),
    );
  }

  if (
    normalizedLanguage === "python" ||
    normalizedLanguage === "shell" ||
    normalizedLanguage === "yaml" ||
    normalizedLanguage === "toml" ||
    normalizedLanguage === "ini" ||
    normalizedLanguage === "ruby"
  ) {
    working = working.replace(/(^|\s)(#[^\n]*)/gm, (full, prefix, comment) => {
      return `${prefix}${createToken(`<span class="token comment">${comment}</span>`)}`;
    });
  }

  if (normalizedLanguage === "sql") {
    working = working.replace(/(--[^\n]*)/g, (match) => createToken(`<span class="token comment">${match}</span>`));
    working = working.replace(/(\/\*[\s\S]*?\*\/)/g, (match) =>
      createToken(`<span class="token comment">${match}</span>`),
    );
  }

  if (normalizedLanguage === "html") {
    working = working.replace(/(&lt;!--[\s\S]*?--&gt;)/g, (match) =>
      createToken(`<span class="token comment">${match}</span>`),
    );
  }

  working = working.replace(/(&quot;.*?&quot;)/g, (match) => createToken(`<span class="token string">${match}</span>`));
  working = working.replace(/(&#39;.*?&#39;)/g, (match) => createToken(`<span class="token string">${match}</span>`));
  working = working.replace(/`[^`]*`/g, (match) => createToken(`<span class="token string">${match}</span>`));

  working = working.replace(/\b(0x[a-fA-F0-9]+|\d+\.\d+|\d+)\b/g, (match) =>
    createToken(`<span class="token number">${match}</span>`),
  );

  const keywordPattern = CODE_KEYWORD_PATTERNS[normalizedLanguage];
  if (keywordPattern) {
    working = working.replace(keywordPattern, '<span class="token keyword">$1</span>');
  }

  replacements.forEach(({ token, html }) => {
    working = working.replaceAll(token, html);
  });

  return working;
}

export const renderCodeToHtml = (content, language = "plaintext") => {
  const normalizedLanguage = normalizeCodeLanguage(language);
  const highlighted = renderHighlightedCodeInnerHtml(content, normalizedLanguage);
  return `<pre><code class="language-${normalizedLanguage}">${highlighted}</code></pre>`;
};
