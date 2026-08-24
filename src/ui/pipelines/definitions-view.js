import { renderCreator, renderEditWizard } from "./launcher-view.js";
import {
  DEFINITION_FILTERS,
  collectTags,
  countSteps,
  escapeAttribute,
  escapeHtml,
  expandPreviewSteps,
  renderEmptyDetail,
  renderEmptyState,
  renderTagPills,
  statusLabel,
} from "./view-utils.js";

const DEFINITION_FIELD_ROW_LIMIT = 5;
const AGENT_PROMPT_MIN_ROWS = 5;
const AGENT_PROMPT_MAX_ROWS = 14;

export function getDefinitionFlowRows(step, direction) {
  const explicitRows = getDefinitionDisplayRows(step, direction);
  if (explicitRows.length) return explicitRows;
  return direction === "in"
    ? getDefinitionInputRows(step)
    : getDefinitionOutputRows(step);
}

function getDefinitionDisplayRows(step, direction) {
  const specs = step?.display?.[direction] ?? step?.metadata?.display?.[direction];
  if (!Array.isArray(specs)) return [];
  return specs
    .map((spec) => {
      if (!spec || typeof spec !== "object" || typeof spec.label !== "string") return null;
      const path = typeof spec.path === "string" && spec.path.trim()
        ? spec.path.trim()
        : "$";
      const source = typeof spec.source === "string" && spec.source.trim()
        ? `${spec.source.trim()}: `
        : "";
      return {
        name: spec.label,
        value: `${source}${displayPath(path) || "$"}`,
      };
    })
    .filter(Boolean);
}

function getDefinitionInputRows(step) {
  const input = step?.input;
  if (typeof input === "string" && input.trim()) {
    return [{ name: "Input", value: displayPath(input.trim()) }];
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    if (input.pick && typeof input.pick === "object" && !Array.isArray(input.pick)) {
      return Object.entries(input.pick).map(([label, path]) => ({
        name: toTitleLabel(label),
        value: displayPath(path),
      }));
    }
    if (input.value && typeof input.value === "object" && !Array.isArray(input.value)) {
      return Object.keys(input.value).map((key) => ({
        name: toTitleLabel(key),
        value: "literal",
      }));
    }
  }
  return [];
}

function getDefinitionOutputRows(step) {
  const rows = [];
  if (typeof step?.assign === "string" && step.assign.trim()) {
    rows.push({ name: "State", value: displayPath(step.assign.trim()) });
  }
  if (typeof step?.target === "string" && step.target.trim()) {
    rows.push({ name: "Loop Target", value: step.target.trim() });
  }
  if (typeof step?.function === "string" && step.function.trim()) {
    rows.push({ name: "Function", value: step.function.trim() });
  }
  if (typeof step?.block === "string" && step.block.trim()) {
    rows.push({ name: "Block", value: step.block.trim() });
  }
  if (typeof step?.agent === "string" && step.agent.trim()) {
    rows.push({ name: "Agent", value: step.agent.trim() });
  }
  return rows;
}

function displayPath(path) {
  return String(path ?? "").replace(/^\$\./, "").replace(/^\$/, "");
}

function toTitleLabel(value) {
  const words = String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!words) return "Field";
  return words.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderDefinitionFieldSet(label, rows) {
  return `
    <div class="wm-pipeline-flow-fieldset">
      <span>${escapeHtml(label)}</span>
      ${renderDefinitionFieldRows(rows, label)}
    </div>
  `;
}

function renderDefinitionFieldRows(rows, idPrefix) {
  if (!rows.length) return `<span class="wm-pipeline-flow-empty">No user-facing fields</span>`;
  const visible = rows.slice(0, DEFINITION_FIELD_ROW_LIMIT);
  const hidden = rows.slice(DEFINITION_FIELD_ROW_LIMIT);
  const safeId = String(idPrefix ?? "fields").replace(/[^a-zA-Z0-9_-]+/g, "-");
  return `
    <div class="wm-pipeline-flow-rows">
      ${visible.map(renderDefinitionFieldRow).join("")}
      ${hidden.length ? `
        <details class="wm-pipeline-flow-more">
          <summary aria-label="Show ${escapeAttribute(String(hidden.length))} more ${escapeAttribute(safeId)} fields">More (${escapeHtml(String(hidden.length))})</summary>
          <div class="wm-pipeline-flow-more-rows">
            ${hidden.map(renderDefinitionFieldRow).join("")}
          </div>
        </details>
      ` : ""}
    </div>
  `;
}

