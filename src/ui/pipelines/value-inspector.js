import {
  escapeHtml,
  renderJsonBlock,
} from "./view-utils.js";

const HUMAN_FIELD_LIMIT = 80;

export function serializeInspectionValue(value) {
  return encodeURIComponent(JSON.stringify(encodeInspectionValue(value)));
}

export function bindPipelineValueInspector(root) {
  root.querySelectorAll('[data-action="inspect-pipeline-value"]').forEach((button) => {
    button.addEventListener("click", () => {
      showPipelineValueInspector({
        title: button.dataset.valueTitle ?? "Value",
        encodedValue: button.dataset.value ?? "",
      });
    });
  });
}

function showPipelineValueInspector({ title, encodedValue }) {
  const existing = document.getElementById("pipeline-value-inspector");
  existing?.remove();

  const value = parseInspectionValue(encodedValue);
  const modal = document.createElement("dialog");
  modal.id = "pipeline-value-inspector";
  modal.className = "wm-pipeline-value-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "pipeline-value-inspector-title");
  modal.dataset.testid = "pipeline-value-inspector";
  modal.innerHTML = `
    <section class="wm-pipeline-value-modal-content">
      <div class="wm-pipeline-section-heading wm-pipeline-step-modal-header">
        <div>
          <h3 id="pipeline-value-inspector-title">${escapeHtml(title)}</h3>
          <p class="wm-muted">${escapeHtml(describeHumanValue(value))}</p>
        </div>
        <button type="button" class="wm-pipeline-step-close" data-action="close-pipeline-value-inspector" aria-label="Close value inspector" data-testid="pipeline-value-inspector-close">Close</button>
      </div>
      ${renderHumanInspectionValue(value)}
      <details class="wm-pipeline-raw-json">
        <summary>Raw JSON</summary>
        ${renderJsonBlock("Raw value", value)}
      </details>
    </section>
  `;

  const closeModal = () => {
    if (typeof modal.close === "function" && modal.open) {
      modal.close();
    } else {
      modal.remove();
    }
  };

  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target?.dataset?.action === "close-pipeline-value-inspector") {
      closeModal();
    }
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
  });
  modal.addEventListener("close", () => modal.remove(), { once: true });

  document.body.append(modal);
  if (typeof modal.showModal === "function") {
    try {
      modal.showModal();
    } catch {
      modal.setAttribute("open", "open");
    }
  } else if (typeof modal.show === "function") {
    modal.show();
  } else {
    modal.setAttribute("open", "open");
  }
  const closeButton = modal.querySelector('[data-action="close-pipeline-value-inspector"]');
  if (closeButton && typeof closeButton.focus === "function") {
    closeButton.focus({ preventScroll: true });
  }
}

function parseInspectionValue(encodedValue) {
  try {
    return decodeInspectionValue(JSON.parse(decodeURIComponent(encodedValue)));
  } catch {
    return null;
  }
}

function encodeInspectionValue(value) {
  if (value === undefined) return { __pipelineValueType: "undefined" };
  return { __pipelineValueType: "json", value };
}

function decodeInspectionValue(payload) {
  if (payload?.__pipelineValueType === "undefined") return undefined;
  if (payload?.__pipelineValueType === "json") return payload.value;
  return null;
}

export function renderHumanInspectionValue(value) {
  return renderHumanValue(value);
}

function renderHumanValue(value, label = "Value", depth = 0) {
  if (typeof value === "string") return renderHumanText(label, value, depth);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return renderHumanScalar(label, value, depth);
  }
  if (Array.isArray(value)) return renderHumanArray(label, value, depth);
  if (isObjectLike(value)) return renderHumanObject(value, depth);
  return renderHumanScalar(label, String(value), depth);
}

