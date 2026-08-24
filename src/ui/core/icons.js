/**
 * SVG icon construction, text helpers, and scroll utilities.
 *
 * Pure functions — no framework or state dependencies.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export const createSvgShape = (tag, attributes = {}) => {
  const element = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => {
    element.setAttribute(key, String(value));
  });
  if (!attributes.fill) {
    element.setAttribute("fill", "none");
  }
  if (!attributes.stroke) {
    element.setAttribute("stroke", "currentColor");
  }
  if (!attributes["stroke-width"]) {
    element.setAttribute("stroke-width", "1.8");
  }
  if ((tag === "path" || tag === "line" || tag === "polyline") && !attributes["stroke-linecap"]) {
    element.setAttribute("stroke-linecap", "round");
  }
  if ((tag === "path" || tag === "polyline") && !attributes["stroke-linejoin"]) {
    element.setAttribute("stroke-linejoin", "round");
  }
  if ((tag === "circle" || tag === "ellipse") && !attributes["stroke-linecap"]) {
    element.setAttribute("stroke-linecap", "round");
  }
  if ((tag === "circle" || tag === "ellipse") && !attributes["stroke-linejoin"]) {
    element.setAttribute("stroke-linejoin", "round");
  }
  return element;
};

export const createIconSvg = (definition) => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("wm-icon");
  definition.forEach(([tag, attrs]) => {
    svg.append(createSvgShape(tag, attrs));
  });
  return svg;
};

export const FILE_BROWSER_ICON_DEFS = {
  arrowUp: [
    ["line", { x1: 12, y1: 19, x2: 12, y2: 7 }],
    ["polyline", { points: "6 11 12 5 18 11" }],
  ],
  refresh: [
    ["polyline", { points: "23 4 23 10 17 10" }],
    ["path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36" }],
  ],
  eye: [
    ["ellipse", { cx: 12, cy: 12, rx: 9.5, ry: 6.5 }],
    ["circle", { cx: 12, cy: 12, r: 2.5 }],
  ],
  eyeOff: [
    ["ellipse", { cx: 12, cy: 12, rx: 9.5, ry: 6.5 }],
    ["circle", { cx: 12, cy: 12, r: 2.5 }],
    ["line", { x1: 4, y1: 4, x2: 20, y2: 20 }],
  ],
  folder: [
    ["path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" }],
    ["path", { d: "M3 7h18" }],
  ],
  file: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
  ],
  fileText: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["line", { x1: 16, y1: 13, x2: 8, y2: 13 }],
    ["line", { x1: 16, y1: 17, x2: 8, y2: 17 }],
    ["path", { d: "M10 9h4" }],
  ],
  fileCode: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["polyline", { points: "10 13 8 15 10 17" }],
    ["polyline", { points: "14 17 16 15 14 13" }],
  ],
  fileImage: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["circle", { cx: 9, cy: 12, r: 1.5 }],
    ["path", { d: "m7 18 3.5-4 2.5 3 2-2.3 3 3.3" }],
  ],
  ban: [
    ["circle", { cx: 12, cy: 12, r: 9 }],
    ["line", { x1: 5, y1: 19, x2: 19, y2: 5 }],
  ],
  folderPlus: [
    ["path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" }],
    ["path", { d: "M12 11v4" }],
    ["path", { d: "M10 13h4" }],
  ],
  filePlus: [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["path", { d: "M12 13v4" }],
    ["path", { d: "M10 15h4" }],
  ],
  upload: [
    ["path", { d: "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" }],
    ["polyline", { points: "16 6 12 2 8 6" }],
    ["line", { x1: 12, y1: 2, x2: 12, y2: 16 }],
  ],
  download: [
    ["path", { d: "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" }],
    ["polyline", { points: "8 12 12 16 16 12" }],
    ["line", { x1: 12, y1: 2, x2: 12, y2: 16 }],
  ],
  branchPlus: [
    ["circle", { cx: 6, cy: 6, r: 2.5 }],
    ["circle", { cx: 6, cy: 18, r: 2.5 }],
    ["circle", { cx: 18, cy: 12, r: 2.5 }],
    ["line", { x1: 6, y1: 8.5, x2: 6, y2: 15.5 }],
    ["path", { d: "M8.5 8.5a5 5 0 0 1 5.5 4.5" }],
    ["line", { x1: 18, y1: 14.5, x2: 18, y2: 20 }],
    ["line", { x1: 16, y1: 17, x2: 20, y2: 17 }],
  ],
  sidebarClose: [
    ["polyline", { points: "11 17 6 12 11 7" }],
    ["polyline", { points: "18 17 13 12 18 7" }],
  ],
  sidebarOpen: [
    ["polyline", { points: "6 17 11 12 6 7" }],
    ["polyline", { points: "13 17 18 12 13 7" }],
  ],
  star: [
    ["path", { d: "M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.27 5.82 22 7 14.14l-5-4.87 6.91-1.01L12 2z", fill: "none" }],
  ],
  starFilled: [
    ["path", { d: "M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.27 5.82 22 7 14.14l-5-4.87 6.91-1.01L12 2z", fill: "currentColor" }],
  ],
  pencil: [
    ["path", { d: "M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" }],
    ["path", { d: "m15 5 4 4" }],
  ],
  penTool: [
    ["path", { d: "m12 19 7-7 3 3-7 7Z" }],
    ["path", { d: "m18 13-1.5-7.5L2 2l3.5 14.5L13 18Z" }],
    ["path", { d: "m2 2 7.586 7.586" }],
    ["circle", { cx: 11, cy: 11, r: 2 }],
  ],
  link: [
    ["path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }],
    ["path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }],
  ],
  externalLink: [
    ["path", { d: "M15 3h6v6" }],
    ["path", { d: "M10 14 21 3" }],
    ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }],
  ],
  clipboardCopy: [
    ["path", { d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" }],
    ["path", { d: "M15 2H9a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1Z" }],
  ],
  arrowRightCircle: [
    ["circle", { cx: 12, cy: 12, r: 10 }],
    ["polyline", { points: "12 16 16 12 12 8" }],
    ["line", { x1: 8, y1: 12, x2: 16, y2: 12 }],
  ],
  trash: [
    ["polyline", { points: "3 6 5 6 21 6" }],
    ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }],
  ],
  terminal: [
    ["path", { d: "M4 17l6-5-6-5" }],
    ["line", { x1: 12, y1: 19, x2: 20, y2: 19 }],
  ],
};

export const setIconButton = (button, iconKey, label) => {
  const definition = FILE_BROWSER_ICON_DEFS[iconKey];
  if (!definition) return;
  while (button.firstChild) {
    button.removeChild(button.firstChild);
  }
  button.append(createIconSvg(definition));
  if (label) {
    button.setAttribute("aria-label", label);
    button.title = label;
  } else {
    button.removeAttribute("aria-label");
    button.removeAttribute("title");
  }
};

export const getSessionDisplayName = (session) => {
  if (!session || typeof session !== "object") return "";
  const rawName = typeof session.name === "string" ? session.name.trim() : "";
  if (rawName.length > 0) return rawName;
  const agent = typeof session.agent === "string" ? session.agent : "agent";
  const port = typeof session.port === "number" ? session.port : "";
  return port ? `${agent} :${port}` : agent;
};

export const truncateText = (value, maxLength = 31) => {
  if (typeof value !== "string") return "";
  if (value.length <= maxLength) return value;
  const safeLength = Math.max(0, maxLength - 3);
  return `${value.slice(0, safeLength)}...`;
};

export const scrollConversationToBottom = (element) => {
  if (!element) return;
  requestAnimationFrame(() => {
    if (element === document.body || element === document.documentElement || element === document.scrollingElement) {
      const target = document.scrollingElement || document.documentElement || document.body;
      window.scrollTo(0, target.scrollHeight);
      return;
    }
    element.scrollTop = element.scrollHeight;
  });
};

export const getConversationScrollElement = (sessionId, conversationContainers) => {
  const container = conversationContainers.get(sessionId);
  if (!container) return null;
  const conversation = container.closest('.wm-live-conversation');
  return conversation?.closest('.wm-live-scroll') ?? conversation;
};

export const scrollConversationAreaToBottom = (sessionId, conversationContainers, options = {}) => {
  const { includeWindow = false } = options;
  const fallbackConversation = document.querySelector('.wm-live-conversation');
  const target =
    getConversationScrollElement(sessionId, conversationContainers) ??
    fallbackConversation?.closest('.wm-live-scroll') ??
    fallbackConversation;
  if (target) {
    scrollConversationToBottom(target);
  }
  if (includeWindow) {
    const fallback = document.scrollingElement || document.documentElement || document.body;
    if (fallback && fallback !== target) {
      scrollConversationToBottom(fallback);
    }
  }
};

export const isConversationScrolledToBottom = (sessionId, conversationContainers) => {
  const scrollElement = getConversationScrollElement(sessionId, conversationContainers);
  if (!scrollElement) {
    const doc = document.scrollingElement || document.documentElement || document.body;
    const threshold = 50;
    return doc.scrollHeight - doc.scrollTop - doc.clientHeight < threshold;
  }
  const threshold = 50;
  return scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < threshold;
};

export const isMobileFilesLayout = () => {
  if (window.matchMedia) {
    try {
      return window.matchMedia("(max-width: 720px)").matches;
    } catch {
      // fall through to manual check
    }
  }
  return window.innerWidth <= 720;
};

export const escapeHtml = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

export const escapeAttribute = (value) => {
  if (value === null || value === undefined) return "#";
  const trimmed = String(value).trim();
  const allowed = /^(https?:\/\/|\/|#|mailto:|tel:)/i;
  const safe = allowed.test(trimmed) ? trimmed : "#";
  return escapeHtml(safe).replace(/"/g, "&quot;");
};

export const sanitizeLanguageClass = (value) => {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "");
};
