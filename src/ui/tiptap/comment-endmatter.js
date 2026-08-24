const COMMENT_BLOCK_START = "<!-- autopilot-comments:start";
const COMMENT_BLOCK_END = "autopilot-comments:end -->";

function createId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function normalizeMessage(value) {
  if (!value || typeof value !== "object") return null;
  const body = typeof value.body === "string" ? value.body.trim() : "";
  if (!body) return null;
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : createId("msg"),
    author: typeof value.author === "string" && value.author.trim() ? value.author.trim() : "User",
    createdAt: typeof value.createdAt === "string" && value.createdAt.trim() ? value.createdAt.trim() : new Date().toISOString(),
    body,
  };
}

function normalizeThread(value) {
  if (!value || typeof value !== "object") return null;
  const messages = Array.isArray(value.messages)
    ? value.messages.map(normalizeMessage).filter(Boolean)
    : [];
  if (messages.length === 0) return null;
  const anchor = value.anchor && typeof value.anchor === "object" ? value.anchor : {};
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : createId("cmt"),
    anchor: {
      type: anchor.type === "quote" ? "quote" : "quote",
      text: typeof anchor.text === "string" ? anchor.text : "",
      prefix: typeof anchor.prefix === "string" ? anchor.prefix : "",
      suffix: typeof anchor.suffix === "string" ? anchor.suffix : "",
      blockHint: typeof anchor.blockHint === "string" ? anchor.blockHint : "",
    },
    status: value.status === "resolved" ? "resolved" : "open",
    messages,
  };
}

export function normalizeCommentThreads(value) {
  return Array.isArray(value) ? value.map(normalizeThread).filter(Boolean) : [];
}

export function parseAutopilotCommentEndmatter(markdown = "") {
  const source = String(markdown ?? "");
  const startIndex = source.lastIndexOf(COMMENT_BLOCK_START);
  if (startIndex === -1) {
    return { body: source, threads: [], error: null };
  }

  const contentStart = startIndex + COMMENT_BLOCK_START.length;
  const endIndex = source.indexOf(COMMENT_BLOCK_END, contentStart);
  if (endIndex === -1) {
    return {
      body: source,
      threads: [],
      error: "Comment end matter is missing its closing marker.",
    };
  }

  const jsonText = source.slice(contentStart, endIndex).trim();
  const body = source.slice(0, startIndex).replace(/\s+$/, "");
  try {
    const parsed = JSON.parse(jsonText);
    return {
      body: body ? `${body}\n` : "",
      threads: normalizeCommentThreads(parsed?.threads),
      error: null,
    };
  } catch (error) {
    return {
      body: source,
      threads: [],
      error: error instanceof Error ? `Comment end matter is invalid JSON: ${error.message}` : "Comment end matter is invalid JSON.",
    };
  }
}

export function serializeAutopilotCommentEndmatter(threads = []) {
  const normalized = normalizeCommentThreads(threads);
  if (normalized.length === 0) return "";
  const payload = {
    version: 1,
    threads: normalized,
  };
  return `${COMMENT_BLOCK_START}\n${JSON.stringify(payload, null, 2)}\n${COMMENT_BLOCK_END}`;
}

export function combineMarkdownAndComments(markdown = "", threads = []) {
  const body = String(markdown ?? "").replace(/\s+$/, "");
  const comments = serializeAutopilotCommentEndmatter(threads);
  if (!comments) return body ? `${body}\n` : "";
  return `${body ? `${body}\n\n` : ""}${comments}\n`;
}

export function createCommentThread({ anchor, body, author = "User" } = {}) {
  const messageBody = typeof body === "string" ? body.trim() : "";
  if (!messageBody) return null;
  return normalizeThread({
    id: createId("cmt"),
    anchor: anchor && typeof anchor === "object" ? anchor : { type: "quote" },
    status: "open",
    messages: [{
      id: createId("msg"),
      author,
      createdAt: new Date().toISOString(),
      body: messageBody,
    }],
  });
}

export function appendCommentMessage(thread, body, author = "User") {
  const message = normalizeMessage({
    id: createId("msg"),
    author,
    createdAt: new Date().toISOString(),
    body,
  });
  if (!thread || !message) return null;
  return normalizeThread({
    ...thread,
    status: thread.status === "resolved" ? "resolved" : "open",
    messages: [...(thread.messages || []), message],
  });
}
