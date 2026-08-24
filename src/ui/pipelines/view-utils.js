import { cleanAgentOutputText } from "./agent-output-format.js";

export const RUN_FILTERS = ["all", "default", "running", "ok", "needs_input", "error", "cancelled"];
export const DEFINITION_FILTERS = ["all", "default", "user", "shared"];

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

export function titleCase(value) {
  return String(value ?? "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function statusLabel(value) {
  if (value === "ok") return "Complete";
  if (value === "error") return "Failed";
  if (value === "needs_input") return "Needs Input";
  if (value === "cancelled") return "Stopped";
  return titleCase(value);
}

export function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((entry) => String(entry ?? "").trim().toLowerCase())
    .filter(Boolean))]
    .sort();
}

export function collectTags(records) {
  const tags = new Set();
  (Array.isArray(records) ? records : []).forEach((record) => {
    normalizeTags(record?.tags).forEach((tag) => tags.add(tag));
  });
  return [...tags].sort();
}

export function renderTagPills(tags) {
  const normalized = normalizeTags(tags);
  if (normalized.length === 0) return "";
  return `
    <span class="wm-pipeline-tag-list">
      ${normalized.map((tag) => `<span class="wm-pipeline-tag">${escapeHtml(tag)}</span>`).join("")}
    </span>
  `;
}

export function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDuration(startValue, endValue) {
  if (!startValue) return "--";
  const start = new Date(startValue).getTime();
  const end = endValue ? new Date(endValue).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "--";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
}

export function formatRunMeta(run) {
  const started = formatDateTime(run.startedAt ?? run.started_at);
  const duration = formatDuration(run.startedAt ?? run.started_at, run.completedAt ?? run.completed_at);
  return [started, duration].filter((value) => value && value !== "--").join(" - ") || "--";
}

export function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
}

export function renderJsonBlock(title, value) {
  return `
    <section class="wm-pipeline-json-block" data-testid="pipeline-json-block">
      <div class="wm-pipeline-json-block-header">
        <h3>${escapeHtml(title)}</h3>
        <span>${escapeHtml(describeJsonValue(value))}</span>
      </div>
      <div class="wm-pipeline-json-tree" data-testid="pipeline-json-tree">
        ${renderJsonTreeNode("root", value, 0)}
      </div>
    </section>
  `;
}

export function renderJsonTransformBlock(inputValue, outputValue, options = {}) {
  const diff = buildOutputDiff(inputValue, outputValue);
  const changeCount = diff.changed ? countDiffLeaves(diff.value) : 0;
  const renderOptions = {
    cleanAgentText: Boolean(options.cleanAgentText),
  };
  return `
    <section class="wm-pipeline-transform-block" data-testid="pipeline-transform-block">
      <div class="wm-pipeline-transform-header">
        <div>
          <h3>Transform</h3>
          <p>New and changed output data</p>
        </div>
        <span>${escapeHtml(changeCount ? `${changeCount} change${changeCount === 1 ? "" : "s"}` : "No changes")}</span>
      </div>
      ${diff.changed
        ? `<div class="wm-pipeline-json-tree wm-pipeline-json-tree-transform" data-testid="pipeline-transform-tree">
            ${renderJsonTreeEntries(diff.value, renderOptions)}
          </div>`
        : `<div class="wm-pipeline-transform-empty">Output matches input for this step.</div>`}
    </section>
  `;
}

export function buildOutputDiff(inputValue, outputValue) {
  if (jsonValuesEqual(inputValue, outputValue)) {
    return { changed: false, value: undefined };
  }

  if (isObjectLike(inputValue) && isObjectLike(outputValue)) {
    const diffValue = {};
    for (const [key, nextValue] of getJsonEntries(outputValue)) {
      const previousValue = getJsonChild(inputValue, key);
      const childDiff = buildOutputDiff(previousValue, nextValue);
      if (childDiff.changed) {
        diffValue[key] = childDiff.value;
      }
    }
    if (Object.keys(diffValue).length > 0) {
      return { changed: true, value: diffValue };
    }
    return { changed: false, value: undefined };
  }

  return { changed: true, value: outputValue };
}

function renderJsonTreeNode(label, value, depth, options = {}) {
  if (value !== null && typeof value === "object") {
    return renderJsonBranch(label, value, depth, options);
  }
  return renderJsonScalar(label, value, options);
}

function renderJsonTreeEntries(value, options = {}) {
  if (value !== null && typeof value === "object") {
    const entries = getJsonEntries(value);
    if (!entries.length) return `<span class="wm-pipeline-json-empty">No fields</span>`;
    return entries.map(([label, childValue]) => renderJsonTreeNode(label, childValue, 0, options)).join("");
  }
  return renderJsonTreeNode("value", value, 0, options);
}

function renderJsonBranch(label, value, depth, options = {}) {
  const entries = getJsonEntries(value);
  const openAttribute = depth < 2 ? " open" : "";
  return `
    <details class="wm-pipeline-json-branch"${openAttribute}>
      <summary>
        <span class="wm-pipeline-json-key">${escapeHtml(label)}</span>
        <span class="wm-pipeline-json-meta">${escapeHtml(describeJsonValue(value))}</span>
      </summary>
      <div class="wm-pipeline-json-children">
        ${entries.length
          ? entries.map(([childLabel, childValue]) => renderJsonTreeNode(childLabel, childValue, depth + 1, options)).join("")
          : `<span class="wm-pipeline-json-empty">Empty ${Array.isArray(value) ? "array" : "object"}</span>`}
      </div>
    </details>
  `;
}

