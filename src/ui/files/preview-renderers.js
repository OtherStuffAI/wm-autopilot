function valueTypeLabel(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return `object(${Object.keys(value).length})`;
  return typeof value;
}

function formatScalar(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  return String(value);
}

function createJsonNode(label, value) {
  const row = document.createElement("div");
  row.className = "wm-json-preview__row";

  if (value !== null && typeof value === "object") {
    const details = document.createElement("details");
    details.className = "wm-json-preview__branch";
    details.open = true;

    const summary = document.createElement("summary");
    const key = document.createElement("span");
    key.className = "wm-json-preview__key";
    key.textContent = label;
    const meta = document.createElement("span");
    meta.className = "wm-json-preview__meta";
    meta.textContent = valueTypeLabel(value);
    summary.append(key, meta);
    details.append(summary);

    const children = document.createElement("div");
    children.className = "wm-json-preview__children";
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item])
      : Object.entries(value);
    for (const [childLabel, childValue] of entries) {
      children.append(createJsonNode(childLabel, childValue));
    }
    details.append(children);
    row.append(details);
    return row;
  }

  const key = document.createElement("span");
  key.className = "wm-json-preview__key";
  key.textContent = label;
  const scalar = document.createElement("code");
  scalar.className = `wm-json-preview__value wm-json-preview__value--${valueTypeLabel(value)}`;
  scalar.textContent = formatScalar(value);
  row.append(key, scalar);
  return row;
}

export function createJsonPreview(content) {
  const container = document.createElement("div");
  container.className = "wm-json-preview";
  container.dataset.testid = "files-json-preview";

  try {
    const parsed = JSON.parse(content);
    container.append(createJsonNode("root", parsed));
  } catch (error) {
    const message = document.createElement("div");
    message.className = "wm-files-browser__status";
    message.textContent = `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    const pre = document.createElement("pre");
    pre.className = "wm-files-preview-code";
    pre.textContent = content;
    container.append(message, pre);
  }

  return container;
}

export function parseDelimitedRows(content, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export function createCsvPreview(content, language = "csv") {
  const delimiter = language === "tsv" ? "\t" : ",";
  const rows = parseDelimitedRows(content, delimiter);
  const container = document.createElement("div");
  container.className = "wm-csv-preview";
  container.dataset.testid = "files-csv-preview";

  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "wm-files-browser__status";
    empty.textContent = "No rows to display.";
    container.append(empty);
    return container;
  }

  const meta = document.createElement("div");
  meta.className = "wm-csv-preview__meta";
  meta.textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;

  const tableWrap = document.createElement("div");
  tableWrap.className = "wm-csv-preview__table-wrap";
  const table = document.createElement("table");
  table.className = "wm-csv-preview__table";

  const [headerRow = [], ...bodyRows] = rows;
  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  headerRow.forEach((cell) => {
    const th = document.createElement("th");
    th.textContent = cell;
    header.append(th);
  });
  thead.append(header);
  table.append(thead);

  const tbody = document.createElement("tbody");
  bodyRows.forEach((cells) => {
    const tr = document.createElement("tr");
    const width = Math.max(headerRow.length, cells.length);
    for (let index = 0; index < width; index += 1) {
      const td = document.createElement("td");
      td.textContent = cells[index] ?? "";
      tr.append(td);
    }
    tbody.append(tr);
  });
  table.append(tbody);

  tableWrap.append(table);
  container.append(meta, tableWrap);
  return container;
}

export function createPdfPreview(files, buildInlineUrl) {
  const container = document.createElement("div");
  container.className = "wm-pdf-preview";
  container.dataset.testid = "files-pdf-preview";

  const title = document.createElement("h3");
  title.textContent = files.previewName || "PDF document";

  const action = document.createElement("button");
  action.type = "button";
  action.className = "wm-button primary";
  action.textContent = "Open PDF";
  action.dataset.testid = "files-open-pdf-button";
  action.addEventListener("click", () => {
    const url = buildInlineUrl(files.previewPath);
    window.open(url, "_blank", "noopener");
  });

  container.append(title, action);
  return container;
}
