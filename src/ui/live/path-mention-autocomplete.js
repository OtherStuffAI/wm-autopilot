const LOOKUP_DEBOUNCE_MS = 140;
const MAX_SUGGESTIONS = 12;

function findMentionTokenAtCursor(text, cursor) {
  if (typeof text !== "string") return null;
  if (!Number.isInteger(cursor) || cursor < 0) return null;

  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) {
    start -= 1;
  }

  if (text[start] !== "@") {
    return null;
  }

  let end = cursor;
  while (end < text.length && !/\s/.test(text[end] ?? "")) {
    end += 1;
  }

  const tokenToCursor = text.slice(start, cursor);
  if (!tokenToCursor.startsWith("@")) {
    return null;
  }

  const query = tokenToCursor.slice(1);
  if (query.includes("@")) {
    return null;
  }

  return { start, end, query };
}

function parsePathLookup(rawQuery) {
  const normalized = (rawQuery ?? "").replace(/\\/g, "/");
  if (!normalized) {
    return { basePath: "", term: "" };
  }
  if (normalized.endsWith("/")) {
    return { basePath: normalized, term: "" };
  }
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex === -1) {
    return { basePath: "", term: normalized };
  }
  return {
    basePath: normalized.slice(0, separatorIndex + 1),
    term: normalized.slice(separatorIndex + 1),
  };
}

