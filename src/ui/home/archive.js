/**
 * Session Archive component for the home page.
 * Displays a collapsible list of archived sessions with filtering capability.
 */

import { renderChatMessageHtml } from "../rendering/chat-message-content.js";
import { canResumeNativeAgentSession } from "./native-session-resume.js";
import {
  countSessionsByHomeGroup,
  HOME_SESSION_GROUPS,
} from "./session-groups.js";
import { createSessionGroupTabs } from "./session-group-tabs.js";

const ARCHIVE_STORAGE_KEY = "wingman-archive-collapsed";

const escapeHtml = (text) => {
  if (typeof text !== "string") return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

const formatRelativeTime = (isoString) => {
  if (!isoString) return "-";
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
};

const truncateDirectory = (dir, maxLen = 40) => {
  if (!dir || dir.length <= maxLen) return dir ?? "-";
  return "..." + dir.slice(-maxLen + 3);
};

/**
 * Fetches archived sessions from the API.
 */
const fetchArchive = async (options = {}) => {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.offset) params.set("offset", String(options.offset));
  if (options.filter && options.filter.trim()) params.set("filter", options.filter.trim());
  if (options.group && options.group !== "all") params.set("category", options.group);

  const url = `/api/archive${params.toString() ? `?${params}` : ""}`;
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Failed to fetch archive: ${response.status}`);
  }
  return response.json();
};

/**
 * Fetches a single archived session with messages.
 */
const fetchArchivedSession = async (sessionId) => {
  const response = await fetch(`/api/archive/${sessionId}`, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Failed to fetch archived session: ${response.status}`);
  }
  return response.json();
};

/**
 * Creates the archive component for the home page.
 */
