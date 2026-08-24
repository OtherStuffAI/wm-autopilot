import {
  escapeAttribute,
  escapeHtml,
  formatBytes,
  statusLabel,
} from "./view-utils.js";
import {
  buildAssignedOutputRows,
  buildExplicitDisplayRows,
  buildFallbackDisplayRows,
  displayPath,
} from "./display-fields.js";
import { serializeInspectionValue } from "./value-inspector.js";

const FIELD_LIMIT = 40;
const FIELD_ROW_LIMIT = 5;
const LEDGER_LIMIT = 120;
const PREVIEW_LIMIT = 96;
const COMPOSITE_PREVIEW_LIMIT = 132;
const COMPOSITE_PREVIEW_FIELDS = 3;
const NESTED_PREVIEW_LIMIT = 44;

export function renderStepCardTimeline(state, run, steps, options = {}) {
  const sortedSteps = sortSteps(steps);
  return `
    <section class="wm-pipeline-flow-view" aria-label="Pipeline visual timeline" data-testid="pipeline-step-card-timeline">
      ${renderStateRail(run, sortedSteps)}
      <div class="wm-pipeline-step-card-list">
        ${sortedSteps.length
          ? sortedSteps.map((step) => renderStepCard(state, run, step, options)).join("")
          : `<p class="wm-muted">No steps recorded for this run.</p>`}
      </div>
    </section>
  `;
}

export function renderStateLedger(run, steps, options = {}) {
  const asOfStepIndex = typeof options.asOfStepIndex === "number" ? options.asOfStepIndex : null;
  const rows = buildStateLedgerRows(run, steps, asOfStepIndex);
  const title = options.title ?? "State Ledger";
  const description = asOfStepIndex === null ? "Current run state" : `State after step ${asOfStepIndex}`;
  return `
    <section class="wm-pipeline-state-ledger" aria-labelledby="${escapeAttribute(options.titleId ?? "pipeline-state-ledger-title")}" data-testid="pipeline-state-ledger">
      <div class="wm-pipeline-section-heading">
        <div>
          <h3 id="${escapeAttribute(options.titleId ?? "pipeline-state-ledger-title")}">${escapeHtml(title)}</h3>
          <p class="wm-muted">${escapeHtml(description)}</p>
        </div>
        <span class="wm-pipeline-ledger-count">${escapeHtml(`${rows.length} path${rows.length === 1 ? "" : "s"}`)}</span>
      </div>
      ${rows.length ? renderLedgerRows(rows) : `<div class="wm-pipeline-transform-empty">No state fields recorded.</div>`}
    </section>
  `;
}

