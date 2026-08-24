const SESSION_STATUS_ORDER = Object.freeze({
  starting: 0,
  running: 1,
  stopping: 2,
  stopped: 3,
  completed: 4,
  failed: 5,
});

const SESSION_TABLE_COLUMNS = Object.freeze([
  { key: "actions", label: "Actions" },
  { key: "name", label: "Name" },
  { key: "started", label: "Started" },
  { key: "updated", label: "Last updated" },
  { key: "directory", label: "Directory" },
  { key: "agent", label: "Agent" },
  { key: "status", label: "Status" },
]);

export const DEFAULT_LIVE_SESSION_SORT = Object.freeze({
  key: "started",
  direction: "desc",
});

const DIRECTORY_DISPLAY_MAX_LENGTH = 44;

function defaultEscapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveTimestamp(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatDateTime(date) {
  try {
    return date.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return date.toLocaleString();
  }
}

export function formatSessionStartedAt(value) {
  const timestamp = resolveTimestamp(value);
  if (timestamp === null) {
    return "-";
  }
  return formatDateTime(new Date(timestamp));
}

export function getSessionDirectoryValue(session, defaultDirectory) {
  return session?.workingDirectory ?? defaultDirectory ?? "-";
}

export function formatSessionDirectoryDisplay(directory, maxLength = DIRECTORY_DISPLAY_MAX_LENGTH) {
  const value = typeof directory === "string" ? directory.trim() : "";
  if (!value) {
    return "-";
  }
  if (value.length <= maxLength) {
    return value;
  }

  const normalized = value.length > 1 ? value.replace(/\/+$/, "") : value;
  const segments = normalized.split("/").filter(Boolean);
  const tail = segments.at(-1) ?? normalized;
  if (tail.length + 3 >= maxLength) {
    const tailLength = Math.max(1, maxLength - 3);
    return `...${tail.slice(-tailLength)}`;
  }

  let display = `.../${tail}`;
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const candidate = `.../${segments.slice(index).join("/")}`;
    if (candidate.length > maxLength) {
      break;
    }
    display = candidate;
  }
  return display;
}

function getSessionStatusValue(session) {
  const runtimeStatus =
    typeof session?.agentRuntimeStatus === "string" && session.agentRuntimeStatus.trim().length > 0
      ? session.agentRuntimeStatus.trim().toLowerCase()
      : null;
  const status =
    typeof session?.status === "string" && session.status.trim().length > 0
      ? session.status.trim().toLowerCase()
      : null;
  return runtimeStatus ?? status ?? "unknown";
}

function getStatusSortValue(session) {
  const status = getSessionStatusValue(session);
  return SESSION_STATUS_ORDER[status] ?? Number.MAX_SAFE_INTEGER;
}

function getSessionSortValue(session, key, deps) {
  const { getSessionDisplayName, isSessionActive, defaultDirectory } = deps;

  switch (key) {
    case "actions":
      return isSessionActive(session) ? 1 : 0;
    case "name":
      return getSessionDisplayName(session);
    case "agent":
      return session?.agent ?? "";
    case "status":
      return getStatusSortValue(session);
    case "started":
      return resolveTimestamp(session?.startedAt) ?? 0;
    case "updated":
      return resolveTimestamp(session?.lastUpdatedAt) ?? 0;
    case "directory":
      return getSessionDirectoryValue(session, defaultDirectory);
    default:
      return "";
  }
}