export function createArchiveComponent({
  onViewSession,
  resumeNativeSession,
  getSessionPendingAction,
  isSessionActionPending,
  withPendingSessionAction,
  titleText = "Archive",
  storageKey = ARCHIVE_STORAGE_KEY,
  defaultCollapsed = true,
  collapsible = true,
} = {}) {
  let archiveState = {
    sessions: [],
    total: 0,
    loading: false,
    error: null,
    filter: "",
    group: HOME_SESSION_GROUPS[0]?.id ?? "my",
    groupCounts: { my: 0, auto: 0 },
    offset: 0,
    limit: 10,
  };

  const card = document.createElement("section");
  card.className = `wm-card wm-home-archive${collapsible ? "" : " wm-home-archive--fixed"}`;

  const header = document.createElement("div");
  header.className = "wm-home-section-header";
  if (collapsible) {
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
  }

  const title = document.createElement("h2");
  title.textContent = titleText;

  const badge = document.createElement("span");
  badge.className = "wm-home-archive-badge";
  badge.textContent = "0";

  const headerLeft = document.createElement("div");
  headerLeft.className = "wm-home-archive-header-left";
  headerLeft.append(title, badge);
  
  // Add refresh button
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "wm-button secondary wm-home-archive-refresh";
  refreshBtn.textContent = "Refresh";
  refreshBtn.title = "Refresh archive";
  refreshBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    archiveState.offset = 0;
    void loadArchive();
  });

  const collapseIcon = document.createElement("span");
  collapseIcon.className = "wm-home-archive-collapse-icon";
  collapseIcon.setAttribute("aria-hidden", "true");
  collapseIcon.textContent = "▼";

  header.append(headerLeft, collapseIcon, refreshBtn);

  const content = document.createElement("div");
  content.className = "wm-home-archive-content";

  // Filter input
  const filterRow = document.createElement("div");
  filterRow.className = "wm-home-archive-filter";

  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.className = "wm-input";
  filterInput.placeholder = "Filter by name, directory, or tag (use * for wildcard)";
  filterInput.setAttribute("aria-label", "Filter archived sessions");

  let filterDebounceTimer = null;
  filterInput.addEventListener("input", () => {
    if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
    filterDebounceTimer = setTimeout(() => {
      archiveState.filter = filterInput.value;
      archiveState.offset = 0;
      void loadArchive();
    }, 300);
  });

  filterRow.append(filterInput);

  const groupTabsContainer = document.createElement("div");
  groupTabsContainer.className = "wm-home-archive-session-groups";

  // Sessions list container
  const listContainer = document.createElement("div");
  listContainer.className = "wm-home-archive-list";

  // Load more button
  const loadMoreRow = document.createElement("div");
  loadMoreRow.className = "wm-home-archive-load-more";

  const loadMoreButton = document.createElement("button");
  loadMoreButton.type = "button";
  loadMoreButton.className = "wm-button secondary";
  loadMoreButton.textContent = "Load More";
  loadMoreButton.addEventListener("click", () => {
    archiveState.offset += archiveState.limit;
    void loadArchive(true);
  });

  loadMoreRow.append(loadMoreButton);

  content.append(filterRow, groupTabsContainer, listContainer, loadMoreRow);
  card.append(header, content);

  // Collapse state
  const savedCollapsed = collapsible ? localStorage.getItem(storageKey) : "false";
  let isCollapsed = collapsible ? savedCollapsed !== "false" : false;
  if (savedCollapsed == null) {
    isCollapsed = Boolean(defaultCollapsed);
  }

  const setCollapsed = (collapsed) => {
    isCollapsed = collapsible ? collapsed : false;
    if (collapsible) {
      localStorage.setItem(storageKey, String(isCollapsed));
    }
    if (isCollapsed) {
      card.dataset.collapsed = "true";
      content.hidden = true;
      collapseIcon.textContent = "▶";
      header.setAttribute("aria-expanded", "false");
    } else {
      delete card.dataset.collapsed;
      content.hidden = false;
      collapseIcon.textContent = "▼";
      header.setAttribute("aria-expanded", "true");
      // Load archive when expanded (but not automatically on every render)
      if (archiveState.sessions.length === 0 && !archiveState.loading && !isCollapsed) {
        void loadArchive();
      }
    }
  };

  if (collapsible) {
    header.addEventListener("click", () => {
      setCollapsed(!isCollapsed);
    });

    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setCollapsed(!isCollapsed);
      }
    });
  }

  const renderList = () => {
    listContainer.innerHTML = "";
    groupTabsContainer.innerHTML = "";

    const activeGroup = HOME_SESSION_GROUPS.some((group) => group.id === archiveState.group)
      ? archiveState.group
      : HOME_SESSION_GROUPS[0].id;
    groupTabsContainer.append(
      createSessionGroupTabs(activeGroup, archiveState.groupCounts, (nextGroup) => {
        archiveState.group = nextGroup;
        archiveState.offset = 0;
        void loadArchive();
      }),
    );

    if (archiveState.loading && archiveState.sessions.length === 0) {
      const loading = document.createElement("div");
      loading.className = "wm-home-archive-status";
      loading.textContent = "Loading archive...";
      listContainer.append(loading);
      loadMoreRow.hidden = true;
      return;
    }

    if (archiveState.error) {
      const error = document.createElement("div");
      error.className = "wm-home-archive-status wm-home-archive-error";
      error.textContent = archiveState.error;
      listContainer.append(error);
      loadMoreRow.hidden = true;
      return;
    }

    if (archiveState.sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wm-home-archive-status";
      empty.textContent = archiveState.filter
        ? "No archived sessions match your filter"
        : "No archived sessions";
      listContainer.append(empty);
      loadMoreRow.hidden = true;
      return;
    }

    archiveState.sessions.forEach((session) => {
      const item = document.createElement("div");
      item.className = "wm-home-archive-item";
      item.setAttribute("role", "button");
      item.setAttribute("tabindex", "0");

      const itemMain = document.createElement("div");
      itemMain.className = "wm-home-archive-item-main";

      const itemName = document.createElement("span");
      itemName.className = "wm-home-archive-item-name";
      itemName.textContent = session.name || `Session ${session.id.slice(0, 8)}`;

      const itemAgent = document.createElement("span");
      itemAgent.className = "wm-home-archive-item-agent";
      itemAgent.textContent = session.agent;

      itemMain.append(itemName, itemAgent);

      const itemMeta = document.createElement("div");
      itemMeta.className = "wm-home-archive-item-meta";

      const itemDir = document.createElement("span");
      itemDir.className = "wm-home-archive-item-dir";
      itemDir.textContent = truncateDirectory(session.workingDirectory);
      itemDir.title = session.workingDirectory || "";

      const itemTime = document.createElement("span");
      itemTime.className = "wm-home-archive-item-time";
      itemTime.textContent = `Updated ${formatRelativeTime(session.lastUpdatedAt)}`;
      itemTime.title = session.lastUpdatedAt
        ? `Last updated ${new Date(session.lastUpdatedAt).toLocaleString()}`
        : "No session output yet";

      const itemMessages = document.createElement("span");
      itemMessages.className = "wm-home-archive-item-messages";
      itemMessages.textContent = `${session.messageCount} msgs`;

      itemMeta.append(itemDir, itemTime, itemMessages);

      const tags = Array.isArray(session.metadata?.tags) ? session.metadata.tags : [];
      const tagRow = document.createElement("div");
      tagRow.className = "wm-home-archive-item-tags";
      tagRow.hidden = tags.length === 0;
      for (const tag of tags.slice(0, 8)) {
        const tagChip = document.createElement("span");
        tagChip.className = "wm-home-archive-item-tag";
        tagChip.textContent = tag;
        tagRow.append(tagChip);
      }

      item.append(itemMain, itemMeta, tagRow);

      if (canResumeNativeAgentSession(session) && typeof resumeNativeSession === "function") {
        const actions = document.createElement("div");
        actions.className = "wm-home-archive-item-actions";

        const pendingAction =
          typeof getSessionPendingAction === "function"
            ? getSessionPendingAction(session.id)
            : null;
        const pending =
          typeof isSessionActionPending === "function"
            ? isSessionActionPending(session.id)
            : false;

        const nativeResumeBtn = document.createElement("button");
        nativeResumeBtn.type = "button";
        nativeResumeBtn.className = "wm-button";
        nativeResumeBtn.textContent = pendingAction === "resume-native" ? "Resuming..." : "Resume";
        nativeResumeBtn.disabled = pending;
        nativeResumeBtn.setAttribute("aria-label", `Resume agent session for ${session.name || session.id}`);
        nativeResumeBtn.dataset.testid = "resume-native-archived-session";
        nativeResumeBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          const runResume = async () => {
            await resumeNativeSession(session.id);
          };
          if (typeof withPendingSessionAction === "function") {
            void withPendingSessionAction(session.id, "resume-native", runResume);
            return;
          }
          void runResume();
        });

        actions.append(nativeResumeBtn);
        item.append(actions);
      }

      const handleClick = () => {
        if (typeof onViewSession === "function") {
          onViewSession(session);
        }
      };

      item.addEventListener("click", handleClick);
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      });

      listContainer.append(item);
    });

    // Show/hide load more button
    const hasMore = archiveState.offset + archiveState.sessions.length < archiveState.total;
    loadMoreRow.hidden = !hasMore || archiveState.loading;
  };

  const loadArchive = async (append = false) => {
    // Prevent multiple concurrent loads
    if (archiveState.loading) {
      return;
    }
    
    archiveState.loading = true;
    archiveState.error = null;
    renderList();

    try {
      const data = await fetchArchive({
        limit: archiveState.limit,
        offset: archiveState.offset,
        filter: archiveState.filter || undefined,
        group: archiveState.group,
      });

      if (append) {
        archiveState.sessions = [...archiveState.sessions, ...data.sessions];
      } else {
        archiveState.sessions = data.sessions;
      }
      archiveState.total = data.total;
      archiveState.groupCounts = data.groupCounts && typeof data.groupCounts === "object"
        ? data.groupCounts
        : countSessionsByHomeGroup(archiveState.sessions);
      badge.textContent = String(data.total);
    } catch (error) {
      archiveState.error = error instanceof Error ? error.message : "Failed to load archive";
    } finally {
      archiveState.loading = false;
      renderList();
    }
  };

  // Initialize collapsed state
  setCollapsed(isCollapsed);

  // Public API
  return {
    element: card,
    refresh: () => {
      archiveState.offset = 0;
      return loadArchive();
    },
    loadArchive,
  };
}