function renderDefinitionFieldRow(row) {
  return `
    <div class="wm-pipeline-flow-row">
      <code>${escapeHtml(row.name)}</code><span>${escapeHtml(row.value || "--")}</span>
    </div>
  `;
}

export function renderDefinitionsWorkspace(state, selected) {
  const definitions = getFilteredDefinitions(state);
  return `
    <section class="wm-pipeline-workspace wm-pipeline-definitions-workspace" aria-labelledby="pipeline-definitions-title">
      <div class="wm-pipeline-panel wm-pipeline-list-panel">
        <div class="wm-pipeline-panel-header">
          <div>
            <h2 id="pipeline-definitions-title">Definitions</h2>
            <p class="wm-muted">${state.definitions.length} definition${state.definitions.length === 1 ? "" : "s"} available</p>
          </div>
          <button type="button" data-action="open-creator" data-testid="pipeline-new-action">New Pipeline</button>
        </div>
        ${renderDefinitionControls(state)}
        ${definitions.length ? renderDefinitionList(state, definitions) : renderEmptyState("No pipeline definitions match this view.", "New Pipeline", "open-creator")}
      </div>
      <div class="wm-pipeline-panel wm-pipeline-detail-panel">
        ${state.creatorOpen ? renderCreator(state) : selected ? renderDefinitionDetail(state, selected) : renderEmptyDetail("Select a definition to preview, run, or create a new version.")}
      </div>
    </section>
  `;
}

export function renderDefinitionsListPage(state) {
  const definitions = getFilteredDefinitions(state);
  return `
    <section class="wm-pipeline-page-section wm-pipeline-definitions-page" aria-labelledby="pipeline-definitions-title">
      <div class="wm-pipeline-panel">
        <div class="wm-pipeline-panel-header">
          <div>
            <h2 id="pipeline-definitions-title">Definitions</h2>
            <p class="wm-muted">${state.definitions.length} definition${state.definitions.length === 1 ? "" : "s"} available</p>
          </div>
          <button type="button" data-action="open-creator" data-testid="pipeline-new-action">New Pipeline</button>
        </div>
        ${state.creatorOpen ? renderCreator(state) : ""}
        ${renderDefinitionControls(state)}
        ${definitions.length ? renderDefinitionList(state, definitions) : renderEmptyState("No pipeline definitions match this view.", "New Pipeline", "open-creator")}
      </div>
    </section>
  `;
}

export function renderDefinitionDetailPage(state, definition) {
  return `
    <section class="wm-pipeline-page-section wm-pipeline-definition-detail-page" aria-labelledby="pipeline-definition-detail-title">
      <div class="wm-pipeline-panel">
        <div>
          <button type="button" data-action="navigate-pipeline" data-path="/pipelines/definitions">Back to Definitions</button>
        </div>
        ${definition ? renderDefinitionDetail(state, definition) : renderMissingDefinition()}
      </div>
    </section>
  `;
}

function renderMissingDefinition() {
  return `
    <div class="wm-pipeline-empty-detail">
      <h2 id="pipeline-definition-detail-title">Definition Not Found</h2>
      <p>Pipeline definition not found.</p>
    </div>
  `;
}

function renderDefinitionControls(state) {
  const tags = collectTags(state.definitions);
  return `
    <div class="wm-pipeline-toolbar">
      <label>
        <span class="wm-sr-only">Search definitions</span>
        <input type="search" data-action="definition-search" value="${escapeAttribute(state.definitionSearch)}" placeholder="Search definitions" data-testid="pipeline-definition-search">
      </label>
      <div class="wm-pipeline-segmented" role="group" aria-label="Filter definitions">
        ${DEFINITION_FILTERS.map((filter) => `
          <button type="button" data-action="set-definition-filter" data-filter="${escapeAttribute(filter)}" aria-pressed="${state.definitionFilter === filter}">
            ${escapeHtml(statusLabel(filter))}
          </button>
        `).join("")}
      </div>
      <label class="wm-pipeline-filter-field">
        <span class="wm-sr-only">Filter definitions by tag</span>
        <select data-action="definition-tag-filter" data-testid="pipeline-definition-tag-filter" aria-label="Filter definitions by tag">
          <option value="">All tags</option>
          ${tags.map((tag) => `<option value="${escapeAttribute(tag)}" ${state.definitionTagFilter === tag ? "selected" : ""}>${escapeHtml(tag)}</option>`).join("")}
        </select>
      </label>
    </div>
  `;
}

