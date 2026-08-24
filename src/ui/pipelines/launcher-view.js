import { escapeAttribute, escapeHtml } from "./view-utils.js";

export function renderRunLauncher(state, selected) {
  if (state.definitions.length === 0) {
    return `
      <section class="wm-pipeline-launcher" aria-labelledby="pipeline-run-launcher-title" data-testid="pipeline-run-launcher">
        <div class="wm-pipeline-section-heading">
          <div>
            <h2 id="pipeline-run-launcher-title">Run Pipeline</h2>
            <p class="wm-muted">No pipeline definitions found. Create one before starting a run.</p>
          </div>
          <button type="button" data-action="close-launcher">Close</button>
        </div>
      </section>
    `;
  }

  return `
    <section class="wm-pipeline-launcher" aria-labelledby="pipeline-run-launcher-title" data-testid="pipeline-run-launcher">
      <div class="wm-pipeline-section-heading">
        <div>
          <h2 id="pipeline-run-launcher-title">Run Pipeline</h2>
          <p class="wm-muted">Select a definition, review the input object, and start a new run.</p>
        </div>
        <button type="button" data-action="close-launcher">Close</button>
      </div>
      <label class="wm-pipeline-field">
        <span>Definition</span>
        <select data-action="select-launcher-definition">
          ${state.definitions.map((definition) => `
            <option value="${escapeAttribute(definition.id)}" ${definition.id === selected?.id ? "selected" : ""}>
              ${escapeHtml(definition.name)}
            </option>
          `).join("")}
        </select>
      </label>
      <label class="wm-pipeline-field">
        <span>Run input JSON</span>
        <textarea data-action="run-input" rows="8" spellcheck="false">${escapeHtml(state.runInputText)}</textarea>
      </label>
      <div class="wm-pipeline-launcher-actions">
        <button type="button" data-action="close-launcher">Cancel</button>
        <button type="button" data-action="run-selected-definition" ${state.runningId ? "disabled" : ""}>
          ${state.runningId ? "Running..." : "Start Run"}
        </button>
      </div>
    </section>
  `;
}

export function renderCreator(state) {
  return `
    <section class="wm-pipeline-creator" aria-labelledby="pipeline-creator-title" data-testid="pipeline-creator">
      <div class="wm-pipeline-section-heading">
        <div>
          <h2 id="pipeline-creator-title">New Pipeline</h2>
          <p class="wm-muted">Describe the workflow and Wingman will start a wizard session to create the JSON declaration.</p>
        </div>
        <button type="button" data-action="close-creator">Close</button>
      </div>
      <label class="wm-pipeline-field">
        <span>Pipeline description</span>
        <textarea data-action="wizard-prompt" rows="7" placeholder="Example: Split a document into paragraphs, ask an agent to analyse paragraph two, then return a structured summary.">${escapeHtml(state.wizardPrompt)}</textarea>
      </label>
      <div class="wm-pipeline-launcher-actions">
        <button type="button" data-action="start-wizard" ${state.wizardBusy ? "disabled" : ""}>
          ${state.wizardBusy ? "Starting..." : "Generate Pipeline"}
        </button>
      </div>
      ${state.wizardResult ? renderWizardResult(state.wizardResult) : ""}
    </section>
  `;
}

export function renderEditWizard(state, definition) {
  return `
    <section class="wm-pipeline-creator wm-pipeline-edit-panel" aria-labelledby="pipeline-edit-title">
      <div class="wm-pipeline-section-heading">
        <div>
          <h3 id="pipeline-edit-title">Edit with Wizard</h3>
          <p class="wm-muted">Creates the next version JSON file and leaves the current declaration untouched.</p>
        </div>
        <button type="button" data-action="cancel-edit-wizard">Close</button>
      </div>
      <label class="wm-pipeline-field">
        <span>What should change?</span>
        <textarea data-action="edit-prompt" rows="5" placeholder="Describe what is incorrect or what should be adjusted.">${escapeHtml(state.editPrompt)}</textarea>
      </label>
      <div class="wm-pipeline-launcher-actions">
        <button type="button" data-action="start-edit-wizard" data-id="${escapeAttribute(definition.id)}" ${state.editBusy ? "disabled" : ""}>
          ${state.editBusy ? "Starting..." : "Create Next Version"}
        </button>
      </div>
      ${state.editResult ? renderWizardResult(state.editResult) : ""}
    </section>
  `;
}

function renderWizardResult(result) {
  return `
    <div class="wm-pipeline-wizard-result" role="status">
      <strong>Wizard session started</strong>
      <p>Session <code>${escapeHtml(result.session?.id ?? "")}</code></p>
      <p>Target <code>${escapeHtml(result.targetPath ?? "")}</code></p>
      ${result.sourcePath ? `<p>Source <code>${escapeHtml(result.sourcePath)}</code></p>` : ""}
    </div>
  `;
}