function resolveDirectoryPathInput(basePath, workingDirectory) {
  const base = (basePath ?? "").trim();
  if (!base) {
    return workingDirectory?.trim() ?? "";
  }
  if (base.startsWith("/") || base.startsWith("~")) {
    return base;
  }
  const cwd = workingDirectory?.trim() ?? "";
  if (!cwd) {
    return base;
  }
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${normalizedCwd}/${base}`;
}

function matchesTerm(name, term) {
  if (!term) return true;
  return name.toLowerCase().includes(term.toLowerCase());
}

function getLastPathSegment(pathValue) {
  if (!pathValue || typeof pathValue !== "string") return "";
  const normalized = pathValue.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

async function fetchDirectorySuggestions(path, term) {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (term) params.set("query", term);
  const query = params.toString();
  const url = query ? `/api/directories?${query}` : "/api/directories";
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function fetchDocsTree(path) {
  if (!path) return null;
  const params = new URLSearchParams();
  params.set("path", path);
  const response = await fetch(`/api/docs/tree?${params.toString()}`);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

function createSuggestionMenu(textarea, parentElement, sessionId) {
  const safeSessionId = typeof sessionId === "string" ? sessionId.replace(/[^a-zA-Z0-9_-]/g, "") : "session";
  const menu = document.createElement("div");
  menu.className = "wm-path-mention-menu";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  menu.id = `wm-path-mention-${safeSessionId}-${Math.random().toString(36).slice(2, 10)}`;
  parentElement.append(menu);
  textarea.setAttribute("aria-controls", menu.id);
  textarea.setAttribute("aria-expanded", "false");
  return menu;
}

export function attachPathMentionAutocomplete({
  sessionId,
  textarea,
  parentElement,
  getWorkingDirectory,
  onDraftChange,
  onResize,
}) {
  if (!(textarea instanceof HTMLTextAreaElement) || !(parentElement instanceof HTMLElement)) {
    return {
      handleInput: () => {},
      handleKeydown: () => false,
      close: () => {},
    };
  }

  const menu = createSuggestionMenu(textarea, parentElement, sessionId);
  let requestId = 0;
  let debounceTimer = null;
  let activeIndex = -1;
  let currentToken = null;
  let currentItems = [];

  const close = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    requestId += 1;
    currentItems = [];
    activeIndex = -1;
    currentToken = null;
    menu.hidden = true;
    menu.innerHTML = "";
    textarea.setAttribute("aria-expanded", "false");
  };

  const renderMenu = () => {
    if (!textarea.isConnected || currentItems.length === 0) {
      close();
      return;
    }
    menu.innerHTML = "";
    currentItems.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wm-path-mention-item";
      if (index === activeIndex) {
        button.classList.add("is-active");
      }
      button.dataset.testid = "composer-path-suggestion";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", index === activeIndex ? "true" : "false");
      button.setAttribute("aria-label", `${item.kind} ${item.value}`);
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      button.addEventListener("click", () => {
        applySuggestion(index);
      });

      const path = document.createElement("span");
      path.className = "wm-path-mention-item-path";
      path.textContent = `@${item.value}`;

      const kind = document.createElement("span");
      kind.className = "wm-path-mention-item-kind";
      kind.textContent = item.kind;

      button.append(path, kind);
      menu.append(button);
    });
    menu.hidden = false;
    textarea.setAttribute("aria-expanded", "true");
  };

  const setActiveIndex = (index) => {
    if (currentItems.length === 0) {
      activeIndex = -1;
      return;
    }
    const max = currentItems.length - 1;
    if (index < 0) {
      activeIndex = max;
      return;
    }
    if (index > max) {
      activeIndex = 0;
      return;
    }
    activeIndex = index;
  };

  const applySuggestion = (index) => {
    const item = currentItems[index];
    if (!item || !currentToken) {
      return;
    }
    const before = textarea.value.slice(0, currentToken.start);
    const after = textarea.value.slice(currentToken.end);
    const nextValue = `${before}@${item.value}${after}`;
    const cursor = before.length + 1 + item.value.length;
    textarea.value = nextValue;
    textarea.setSelectionRange(cursor, cursor);
    onDraftChange(nextValue);
    onResize();
    close();
  };

  const buildSuggestions = (lookup, directoryPayload, docsPayload, parentDocsPayload) => {
    const next = [];
    const seen = new Set();
    const basePath = lookup.basePath;
    const term = lookup.term;
    const push = (value, kind) => {
      if (!value || seen.has(value)) return;
      seen.add(value);
      next.push({ value, kind });
    };

    const directoryEntries = Array.isArray(directoryPayload?.entries) ? directoryPayload.entries : [];
    directoryEntries.forEach((entry) => {
      if (!entry || typeof entry.name !== "string") return;
      if (!matchesTerm(entry.name, term)) return;
      push(`${basePath}${entry.name}/`, "directory");
    });

    const docsEntries = Array.isArray(docsPayload?.entries) ? docsPayload.entries : [];
    docsEntries.forEach((entry) => {
      if (!entry || entry.type !== "file" || typeof entry.name !== "string") return;
      if (!matchesTerm(entry.name, term)) return;
      push(`${basePath}${entry.name}`, "file");
    });

    if (!basePath && term) {
      const currentDisplayPath =
        typeof docsPayload?.displayPath === "string" ? docsPayload.displayPath : "";
      const currentName = getLastPathSegment(currentDisplayPath);
      if (
        currentDisplayPath &&
        currentDisplayPath !== "~" &&
        matchesTerm(currentName, term)
      ) {
        push(`${currentDisplayPath}/`, "directory");
      }

      const parentEntries = Array.isArray(parentDocsPayload?.entries) ? parentDocsPayload.entries : [];
      parentEntries.forEach((entry) => {
        if (!entry || typeof entry.name !== "string" || !matchesTerm(entry.name, term)) {
          return;
        }
        const displayPath = typeof entry.displayPath === "string" ? entry.displayPath : "";
        if (!displayPath) return;
        if (entry.type === "directory") {
          push(`${displayPath}/`, "directory");
          return;
        }
        if (entry.type === "file") {
          push(displayPath, "file");
        }
      });
    }

    return next.slice(0, MAX_SUGGESTIONS);
  };

  const requestSuggestions = async (token, tokenRequestId) => {
    const lookup = parsePathLookup(token.query);
    const workingDirectory = getWorkingDirectory();
    const directoryPathInput = resolveDirectoryPathInput(lookup.basePath, workingDirectory);

    const directoryPayload = await fetchDirectorySuggestions(directoryPathInput, lookup.term);
    if (requestId !== tokenRequestId || !directoryPayload) {
      if (requestId === tokenRequestId) {
        close();
      }
      return;
    }

    const resolvedDirectory = typeof directoryPayload.path === "string" ? directoryPayload.path : "";
    const docsPayload = await fetchDocsTree(resolvedDirectory);
    if (requestId !== tokenRequestId) {
      return;
    }

    let parentDocsPayload = null;
    const parentPath = typeof docsPayload?.parent?.path === "string" ? docsPayload.parent.path : "";
    if (!lookup.basePath && lookup.term && parentPath) {
      parentDocsPayload = await fetchDocsTree(parentPath);
      if (requestId !== tokenRequestId) {
        return;
      }
    }

    currentItems = buildSuggestions(lookup, directoryPayload, docsPayload, parentDocsPayload);
    activeIndex = currentItems.length > 0 ? 0 : -1;
    renderMenu();
  };

  const handleInput = () => {
    const cursor = textarea.selectionStart;
    const token = findMentionTokenAtCursor(textarea.value, cursor);
    if (!token) {
      close();
      return;
    }
    currentToken = token;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    const currentRequestId = ++requestId;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void requestSuggestions(token, currentRequestId);
    }, LOOKUP_DEBOUNCE_MS);
  };

  const handleKeydown = (event) => {
    if (menu.hidden || currentItems.length === 0) {
      return false;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(activeIndex + 1);
      renderMenu();
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(activeIndex - 1);
      renderMenu();
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      applySuggestion(activeIndex >= 0 ? activeIndex : 0);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return true;
    }
    return false;
  };

  textarea.addEventListener("blur", () => {
    setTimeout(() => {
      if (!menu.contains(document.activeElement)) {
        close();
      }
    }, 80);
  });

  textarea.addEventListener("scroll", () => {
    if (!menu.hidden) {
      close();
    }
  });

  return {
    handleInput,
    handleKeydown,
    close,
  };
}