export function buildStateLedgerRows(run, steps, asOfStepIndex = null) {
  const sortedSteps = sortSteps(steps).filter((step) => asOfStepIndex === null || Number(step.stepIndex) <= asOfStepIndex);
  let current = objectValue(run?.input);
  const writers = new Map();
  flattenLedgerFields(current).forEach((entry) => {
    writers.set(entry.path, {
      stepIndex: null,
      stepName: "Initial input",
      status: "input",
      previousValue: undefined,
    });
  });

  for (const step of sortedSteps) {
    if (!isObjectLike(step.result)) continue;
    const next = step.result;
    const changedPaths = collectChangedPaths(current, next);
    for (const changedPath of changedPaths) {
      writers.set(changedPath, {
        stepIndex: step.stepIndex,
        stepName: step.name,
        status: step.status,
        previousValue: getPathValue(current, changedPath),
      });
    }
    current = next;
  }

  return flattenLedgerFields(current)
    .map((entry) => ({
      ...entry,
      writer: writers.get(entry.path) ?? {
        stepIndex: null,
        stepName: "Initial input",
        status: "input",
        previousValue: undefined,
      },
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, LEDGER_LIMIT);
}

function renderStateRail(run, steps) {
  const initialFields = buildFallbackDisplayRows(run?.input);
  const latestState = resolveLatestState(run, steps);
  const currentFields = buildFallbackDisplayRows(latestState);
  return `
    <div class="wm-pipeline-state-rail" aria-label="Run data state over time" data-testid="pipeline-state-rail">
      <div>
        <strong>Initial State</strong>
        ${renderFieldRows(initialFields, "initial-state")}
      </div>
      <span aria-hidden="true" class="wm-pipeline-state-rail-arrow"></span>
      <div>
        <strong>Current State</strong>
        ${renderFieldRows(currentFields, "current-state")}
      </div>
    </div>
  `;
}

function renderStepCard(state, run, step, options) {
  const skipped = step.status === "skipped";
  const cleanAgentText = Boolean(options?.agentOutputFormattingEnabled && step.kind === "agent");
  const inputFields = skipped ? [] : getStepReadRows(step, { cleanAgentText });
  const writeFields = skipped ? [] : getStepWriteRows(run, state.selectedRun?.steps ?? [], step, { cleanAgentText });
  const dataSize = Number(step.inputBytes ?? 0) + Number(step.resultBytes ?? 0);
  const description = typeof step.metadata?.description === "string" ? step.metadata.description.trim() : "";
  return `
    <article
      class="wm-pipeline-step-card"
      aria-current="${state.selectedStep?.step?.id === step.id}"
      data-testid="pipeline-step-card"
    >
      <span class="wm-pipeline-step-number">${escapeHtml(String(step.stepIndex))}</span>
      <div class="wm-pipeline-step-card-body">
        <div class="wm-pipeline-step-card-header">
          <div>
            <strong>${escapeHtml(step.name)}</strong>
            <small>${escapeHtml(formatStepMeta(step, dataSize))}</small>
          </div>
          <div class="wm-pipeline-step-card-actions">
            <span class="wm-pipeline-status-chip" data-status="${escapeAttribute(step.status)}">${escapeHtml(statusLabel(step.status))}</span>
            <button
              type="button"
              data-action="select-step"
              data-run-id="${escapeAttribute(run.id)}"
              data-step-id="${escapeAttribute(step.id)}"
              aria-label="Inspect step ${escapeAttribute(step.stepIndex)} ${escapeAttribute(step.name)}"
              data-testid="pipeline-step-inspect"
            >
              Inspect
            </button>
          </div>
        </div>
        ${description ? `<p class="wm-pipeline-step-description">${escapeHtml(description)}</p>` : ""}
        <div class="wm-pipeline-step-flow-grid">
          ${renderFieldSet("Fields In", inputFields)}
          ${renderFieldSet("Fields Out", writeFields)}
        </div>
      </div>
    </article>
  `;
}

function renderFieldSet(label, rows) {
  return `
    <div class="wm-pipeline-flow-fieldset">
      <span>${escapeHtml(label)}</span>
      ${renderFieldRows(rows, label)}
    </div>
  `;
}

function renderFieldRows(rows, idPrefix) {
  if (!rows.length) return `<span class="wm-pipeline-flow-empty">No user-facing fields</span>`;
  const visible = rows.slice(0, FIELD_ROW_LIMIT);
  const hidden = rows.slice(FIELD_ROW_LIMIT);
  const safeId = String(idPrefix ?? "fields").replace(/[^a-zA-Z0-9_-]+/g, "-");
  return `
    <div class="wm-pipeline-flow-rows">
      ${visible.map((row) => renderFieldRow(row, idPrefix)).join("")}
      ${hidden.length ? `
        <details class="wm-pipeline-flow-more">
          <summary aria-label="Show ${escapeAttribute(String(hidden.length))} more ${escapeAttribute(safeId)} fields">More (${escapeHtml(String(hidden.length))})</summary>
          <div class="wm-pipeline-flow-more-rows">
            ${hidden.map((row) => renderFieldRow(row, idPrefix)).join("")}
          </div>
        </details>
      ` : ""}
    </div>
  `;
}

function renderFieldRow(row, contextLabel = "") {
  const inspectValue = Object.prototype.hasOwnProperty.call(Object(row), "inspectValue") ? row.inspectValue : row.value;
  const preview = formatDisplayPreviewValue(row.value, inspectValue);
  const title = [contextLabel, row.name].filter(Boolean).join(": ") || "Value";
  return `
    <div class="wm-pipeline-flow-row">
      <code>${escapeHtml(row.name)}</code><span>:
        <button
          type="button"
          class="wm-pipeline-value-preview"
          data-action="inspect-pipeline-value"
          data-value-title="${escapeAttribute(title)}"
          data-value="${escapeAttribute(serializeInspectionValue(inspectValue))}"
          aria-label="Inspect ${escapeAttribute(title)} value"
          data-testid="pipeline-value-preview"
        >&ldquo;${escapeHtml(preview)}&rdquo;</button>
      </span>
    </div>
  `;
}

function renderLedgerRows(rows) {
  const remaining = rows.length >= LEDGER_LIMIT ? `<p class="wm-muted">Showing first ${LEDGER_LIMIT} state paths.</p>` : "";
  return `
    <div class="wm-pipeline-ledger-table" role="table" aria-label="Pipeline state fields">
      <div class="wm-pipeline-ledger-row wm-pipeline-ledger-row-head" role="row">
        <span role="columnheader">Path</span>
        <span role="columnheader">Value</span>
        <span role="columnheader">Last Written</span>
      </div>
      ${rows.map(renderLedgerRow).join("")}
    </div>
    ${remaining}
  `;
}

function renderLedgerRow(row) {
  const writer = row.writer;
  const stepLabel = writer.stepIndex === null
    ? writer.stepName
    : `${writer.stepIndex}. ${writer.stepName}`;
  return `
    <div class="wm-pipeline-ledger-row" role="row" data-testid="pipeline-ledger-row">
      <code role="cell">${escapeHtml(row.path)}</code>
      <span role="cell">
        <button
          type="button"
          class="wm-pipeline-value-preview"
          data-action="inspect-pipeline-value"
          data-value-title="${escapeAttribute(row.path)}"
          data-value="${escapeAttribute(serializeInspectionValue(row.value))}"
          aria-label="Inspect ${escapeAttribute(row.path)} value"
          data-testid="pipeline-value-preview"
        >${escapeHtml(formatPreviewValue(row.value))}</button>
      </span>
      <span role="cell">
        <span>${escapeHtml(stepLabel)}</span>
        <small>${escapeHtml(statusLabel(writer.status))}</small>
      </span>
    </div>
  `;
}

function getStepWriteRows(run, steps, step, options = {}) {
  const explicitRows = buildExplicitDisplayRows(step, "out", options);
  if (explicitRows?.length) return explicitRows;
  const compactedRows = getCompactedDisplayRows(step, "out");
  if (compactedRows.length) return compactedRows;
  if (typeof step.metadata?.assign === "string" && step.metadata.assign.trim()) {
    return buildAssignedOutputRows(step.metadata.assign.trim(), getStepOutput(step));
  }
  const previous = resolveStateBeforeStep(run, steps, step);
  const next = isObjectLike(step.result) ? step.result : null;
  if (!next) return buildFallbackDisplayRows(getStepOutput(step));
  return collectChangedPaths(previous, next)
    .slice(0, FIELD_LIMIT)
    .map((path) => ({ name: displayPath(path), value: getPathValue(next, path) }));
}

function getStepReadRows(step, options = {}) {
  const explicitRows = buildExplicitDisplayRows(step, "in", options);
  if (explicitRows?.length) return explicitRows;
  const compactedRows = getCompactedDisplayRows(step, "in");
  if (compactedRows.length) return compactedRows;
  const selector = step.metadata?.input;
  if (typeof selector === "string" && selector.trim()) {
    const selectorName = displayPath(selector.trim());
    return buildFallbackDisplayRows(step.input, { prefix: selectorName });
  }
  if (isObjectLike(selector)) {
    if (isObjectLike(selector.pick)) {
      return buildFallbackDisplayRows(step.input);
    }
    if (isObjectLike(selector.value)) {
      return buildFallbackDisplayRows(selector.value);
    }
  }
  return buildFallbackDisplayRows(step.input);
}

function getCompactedDisplayRows(step, direction) {
  const rows = step?.metadata?.compactedDisplay?.[direction];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && typeof row === "object" && typeof row.name === "string")
    .slice(0, FIELD_LIMIT)
    .map((row) => ({ name: row.name, value: row.value }));
}

function resolveStateBeforeStep(run, steps, targetStep) {
  let current = objectValue(run?.input);
  for (const step of sortSteps(steps)) {
    if (Number(step.stepIndex) >= Number(targetStep.stepIndex)) break;
    if (isObjectLike(step.result)) current = step.result;
  }
  return current;
}

function resolveLatestState(run, steps) {
  let current = objectValue(run?.input);
  for (const step of sortSteps(steps)) {
    if (isObjectLike(step.result)) current = step.result;
  }
  if (isObjectLike(run?.current)) return run.current;
  if (isObjectLike(run?.result)) return run.result;
  return current;
}

function getStepOutput(step) {
  if (isObjectLike(step.output)) return step.output;
  if (isObjectLike(step.result)) return step.result;
  return {};
}

function formatStepMeta(step, dataSize) {
  const parts = [step.kind, getExecutorLabel(step)];
  if (step.wingmanSessionId) parts.push(step.wingmanSessionId.slice(0, 8));
  if (dataSize > 0) parts.push(formatBytes(dataSize));
  return parts.filter(Boolean).join(" - ");
}

function getExecutorLabel(step) {
  const executor = step.metadata?.executor;
  if (!isObjectLike(executor)) return "";
  if (typeof executor.function === "string") return executor.function;
  if (typeof executor.block === "string") return executor.block;
  if (typeof executor.agent === "string") return executor.agent;
  if (typeof executor.source === "string") return executor.source;
  if (typeof executor.target === "string") return `target ${executor.target}`;
  if (typeof executor.kind === "string") return executor.kind;
  return "";
}

function collectChangedPaths(previous, next, path = "$") {
  if (jsonValuesEqual(previous, next)) return [];
  if (Array.isArray(previous) || Array.isArray(next)) return [path];
  if (!isObjectLike(previous) && isObjectLike(next)) {
    return flattenLedgerFields(next, path).map((entry) => entry.path);
  }
  if (isObjectLike(previous) && isObjectLike(next)) {
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    const paths = [];
    for (const key of keys) {
      paths.push(...collectChangedPaths(previous[key], next[key], `${path}.${key}`));
    }
    return paths.length ? paths : [path];
  }
  return [path];
}

function flattenLedgerFields(value, path = "$") {
  if (!isObjectLike(value) || Array.isArray(value)) {
    return [{ path, value }];
  }
  const entries = Object.entries(value);
  if (!entries.length) return [{ path, value }];
  return entries.flatMap(([key, child]) => flattenLedgerFields(child, `${path}.${key}`));
}

function getPathValue(value, path) {
  const parts = path.replace(/^\$\./, "").split(".").filter(Boolean);
  if (path === "$" || parts.length === 0) return value;
  let cursor = value;
  for (const part of parts) {
    if (!isObjectLike(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function formatPreviewValue(value) {
  if (Array.isArray(value)) return formatArrayPreview(value);
  if (isObjectLike(value)) return formatObjectPreview(value);
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > PREVIEW_LIMIT ? `${compact.slice(0, PREVIEW_LIMIT - 3)}...` : compact;
  }
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function formatDisplayPreviewValue(displayValue, inspectValue) {
  if (isCompositeValue(inspectValue)) return formatPreviewValue(inspectValue);
  return formatPreviewValue(displayValue);
}

function formatObjectPreview(value) {
  const entries = Object.entries(value);
  if (!entries.length) return "0 fields";
  const preview = entries
    .slice(0, COMPOSITE_PREVIEW_FIELDS)
    .map(([key, child]) => `${humanizePreviewKey(key)}: ${formatNestedPreviewValue(child)}`)
    .join("; ");
  const suffix = entries.length > COMPOSITE_PREVIEW_FIELDS ? `; +${entries.length - COMPOSITE_PREVIEW_FIELDS} more` : "";
  return trimPreview(`${preview}${suffix}`, COMPOSITE_PREVIEW_LIMIT);
}

function formatArrayPreview(value) {
  if (!value.length) return "0 items";
  const primitiveItems = value.filter((item) => !isCompositeValue(item));
  if (primitiveItems.length === value.length) {
    return trimPreview(value.slice(0, COMPOSITE_PREVIEW_FIELDS).map(formatNestedPreviewValue).join(", "), COMPOSITE_PREVIEW_LIMIT);
  }
  const sample = value.slice(0, COMPOSITE_PREVIEW_FIELDS)
    .map((item, index) => `${index + 1}: ${formatNestedPreviewValue(item)}`)
    .join("; ");
  const suffix = value.length > COMPOSITE_PREVIEW_FIELDS ? `; +${value.length - COMPOSITE_PREVIEW_FIELDS} more` : "";
  return trimPreview(`${sample}${suffix}`, COMPOSITE_PREVIEW_LIMIT);
}

function formatNestedPreviewValue(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (isObjectLike(value)) return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? "" : "s"}`;
  if (typeof value === "string") return trimPreview(value.replace(/\s+/g, " ").trim(), NESTED_PREVIEW_LIMIT);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "True" : "False";
  return trimPreview(String(value), NESTED_PREVIEW_LIMIT);
}

function humanizePreviewKey(key) {
  return String(key ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function trimPreview(value, limit) {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 3))}...`;
}

function isCompositeValue(value) {
  return Array.isArray(value) || isObjectLike(value);
}

function sortSteps(steps) {
  return [...(Array.isArray(steps) ? steps : [])].sort((left, right) => Number(left.stepIndex ?? 0) - Number(right.stepIndex ?? 0));
}

function objectValue(value) {
  return isObjectLike(value) && !Array.isArray(value) ? value : {};
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