/**
 * Creates a dialog to view an archived session's conversation.
 */
export function createArchiveViewDialog({ getConfig } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "wm-dialog-overlay wm-archive-dialog-overlay";
  overlay.hidden = true;

  const dialog = document.createElement("div");
  dialog.className = "wm-dialog wm-archive-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const header = document.createElement("div");
  header.className = "wm-dialog-header wm-archive-dialog-header";

  const title = document.createElement("h2");
  title.className = "wm-dialog-title";
  title.textContent = "Archived Session";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wm-dialog-close";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.innerHTML = "&times;";

  header.append(title, closeButton);

  const meta = document.createElement("div");
  meta.className = "wm-archive-dialog-meta";

  const content = document.createElement("div");
  content.className = "wm-archive-dialog-content";

  const messagesContainer = document.createElement("div");
  messagesContainer.className = "wm-archive-dialog-messages";

  content.append(messagesContainer);
  dialog.append(header, meta, content);
  overlay.append(dialog);

  let currentSession = null;

  const close = () => {
    overlay.hidden = true;
    currentSession = null;
  };

  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  const renderMeta = (session) => {
    meta.innerHTML = "";
    const items = [
      ["Agent", session.agent],
      ["Directory", session.workingDirectory || "-"],
      ["Started", session.startedAt ? new Date(session.startedAt).toLocaleString() : "-"],
      ["Last updated", session.lastUpdatedAt ? new Date(session.lastUpdatedAt).toLocaleString() : "-"],
      ["Archived", session.archivedAt ? new Date(session.archivedAt).toLocaleString() : "-"],
      ["Tags", Array.isArray(session.metadata?.tags) && session.metadata.tags.length > 0 ? session.metadata.tags.join(", ") : "-"],
    ];

    items.forEach(([label, value]) => {
      const item = document.createElement("div");
      item.className = "wm-archive-dialog-meta-item";
      item.innerHTML = `<span class="label">${escapeHtml(label)}:</span> <span class="value">${escapeHtml(value)}</span>`;
      meta.append(item);
    });
  };

  const renderMessages = (messages) => {
    messagesContainer.innerHTML = "";

    if (!messages || messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wm-archive-dialog-empty";
      empty.textContent = "No messages in this session";
      messagesContainer.append(empty);
      return;
    }

    messages.forEach((msg) => {
      const msgEl = document.createElement("div");
      msgEl.className = `wm-archive-dialog-message wm-archive-dialog-message-${msg.role}`;

      const roleEl = document.createElement("div");
      roleEl.className = "wm-archive-dialog-message-role";
      roleEl.textContent = msg.role === "user" ? "User" : "Assistant";

      const contentEl = document.createElement("div");
      contentEl.className = "wm-archive-dialog-message-content";
      contentEl.innerHTML = renderChatMessageHtml(msg.content, {
        config: typeof getConfig === "function" ? getConfig() : null,
      });

      const timeEl = document.createElement("div");
      timeEl.className = "wm-archive-dialog-message-time";
      timeEl.textContent = msg.createdAt ? new Date(msg.createdAt).toLocaleString() : "";

      msgEl.append(roleEl, contentEl, timeEl);
      messagesContainer.append(msgEl);
    });
  };

  const open = async (session) => {
    currentSession = session;
    title.textContent = session.name || `Session ${session.id.slice(0, 8)}`;
    renderMeta(session);
    messagesContainer.innerHTML = '<div class="wm-archive-dialog-loading">Loading messages...</div>';
    overlay.hidden = false;

    try {
      const data = await fetchArchivedSession(session.id);
      if (currentSession?.id === session.id) {
        renderMessages(data.messages);
      }
    } catch (error) {
      if (currentSession?.id === session.id) {
        messagesContainer.innerHTML = `<div class="wm-archive-dialog-error">Failed to load messages: ${escapeHtml(error.message)}</div>`;
      }
    }
  };

  return {
    element: overlay,
    open,
    close,
  };
}