function renderDefinitionList(state, definitions) {
  return `
    <div class="wm-pipeline-definition-list" data-testid="pipeline-definition-list">
      ${definitions.map((definition) => `
        <button type="button" class="wm-pipeline-definition-item" data-action="open-definition" data-id="${escapeAttribute(definition.id)}" aria-current="${state.selectedDefinitionId === definition.id}" data-testid="pipeline-definition-row">
          <span>
            <strong>${escapeHtml(definition.name)}</strong>
            <small>${escapeHtml(definition.description || "No description")}</small>
            ${renderTagPills(definition.tags)}
          </span>
          <span class="wm-pipeline-definition-meta">
            ${definition.default ? `<span>Default</span>` : ""}
            <span>${escapeHtml(definition.scope)}</span>
            <span>${escapeHtml(`${countSteps(definition)} steps`)}</span>
          </span>
        </button>
      `).join("")}
    </div>
  `;
}

function renderDefinitionDetail(state, definition) {
  return `
    <article class="wm-pipeline-definition-detail" data-testid="pipeline-definition-detail">
      <header class="wm-pipeline-detail-header">
        <div>
          <h2 id="pipeline-definition-detail-title">${escapeHtml(definition.name)}</h2>
          ${definition.description ? `<p>${escapeHtml(definition.description)}</p>` : `<p class="wm-muted">No description.</p>`}
          <p><code>${escapeHtml(definition.id)}</code></p>
          ${renderTagPills(definition.tags)}
        </div>
        <span class="wm-pipeline-status-chip" data-status="${escapeAttribute(definition.default ? "default" : definition.scope)}">${escapeHtml(definition.default ? "Default" : definition.scope)}</span>
      </header>
      <div class="wm-pipeline-definition-actions">
        <button type="button" data-action="open-launcher-for-definition" data-id="${escapeAttribute(definition.id)}" aria-label="Run pipeline definition">Run</button>
        <button type="button" data-action="open-manual-edit" data-id="${escapeAttribute(definition.id)}" aria-label="Manually edit pipeline definition" ${definition.scope !== "user" ? "disabled title='Shared definitions must be duplicated before editing'" : ""}>Manual Edit</button>
        <button type="button" data-action="open-edit-wizard" data-id="${escapeAttribute(definition.id)}" aria-label="Edit pipeline definition with wizard" ${definition.scope !== "user" ? "disabled title='Shared definitions must be duplicated before editing'" : ""}>Edit with Wizard</button>
      </div>
      ${definition.scope !== "user" ? `<p class="wm-muted">Shared definitions cannot be edited directly. Create a user-owned version before changing them.</p>` : ""}
      <dl class="wm-pipeline-facts">
        <div><dt>Version</dt><dd>${escapeHtml(definition.version ?? "--")}</dd></div>
        <div><dt>Default</dt><dd>${definition.default ? "Yes" : "No"}</dd></div>
        <div><dt>Tags</dt><dd>${escapeHtml((definition.tags ?? []).join(", ") || "--")}</dd></div>
        <div><dt>Steps</dt><dd>${countSteps(definition)}</dd></div>
        <div><dt>Scope</dt><dd>${escapeHtml(definition.scope)}</dd></div>
        <div><dt>Path</dt><dd><code>${escapeHtml(definition.path)}</code></dd></div>
      </dl>
      ${state.manualEditDefinitionId === definition.id ? renderManualEditPanel(state, definition) : ""}
      ${state.editDefinitionId === definition.id ? renderEditWizard(state, definition) : ""}
      <h3>Step Preview</h3>
      ${renderDefinitionFlow(definition)}
      <details>
        <summary>Default input</summary>
        <pre>${escapeHtml(JSON.stringify(definition.input ?? {}, null, 2))}</pre>
      </details>
    </article>
  `;
}