function renderJsonScalar(label, value, options = {}) {
  return `
    <div class="wm-pipeline-json-row">
      <span class="wm-pipeline-json-key">${escapeHtml(label)}</span>
      ${renderJsonScalarValue(value, options)}
    </div>
  `;
}

function renderJsonScalarValue(value, options = {}) {
  const displayValue = options.cleanAgentText && typeof value === "string" ? cleanAgentOutputText(value) : value;
  const type = getJsonValueType(value);
  if (typeof displayValue === "string" && shouldRenderTextLines(displayValue)) {
    return renderJsonTextValue(displayValue);
  }
  return `<code class="wm-pipeline-json-value wm-pipeline-json-value-${escapeAttribute(type)}">${escapeHtml(formatScalarValue(displayValue))}</code>`;
}

function renderJsonTextValue(value) {
  const lines = splitTextLines(value);
  return `
    <div class="wm-pipeline-json-text" data-lines="${escapeAttribute(String(lines.length))}">
      ${lines.map((line, index) => `
        <div class="wm-pipeline-json-text-line">
          <span class="wm-pipeline-json-line-number">${index + 1}</span>
          <code>${line ? escapeHtml(line) : "&nbsp;"}</code>
        </div>
      `).join("")}
    </div>
  `;
}

function shouldRenderTextLines(value) {
  return value.includes("\n") || value.includes("\r") || value.length > 80 || /\s/.test(value);
}

function splitTextLines(value) {
  return value.split(/\r\n|\r|\n/);
}

function formatScalarValue(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  return String(value);
}

function describeJsonValue(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (value !== null && typeof value === "object") {
    const count = Object.keys(value).length;
    return `${count} field${count === 1 ? "" : "s"}`;
  }
  if (typeof value === "string") {
    const lines = splitTextLines(value).length;
    if (lines > 1) return `${lines} lines`;
    return `${value.length} char${value.length === 1 ? "" : "s"}`;
  }
  return getJsonValueType(value);
}

function getJsonValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function getJsonEntries(value) {
  return Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
}

function getJsonChild(value, key) {
  if (Array.isArray(value)) return value[Number(key)];
  if (value !== null && typeof value === "object") return value[key];
  return undefined;
}

function isObjectLike(value) {
  return value !== null && typeof value === "object";
}

function jsonValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => jsonValuesEqual(item, right[index]));
  }
  if (isObjectLike(left) || isObjectLike(right)) {
    if (!isObjectLike(left) || !isObjectLike(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && jsonValuesEqual(left[key], right[key]));
  }
  return false;
}

function countDiffLeaves(value) {
  if (!isObjectLike(value)) return 1;
  const entries = getJsonEntries(value);
  if (!entries.length) return 1;
  return entries.reduce((total, [, childValue]) => total + countDiffLeaves(childValue), 0);
}

export function renderEmptyState(message, actionLabel, action) {
  return `
    <div class="wm-pipeline-empty">
      <p>${escapeHtml(message)}</p>
      <button type="button" data-action="${escapeAttribute(action)}">${escapeHtml(actionLabel)}</button>
    </div>
  `;
}

export function renderEmptyDetail(message) {
  return `
    <div class="wm-pipeline-empty-detail">
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

export function expandPreviewSteps(steps) {
  return steps.flatMap((step) => {
    if (step?.type !== "block" || step.block !== "memory.graphContext") return [step];
    const scratchPath = `$.blocks.${sanitizePreviewPathPart(step.name || step.block)}`;
    const inputPath = `${scratchPath}.input`;
    const outputPath = step.assign || "$.graphMemory";
    return [
      {
        name: `${step.name} / extract-memory-entities`,
        description: "Extract searchable long-term-memory entities from the current prompt.",
        type: "agent",
        agent: `${inputPath}.agent`,
        input: { pick: { prompt: `${inputPath}.prompt`, entityLimit: `${inputPath}.entityLimit` } },
        assign: `${scratchPath}.entityExtraction`,
        previewExpandedFrom: step.block,
      },
      {
        name: `${step.name} / search-graph-memory`,
        description: "Run parallel vector searches for the extracted entities.",
        type: "code",
        function: "memory.searchEntities",
        input: { pick: { prompt: `${inputPath}.prompt`, entities: `${scratchPath}.entityExtraction.entities` } },
        assign: `${scratchPath}.rawMatches`,
        previewExpandedFrom: step.block,
      },
      {
        name: `${step.name} / consolidate-graph-context`,
        description: "Consolidate graph memory matches into agent-consumable graphContext.",
        type: "code",
        function: "memory.consolidateGraphContext",
        assign: outputPath,
        previewExpandedFrom: step.block,
      },
    ];
  });
}

export function countSteps(definition) {
  return Array.isArray(definition.steps) ? expandPreviewSteps(definition.steps).length : 0;
}

function sanitizePreviewPathPart(value) {
  const sanitized = String(value).replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "block";
}