function compareSessionSortValues(left, right) {
  if (left === right) {
    return 0;
  }
  if (left === null || left === undefined) {
    return 1;
  }
  if (right === null || right === undefined) {
    return -1;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function toggleSessionSort(currentSort, key) {
  if (!currentSort || currentSort.key !== key) {
    return {
      key,
      direction: key === "started" ? "desc" : "asc",
    };
  }
  return {
    key,
    direction: currentSort.direction === "asc" ? "desc" : "asc",
  };
}

export function sortSessions(sessions, sort, deps) {
  if (!Array.isArray(sessions) || sessions.length < 2 || !sort?.key || !sort?.direction) {
    return Array.isArray(sessions) ? [...sessions] : [];
  }

  const directionMultiplier = sort.direction === "desc" ? -1 : 1;

  return sessions
    .map((session, index) => ({
      session,
      index,
      value: getSessionSortValue(session, sort.key, deps),
    }))
    .sort((left, right) => {
      const valueComparison =
        compareSessionSortValues(left.value, right.value) * directionMultiplier;
      if (valueComparison !== 0) {
        return valueComparison;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.session);
}

function getSessionSortIndicator(sort, key) {
  if (!sort || sort.key !== key) {
    return "↕";
  }
  return sort.direction === "asc" ? "↑" : "↓";
}

function createSortableHeaderCell(column, sessionSort, onSessionSortChange) {
  const th = document.createElement("th");
  const isActiveSort = sessionSort?.key === column.key;
  th.setAttribute(
    "aria-sort",
    isActiveSort
      ? sessionSort.direction === "asc"
        ? "ascending"
        : "descending"
      : "none",
  );

  const button = document.createElement("button");
  button.type = "button";
  button.className = "session-table-sort-button";
  button.dataset.active = isActiveSort ? "true" : "false";
  button.setAttribute("aria-label", `Sort by ${column.label}`);
  button.setAttribute("data-testid", `session-sort-${column.key}`);
  button.addEventListener("click", () => {
    onSessionSortChange(toggleSessionSort(sessionSort, column.key));
  });

  const label = document.createElement("span");
  label.className = "session-table-sort-label";
  label.textContent = column.label;

  const indicator = document.createElement("span");
  indicator.className = "session-table-sort-indicator";
  indicator.setAttribute("aria-hidden", "true");
  indicator.textContent = getSessionSortIndicator(sessionSort, column.key);

  button.append(label, indicator);
  th.append(button);
  return th;
}

export function createSessionTable(orderedSessions, deps) {
  const {
    state,
    sessionSort,
    onSessionSortChange,
    createAgentStatusIndicator,
    getSessionDisplayName,
    promptRenameSession,
    escapeHtml = defaultEscapeHtml,
    isSessionActionPending,
    renderSessionActions,
    emptyLabel = 'No active sessions',
  } = deps;

  const table = document.createElement("table");
  table.className = "session-table";
  table.setAttribute("aria-label", "Live agent sessions");

  const colgroup = document.createElement("colgroup");
  SESSION_TABLE_COLUMNS.forEach(({ key }) => {
    const col = document.createElement("col");
    col.className = `session-col-${key}`;
    colgroup.append(col);
  });
  table.append(colgroup);

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  SESSION_TABLE_COLUMNS.forEach((column) => {
    headerRow.append(createSortableHeaderCell(column, sessionSort, onSessionSortChange));
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  if (orderedSessions.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = SESSION_TABLE_COLUMNS.length;
    cell.textContent = emptyLabel;
    row.append(cell);
    tbody.append(row);
    table.append(tbody);
    return table;
  }

  orderedSessions.forEach((session) => {
    const row = document.createElement("tr");
    const displayName = getSessionDisplayName(session);

    row.innerHTML = `
      <td class="actions-cell"></td>
      <td class="session-name-cell">
        <span class="session-name-text">${escapeHtml(displayName)}</span>
        <button type="button" class="wm-link-button session-name-edit" data-action="rename-session">Edit</button>
      </td>
      <td title="${escapeHtml(session.startedAt ?? "")}">${escapeHtml(formatSessionStartedAt(session.startedAt))}</td>
      <td title="${escapeHtml(session.lastUpdatedAt ?? "")}">${escapeHtml(formatSessionStartedAt(session.lastUpdatedAt))}</td>
      <td class="directory-cell"></td>
      <td>${escapeHtml(session.agent)}</td>
      <td class="session-status-cell">
        <div class="wm-agent-status-indicator" data-session-id="${escapeHtml(session.id)}"></div>
        <span class="session-status-text">${escapeHtml(session.status)}</span>
      </td>
    `;

    const directoryCell = row.querySelector(".directory-cell");
    if (directoryCell) {
      const directoryValue = getSessionDirectoryValue(session, state.config?.defaultDirectory);
      directoryCell.textContent = formatSessionDirectoryDisplay(directoryValue);
      if (directoryValue !== "-") {
        directoryCell.title = directoryValue;
      } else {
        directoryCell.removeAttribute("title");
      }
    }

    const renameButton = row.querySelector('[data-action="rename-session"]');
    if (renameButton instanceof HTMLButtonElement) {
      renameButton.disabled = isSessionActionPending(session.id);
      renameButton.addEventListener("click", (event) => {
        event.preventDefault();
        promptRenameSession(session);
      });
    }

    const actionsCell = row.querySelector(".actions-cell");
    if (actionsCell) {
      renderSessionActions(actionsCell, session);
    }

    const statusIndicatorRoot = row.querySelector(".wm-agent-status-indicator");
    if (statusIndicatorRoot) {
      statusIndicatorRoot.replaceWith(createAgentStatusIndicator(session.id));
    }

    tbody.append(row);
  });

  table.append(tbody);
  return table;
}
