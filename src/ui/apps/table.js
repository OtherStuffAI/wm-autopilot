export function getAppDisplayName(app) {
  const label = typeof app?.label === "string" ? app.label.trim() : "";
  if (label.length > 0) return label;
  return String(app?.id ?? "Untitled app");
}

export function getAppStatusValue(app) {
  const status = typeof app?.status?.status === "string" ? app.status.status.trim() : "";
  return status.length > 0 ? status : "idle";
}

export function getAppTypeLabel(app) {
  if (Boolean(app?.webApp)) return "Web";
  return "Process";
}

export function getAppOpenUrl(app) {
  if (typeof app?.subdomainUrl === "string" && app.subdomainUrl.length > 0) {
    return app.subdomainUrl;
  }
  if (typeof app?.webAppUrl === "string" && app.webAppUrl.length > 0) {
    return app.webAppUrl;
  }
  return null;
}

export function getAppPortValue(app) {
  if (typeof app?.webAppPort === "number" && Number.isFinite(app.webAppPort)) {
    return app.webAppPort;
  }
  return null;
}

export function getAppUpdatedTime(app) {
  const timestamp = typeof app?.status?.updatedAt === "string" ? app.status.updatedAt : null;
  if (!timestamp) return 0;
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? time : 0;
}

export function getAppSearchText(app) {
  return [
    getAppDisplayName(app),
    app?.id,
    app?.notes,
    app?.description,
    app?.status?.message,
    app?.root,
    getAppPortValue(app),
  ]
    .filter((value) => value !== undefined && value !== null)
    .join(" ")
    .toLowerCase();
}

export function filterApps(apps, filterText) {
  if (!Array.isArray(apps)) return [];
  const terms = typeof filterText === "string"
    ? filterText.trim().toLowerCase().split(/\s+/).filter(Boolean)
    : [];
  if (terms.length === 0) return [...apps];

  return apps.filter((app) => {
    const searchText = getAppSearchText(app);
    return terms.every((term) => searchText.includes(term));
  });
}