function renderHumanObject(value, depth = 0) {
  const entries = Object.entries(value);
  if (!entries.length) return `<p class="wm-pipeline-human-empty">No fields.</p>`;
  const visible = entries.slice(0, HUMAN_FIELD_LIMIT);
  const hidden = entries.slice(HUMAN_FIELD_LIMIT);
  return `
    <div class="wm-pipeline-human-fields" data-testid="pipeline-human-fields">
      ${visible.map(([key, child]) => renderHumanField(key, child, depth)).join("")}
      ${hidden.length ? `<p class="wm-muted">Showing ${visible.length} of ${entries.length} fields.</p>` : ""}
    </div>
  `;
}

function renderHumanField(key, value, depth) {
  const label = humanizeKey(key);
  if (typeof value === "string") return renderHumanText(label, value, depth);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return renderHumanScalar(label, value, depth);
  }
  if (Array.isArray(value)) {
    return renderExpandableHumanField(label, `${value.length} item${value.length === 1 ? "" : "s"}`, renderHumanArray(label, value, depth + 1));
  }
  if (isObjectLike(value)) {
    return renderExpandableHumanField(label, describeHumanValue(value), renderHumanObject(value, depth + 1));
  }
  return renderHumanScalar(label, String(value), depth);
}

function renderHumanText(label, value, depth) {
  const text = String(value ?? "");
  const paragraphs = splitParagraphs(text);
  return `
    <section class="wm-pipeline-human-field ${depth > 0 ? "wm-pipeline-human-field-nested" : ""}">
      <h4>${escapeHtml(label)}</h4>
      <div class="wm-pipeline-human-prose">
        ${paragraphs.length
          ? paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")
          : `<p class="wm-muted">Empty text</p>`}
      </div>
    </section>
  `;
}

function renderHumanScalar(label, value, depth) {
  return `
    <section class="wm-pipeline-human-field ${depth > 0 ? "wm-pipeline-human-field-nested" : ""}">
      <h4>${escapeHtml(label)}</h4>
      <p class="wm-pipeline-human-scalar">${escapeHtml(formatHumanScalar(value))}</p>
    </section>
  `;
}

function renderHumanArray(label, value, depth) {
  if (!value.length) return `<p class="wm-pipeline-human-empty">No items.</p>`;
  return `
    <div class="wm-pipeline-human-list" aria-label="${escapeHtml(label)} items">
      ${value.slice(0, HUMAN_FIELD_LIMIT).map((item, index) => `
        <section class="wm-pipeline-human-list-item">
          <h4>${escapeHtml(`${label} ${index + 1}`)}</h4>
          ${renderHumanValue(item, `Item ${index + 1}`, depth + 1)}
        </section>
      `).join("")}
      ${value.length > HUMAN_FIELD_LIMIT ? `<p class="wm-muted">Showing ${HUMAN_FIELD_LIMIT} of ${value.length} items.</p>` : ""}
    </div>
  `;
}

function renderExpandableHumanField(label, summary, content) {
  return `
    <details class="wm-pipeline-human-field wm-pipeline-human-expandable" open>
      <summary>
        <span>${escapeHtml(label)}</span>
        <small>${escapeHtml(summary)}</small>
      </summary>
      ${content}
    </details>
  `;
}

function splitParagraphs(value) {
  const normalized = String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return [];
  return normalized.split(/\n{2,}/).map((paragraph) => paragraph.replace(/\n/g, " ").trim()).filter(Boolean);
}

function humanizeKey(key) {
  const raw = String(key ?? "");
  if (!raw) return "Value";
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : "")
    .join(" ");
}

function formatHumanScalar(value) {
  if (value === undefined) return "Undefined";
  if (value === null) return "Null";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function describeHumanValue(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (isObjectLike(value)) {
    const count = Object.keys(value).length;
    return `${count} field${count === 1 ? "" : "s"}`;
  }
  if (typeof value === "string") return `${value.length} character${value.length === 1 ? "" : "s"}`;
  return formatHumanScalar(value);
}

function isObjectLike(value) {
  return value !== null && typeof value === "object";
}