function renderManualEditPanel(state, definition) {
  const form = state.manualEditForm ?? {};
  return `
    <section class="wm-pipeline-creator wm-pipeline-edit-panel" aria-labelledby="pipeline-manual-edit-title" data-testid="pipeline-manual-edit-panel">
      <div class="wm-pipeline-section-heading">
        <div>
          <h3 id="pipeline-manual-edit-title">Manual Edit</h3>
          <p class="wm-muted">Saves a new versioned JSON declaration and leaves this file untouched.</p>
        </div>
        <button type="button" data-action="cancel-manual-edit" aria-label="Close manual edit panel">Close</button>
      </div>
      <label class="wm-pipeline-field">
        <span>Title</span>
        <input type="text" data-action="manual-edit-field" data-field="name" value="${escapeAttribute(form.name ?? definition.name)}" data-testid="pipeline-manual-edit-title-input" aria-label="Pipeline title">
      </label>
      <label class="wm-pipeline-field">
        <span>Description</span>
        <textarea data-action="manual-edit-field" data-field="description" rows="3" aria-label="Pipeline description">${escapeHtml(form.description ?? definition.description ?? "")}</textarea>
      </label>
      <label class="wm-pipeline-field">
        <span>Tags</span>
        <input type="text" data-action="manual-edit-field" data-field="tagsText" value="${escapeAttribute(form.tagsText ?? (definition.tags ?? []).join(", "))}" aria-label="Pipeline tags">
      </label>
      <label class="wm-pipeline-checkbox-field">
        <input type="checkbox" data-action="manual-edit-default" ${(form.default ?? definition.default) ? "checked" : ""} aria-label="Mark pipeline as default">
        <span>Mark as default pipeline</span>
      </label>
      <label class="wm-pipeline-field">
        <span>Default input JSON</span>
        <textarea data-action="manual-edit-field" data-field="inputText" rows="8" spellcheck="false" aria-label="Pipeline default input JSON">${escapeHtml(form.inputText ?? JSON.stringify(definition.input ?? {}, null, 2))}</textarea>
      </label>
      <label class="wm-pipeline-field">
        <span>Workflow steps JSON</span>
        <textarea data-action="manual-edit-field" data-field="stepsText" rows="12" spellcheck="false" aria-label="Pipeline workflow steps JSON">${escapeHtml(form.stepsText ?? JSON.stringify(definition.steps ?? [], null, 2))}</textarea>
      </label>
      ${renderManualAgentPromptEditors(form, definition)}
      <div class="wm-pipeline-launcher-actions">
        <button type="button" data-action="cancel-manual-edit" aria-label="Cancel manual edit">Cancel</button>
        <button type="button" data-action="save-manual-edit" data-id="${escapeAttribute(definition.id)}" aria-label="Save manual edit as next version" ${state.manualEditBusy ? "disabled" : ""}>
          ${state.manualEditBusy ? "Saving..." : "Save Next Version"}
        </button>
      </div>
      ${state.manualEditResult ? renderManualEditResult(state.manualEditResult) : ""}
    </section>
  `;
}

function renderManualAgentPromptEditors(form, definition) {
  const stepsText = form.stepsText ?? JSON.stringify(definition.steps ?? [], null, 2);
  const steps = parseStepsForPromptEditors(stepsText);
  if (!steps) {
    return `
      <section class="wm-pipeline-agent-prompts" aria-labelledby="pipeline-agent-prompts-title">
        <div>
          <h4 id="pipeline-agent-prompts-title">Agent Prompts</h4>
          <p class="wm-muted">Fix the workflow steps JSON to edit prompts individually.</p>
        </div>
      </section>
    `;
  }

  const agentSteps = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => isAgentDefinitionStep(step));

  if (!agentSteps.length) return "";

  return `
    <section class="wm-pipeline-agent-prompts" aria-labelledby="pipeline-agent-prompts-title" data-testid="pipeline-manual-agent-prompts">
      <div>
        <h4 id="pipeline-agent-prompts-title">Agent Prompts</h4>
        <p class="wm-muted">Edit the prompts used by agent steps. Saving creates the next pipeline version.</p>
      </div>
      ${agentSteps.map(({ step, index }) => `
        <label class="wm-pipeline-field wm-pipeline-agent-prompt-editor">
          <span>${escapeHtml(step.name || `Step ${index + 1}`)}</span>
          <textarea
            data-action="manual-edit-agent-prompt"
            data-step-index="${escapeAttribute(String(index))}"
            rows="${promptTextareaRows(step.prompt)}"
            spellcheck="true"
            aria-label="Agent prompt for ${escapeAttribute(step.name || `step ${index + 1}`)}"
          >${escapeHtml(getPromptTextForEditing(step.prompt))}</textarea>
        </label>
      `).join("")}
    </section>
  `;
}

function parseStepsForPromptEditors(stepsText) {
  try {
    const steps = JSON.parse(stepsText || "[]");
    return Array.isArray(steps) ? steps : null;
  } catch {
    return null;
  }
}

function renderManualEditResult(result) {
  return `
    <div class="wm-pipeline-wizard-result" role="status">
      <strong>Saved new version</strong>
      <p>Target <code>${escapeHtml(result.targetPath ?? "")}</code></p>
      ${result.sourcePath ? `<p>Source <code>${escapeHtml(result.sourcePath)}</code></p>` : ""}
    </div>
  `;
}