export function sortApps(apps, sort) {
  if (!Array.isArray(apps)) return [];
  const key = typeof sort?.key === "string" ? sort.key : "title";
  const direction = sort?.direction === "desc" ? "desc" : "asc";

  return [...apps].sort((left, right) => {
    const comparison = compareApps(left, right, key, direction);
    if (comparison !== 0) return comparison;
    return getAppDisplayName(left).localeCompare(getAppDisplayName(right), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

export function filterAndSortApps(apps, filterText, sort) {
  return sortApps(filterApps(apps, filterText), sort);
}

export function renderAppsTable({
  apps,
  appStatusLabels = {},
  formatAppTimestamp,
  onOpenAppDetails,
  sort,
  onSortChange,
}) {
  const tableWrapper = document.createElement("div");
  tableWrapper.className = "wm-apps-table-wrapper wm-card";
  tableWrapper.dataset.testid = "apps-table-view";

  const table = document.createElement("table");
  table.className = "wm-apps-table";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  [
    { label: "Title", key: "title" },
    { label: "Status", key: "status" },
    { label: "Type" },
    { label: "Port", key: "port" },
    { label: "Updated", key: "updated" },
    { label: "Root" },
    { label: "" },
  ].forEach((column) => {
    headerRow.append(renderAppsTableHeader(column, sort, onSortChange));
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  apps.forEach((app) => {
    tbody.append(renderAppsTableRow({
      app,
      appStatusLabels,
      formatAppTimestamp,
      onOpenAppDetails,
    }));
  });
  table.append(tbody);
  tableWrapper.append(table);

  return tableWrapper;
}

function compareApps(left, right, key, direction) {
  if (key === "port") {
    return compareNullableNumbers(getAppPortValue(left), getAppPortValue(right), direction);
  }
  if (key === "updated") {
    return compareNullableNumbers(getAppUpdatedTime(left), getAppUpdatedTime(right), direction);
  }
  const factor = direction === "desc" ? -1 : 1;
  if (key === "status") {
    return getAppStatusValue(left).localeCompare(getAppStatusValue(right), undefined, {
      numeric: true,
      sensitivity: "base",
    }) * factor;
  }
  return getAppDisplayName(left).localeCompare(getAppDisplayName(right), undefined, {
    numeric: true,
    sensitivity: "base",
  }) * factor;
}

function compareNullableNumbers(left, right, direction) {
  const leftMissing = left === null || left === undefined || left === 0;
  const rightMissing = right === null || right === undefined || right === 0;
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  const comparison = left - right;
  return direction === "desc" ? comparison * -1 : comparison;
}

function renderAppsTableHeader(column, sort, onSortChange) {
  const th = document.createElement("th");
  th.scope = "col";
  if (!column.key) {
    th.textContent = column.label;
    return th;
  }

  const active = sort?.key === column.key;
  const direction = active && sort?.direction === "desc" ? "desc" : "asc";
  const nextDirection = active && direction === "asc" ? "desc" : "asc";
  th.setAttribute("aria-sort", active ? (direction === "asc" ? "ascending" : "descending") : "none");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-apps-table__sort";
  button.setAttribute("aria-label", `Sort by ${column.label} ${nextDirection === "asc" ? "ascending" : "descending"}`);
  button.dataset.testid = `apps-sort-${column.key}`;
  button.textContent = column.label;
  const indicator = document.createElement("span");
  indicator.className = "wm-apps-table__sort-indicator";
  indicator.setAttribute("aria-hidden", "true");
  indicator.textContent = active ? (direction === "asc" ? "↑" : "↓") : "↕";
  button.append(indicator);
  button.addEventListener("click", () => {
    onSortChange?.({ key: column.key, direction: nextDirection });
  });
  th.append(button);
  return th;
}

function renderAppsTableRow({
  app,
  appStatusLabels,
  formatAppTimestamp,
  onOpenAppDetails,
}) {
  const row = document.createElement("tr");
  row.className = "wm-apps-table-row";
  row.dataset.appId = String(app.id ?? "");
  row.tabIndex = 0;
  row.setAttribute("aria-label", `Open details for ${getAppDisplayName(app)}`);
  row.dataset.testid = "apps-table-row";

  row.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("a, button")) return;
    onOpenAppDetails(app);
  });
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target;
    if (target instanceof Element && target.closest("a, button")) return;
    event.preventDefault();
    onOpenAppDetails(app);
  });

  const nameCell = document.createElement("td");
  nameCell.className = "wm-apps-table__name-cell";
  const nameButton = document.createElement("button");
  nameButton.type = "button";
  nameButton.className = "wm-link-button wm-apps-table__name";
  nameButton.textContent = getAppDisplayName(app);
  nameButton.setAttribute("aria-label", `Open details for ${getAppDisplayName(app)}`);
  nameButton.dataset.testid = "apps-table-details";
  nameButton.addEventListener("click", () => onOpenAppDetails(app));
  const idLine = document.createElement("span");
  idLine.className = "wm-apps-table__id";
  idLine.textContent = String(app.id ?? "");
  nameCell.append(nameButton, idLine);
  row.append(nameCell);

  const statusCell = document.createElement("td");
  const statusValue = getAppStatusValue(app);
  const statusBadge = document.createElement("span");
  statusBadge.className = "wm-app-status";
  statusBadge.dataset.state = statusValue;
  statusBadge.textContent = appStatusLabels[statusValue] ?? statusValue;
  statusCell.append(statusBadge);
  row.append(statusCell);

  const typeCell = document.createElement("td");
  typeCell.textContent = getAppTypeLabel(app);
  row.append(typeCell);

  const portCell = document.createElement("td");
  const portValue = typeof app.webAppPort === "number" ? String(app.webAppPort) : "-";
  const openUrl = getAppOpenUrl(app);
  if (openUrl) {
    const link = document.createElement("a");
    link.href = openUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = portValue === "-" ? "Open" : portValue;
    link.setAttribute("aria-label", `Open ${getAppDisplayName(app)}`);
    portCell.append(link);
  } else {
    portCell.textContent = portValue;
  }
  row.append(portCell);

  const updatedCell = document.createElement("td");
  updatedCell.textContent = formatAppTimestamp(app.status?.updatedAt ?? null);
  row.append(updatedCell);

  const rootCell = document.createElement("td");
  rootCell.className = "wm-apps-table__root";
  rootCell.title = typeof app.root === "string" ? app.root : "";
  rootCell.textContent = typeof app.root === "string" && app.root.length > 0 ? app.root : "-";
  row.append(rootCell);

  const actionCell = document.createElement("td");
  actionCell.className = "wm-apps-table__actions";
  const detailsButton = document.createElement("button");
  detailsButton.type = "button";
  detailsButton.className = "wm-button secondary wm-button--small";
  detailsButton.textContent = "Details";
  detailsButton.setAttribute("aria-label", `Open details for ${getAppDisplayName(app)}`);
  detailsButton.addEventListener("click", () => onOpenAppDetails(app));
  actionCell.append(detailsButton);
  row.append(actionCell);

  return row;
}
