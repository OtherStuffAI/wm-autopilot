const RISKY_MARKDOWN_PATTERNS = [
  { pattern: /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, reason: "frontmatter" },
  { pattern: /(^|\n)\s*<!--[\s\S]*?-->/, reason: "HTML comments" },
  { pattern: /(^|\n)\s*<([A-Za-z][\w-]*)(\s|>|\/>)/, reason: "HTML or MDX blocks" },
  { pattern: /^\[[^\]]+\]:\s+\S+/m, reason: "reference links" },
];

function textNode(text, marks = []) {
  const value = String(text ?? "");
  if (!value) return null;
  return marks.length > 0 ? { type: "text", text: value, marks } : { type: "text", text: value };
}

function paragraphNode(content = []) {
  return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
}

function inlineNodes(markdown = "") {
  const nodes = [];
  const source = String(markdown ?? "");
  const tokenPattern = /(!?\[([^\]]*)\]\(([^)\s]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(_([^_]+)_)/g;
  let lastIndex = 0;
  let match = tokenPattern.exec(source);
  while (match) {
    if (match.index > lastIndex) {
      const plain = textNode(source.slice(lastIndex, match.index));
      if (plain) nodes.push(plain);
    }

    if (match[1] && match[1].startsWith("!")) {
      nodes.push({
        type: "image",
        attrs: {
          src: match[3],
          rawSrc: match[3],
          alt: match[2] || null,
          title: null,
        },
      });
    } else if (match[1]) {
      const node = textNode(match[2] || match[3], [
        { type: "link", attrs: { href: match[3], target: "_blank", rel: "noopener noreferrer nofollow", class: null } },
      ]);
      if (node) nodes.push(node);
    } else if (match[4]) {
      const node = textNode(match[5], [{ type: "code" }]);
      if (node) nodes.push(node);
    } else if (match[6]) {
      const node = textNode(match[7], [{ type: "bold" }]);
      if (node) nodes.push(node);
    } else if (match[8]) {
      const node = textNode(match[9], [{ type: "italic" }]);
      if (node) nodes.push(node);
    }

    lastIndex = tokenPattern.lastIndex;
    match = tokenPattern.exec(source);
  }

  if (lastIndex < source.length) {
    const plain = textNode(source.slice(lastIndex));
    if (plain) nodes.push(plain);
  }
  return nodes;
}

function listItemNode(text, checked = null) {
  const attrs = checked === null ? {} : { checked };
  return {
    type: checked === null ? "listItem" : "taskItem",
    attrs,
    content: [paragraphNode(inlineNodes(text))],
  };
}

function createListNode(lines, ordered = false) {
  return {
    type: ordered ? "orderedList" : "bulletList",
    attrs: ordered ? { start: 1 } : {},
    content: lines.map((line) => {
      const text = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
      return listItemNode(text);
    }),
  };
}

function createTaskListNode(lines) {
  return {
    type: "taskList",
    content: lines.map((line) => {
      const match = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
      return listItemNode(match?.[2] ?? line, match?.[1]?.toLowerCase() === "x");
    }),
  };
}

function flushParagraph(out, lines) {
  if (lines.length === 0) return;
  out.push(paragraphNode(inlineNodes(lines.join("\n"))));
  lines.length = 0;
}

export function inspectMarkdownForRichEditing(markdown = "") {
  const reasons = [];
  for (const entry of RISKY_MARKDOWN_PATTERNS) {
    if (entry.pattern.test(String(markdown ?? ""))) {
      reasons.push(entry.reason);
    }
  }
  return {
    risky: reasons.length > 0,
    reasons,
  };
}

export function markdownToProseMirrorDoc(markdown = "") {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const content = [];
  const paragraph = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph(content, paragraph);
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^(```+|~~~+)\s*([\w-]+)?\s*$/);
    if (fence) {
      flushParagraph(content, paragraph);
      const marker = fence[1];
      const language = fence[2] || null;
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      content.push({
        type: "codeBlock",
        attrs: { language },
        content: codeLines.length > 0 ? [{ type: "text", text: codeLines.join("\n") }] : [],
      });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph(content, paragraph);
      content.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: inlineNodes(heading[2]),
      });
      index += 1;
      continue;
    }

    if (/^[-*+]\s+\[[ xX]\]\s+/.test(trimmed)) {
      flushParagraph(content, paragraph);
      const taskLines = [];
      while (index < lines.length && /^[-*+]\s+\[[ xX]\]\s+/.test(lines[index].trim())) {
        taskLines.push(lines[index]);
        index += 1;
      }
      content.push(createTaskListNode(taskLines));
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      flushParagraph(content, paragraph);
      const listLines = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index].trim())) {
        listLines.push(lines[index]);
        index += 1;
      }
      content.push(createListNode(listLines, false));
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushParagraph(content, paragraph);
      const listLines = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index].trim())) {
        listLines.push(lines[index]);
        index += 1;
      }
      content.push(createListNode(listLines, true));
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph(content, paragraph);
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      content.push({
        type: "blockquote",
        content: [paragraphNode(inlineNodes(quoteLines.join("\n")))],
      });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph(content, paragraph);
      content.push({ type: "horizontalRule" });
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph(content, paragraph);
  return {
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph" }],
  };
}

function escapeText(value = "") {
  return String(value ?? "").replace(/([`*_{}#|>])/g, "\\$1");
}

function markText(text, marks = []) {
  return (marks || []).reduce((out, mark) => {
    if (mark.type === "bold") return `**${out}**`;
    if (mark.type === "italic") return `_${out}_`;
    if (mark.type === "strike") return `~~${out}~~`;
    if (mark.type === "code") return `\`${String(text ?? "").replace(/`/g, "\\`")}\``;
    if (mark.type === "link") return `[${out}](${mark.attrs?.href || ""})`;
    return out;
  }, escapeText(text));
}