function renderDefinitionFlow(definition) {
  const steps = expandPreviewSteps(Array.isArray(definition.steps) ? definition.steps : []);
  if (!steps.length) return `<p class="wm-muted">No steps defined.</p>`;
  return `
    <div class="wm-pipeline-definition-flow">
      ${steps.map((step, index) => renderDefinitionStep(step, index, definition)).join("")}
    </div>
  `;
}

function renderDefinitionStep(step, index, definition) {
  const inputRows = getDefinitionFlowRows(step, "in");
  const outputRows = getDefinitionFlowRows(step, "out");
  return `
    <article class="wm-pipeline-definition-step ${step.previewExpandedFrom ? "wm-pipeline-definition-step-expanded" : ""}">
      <div>
        <span class="wm-pipeline-step-number">${index + 1}</span>
        <strong>${escapeHtml(step.name)}</strong>
        <small>${escapeHtml(step.type)}${step.block ? ` - ${escapeHtml(step.block)}` : ""}${step.function ? ` - ${escapeHtml(step.function)}` : ""}${step.agent ? ` - ${escapeHtml(step.agent)}` : ""}</small>
      </div>
      ${step.previewExpandedFrom ? `<p class="wm-muted">Expanded from <code>${escapeHtml(step.previewExpandedFrom)}</code></p>` : ""}
      ${step.description ? `<p>${escapeHtml(step.description)}</p>` : ""}
      ${step.target ? `<p class="wm-muted">Loops to <code>${escapeHtml(step.target)}</code>${step.iterations ? ` until <code>${escapeHtml(String(step.iterations))}</code> passes complete` : ""}</p>` : ""}
      ${step.assign ? `<p class="wm-muted">Assigns to <code>${escapeHtml(step.assign)}</code></p>` : ""}
      ${renderAgentPromptPreview(step, definition)}
      <div class="wm-pipeline-step-flow-grid">
        ${renderDefinitionFieldSet("Definitions In", inputRows)}
        ${renderDefinitionFieldSet("Activity Out", outputRows)}
      </div>
    </article>
  `;
}

function renderAgentPromptPreview(step, definition) {
  if (!isAgentDefinitionStep(step)) return "";

  const promptText = getPromptPreviewText(step.prompt);
  const editAction = definition?.scope === "user"
    ? `<button type="button" data-action="open-manual-edit" data-id="${escapeAttribute(definition.id)}" aria-label="Edit agent prompt for ${escapeAttribute(step.name || "pipeline step")}">Edit Prompt</button>`
    : `<span class="wm-muted">Create a user-owned version before editing.</span>`;

  return `
    <section class="wm-pipeline-agent-prompt-preview" aria-label="Agent prompt for ${escapeAttribute(step.name || "pipeline step")}" data-testid="pipeline-agent-prompt-preview">
      <div class="wm-pipeline-agent-prompt-header">
        <strong>Prompt</strong>
        ${editAction}
      </div>
      <textarea readonly rows="${promptTextareaRows(step.prompt)}" spellcheck="false" data-testid="pipeline-agent-prompt-text" aria-label="Agent prompt text">${escapeHtml(promptText)}</textarea>
    </section>
  `;
}

function isAgentDefinitionStep(step) {
  return step?.type === "agent" || Boolean(step?.agent);
}

function getPromptPreviewText(prompt) {
  if (typeof prompt === "string") {
    return prompt.trim() ? prompt : "No prompt defined for this agent step.";
  }
  if (prompt === undefined || prompt === null) return "No prompt defined for this agent step.";
  return JSON.stringify(prompt, null, 2);
}

function getPromptTextForEditing(prompt) {
  return typeof prompt === "string" ? prompt : "";
}

function promptTextareaRows(prompt) {
  const text = getPromptPreviewText(prompt);
  const lineCount = text.split(/\r\n|\r|\n/).length;
  const softWrapRows = Math.ceil(text.length / 110);
  return Math.max(AGENT_PROMPT_MIN_ROWS, Math.min(AGENT_PROMPT_MAX_ROWS, lineCount + softWrapRows));
}

function getFilteredDefinitions(state) {
  const query = state.definitionSearch.trim().toLowerCase();
  const tag = state.definitionTagFilter;
  return state.definitions.filter((definition) => {
    const scopeMatches = state.definitionFilter === "all"
      || (state.definitionFilter === "default" ? definition.default === true : definition.scope === state.definitionFilter);
    const tags = Array.isArray(definition.tags) ? definition.tags : [];
    const tagMatches = !tag || tags.includes(tag);
    const textMatches = !query || `${definition.name} ${definition.description ?? ""} ${definition.id} ${tags.join(" ")}`.toLowerCase().includes(query);
    return scopeMatches && tagMatches && textMatches;
  });
}