function inlineMarkdown(nodes = []) {
  return (nodes || []).map((node) => {
    if (node.type === "text") return markText(node.text || "", node.marks || []);
    if (node.type === "hardBreak") return "  \n";
    if (node.type === "image") {
      const src = node.attrs?.rawSrc || node.attrs?.src || "";
      return `![${escapeText(node.attrs?.alt || "")}](${src})`;
    }
    return inlineMarkdown(node.content || []);
  }).join("");
}

function listMarkdown(node = {}, ordered = false, task = false) {
  return (node.content || []).map((item, index) => {
    const paragraph = item.content?.find((child) => child.type === "paragraph");
    const body = inlineMarkdown(paragraph?.content || []);
    if (task) return `- [${item.attrs?.checked ? "x" : " "}] ${body}`;
    return `${ordered ? `${index + (node.attrs?.start || 1)}.` : "-"} ${body}`;
  }).join("\n");
}

function blockMarkdown(node = {}) {
  if (node.type === "heading") return `${"#".repeat(node.attrs?.level || 1)} ${inlineMarkdown(node.content || [])}`.trimEnd();
  if (node.type === "paragraph") return inlineMarkdown(node.content || []);
  if (node.type === "codeBlock") {
    const language = node.attrs?.language || "";
    const text = (node.content || []).map((child) => child.text || "").join("");
    return `\`\`\`${language}\n${text}\n\`\`\``;
  }
  if (node.type === "blockquote") {
    return (node.content || []).map(blockMarkdown).join("\n\n").split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
  }
  if (node.type === "horizontalRule") return "---";
  if (node.type === "bulletList") return listMarkdown(node, false, false);
  if (node.type === "orderedList") return listMarkdown(node, true, false);
  if (node.type === "taskList") return listMarkdown(node, false, true);
  if (node.type === "image") return inlineMarkdown([node]);
  return inlineMarkdown(node.content || []);
}

export function proseMirrorDocToMarkdown(editorState = {}) {
  const state = editorState?.type === "doc" ? editorState : { type: "doc", content: [] };
  const blocks = (state.content || []).map(blockMarkdown).filter((value) => String(value ?? "").trim().length > 0);
  return blocks.join("\n\n") + (blocks.length > 0 ? "\n" : "");
}
