import {
  RUN_FILTERS,
  collectTags,
  escapeAttribute,
  escapeHtml,
  formatDateTime,
  formatDuration,
  formatRunMeta,
  renderEmptyDetail,
  renderEmptyState,
  renderJsonBlock,
  renderJsonTransformBlock,
  renderTagPills,
  statusLabel,
} from "./view-utils.js";
import { hasRunPayload } from "./state.js";
import { renderStateLedger, renderStepCardTimeline } from "./run-flow-view.js";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

export function renderRunsWorkspace(state) {
  const runs = getFilteredRuns(state);
  return `
    <section class="wm-pipeline-workspace wm-pipeline-runs-workspace" aria-labelledby="pipeline-runs-title">
      <div class="wm-pipeline-panel wm-pipeline-list-panel">
        <div class="wm-pipeline-panel-header">
          <div>
            <h2 id="pipeline-runs-title">Previous Runs</h2>
            <p class="wm-muted">${state.runs.length} run${state.runs.length === 1 ? "" : "s"} recorded</p>
          </div>
        </div>
        ${renderRunControls(state)}
        ${runs.length ? renderRunList(state, runs) : renderEmptyState("No pipeline runs match this view.", "Run Pipeline", "open-launcher")}
      </div>
      <div class="wm-pipeline-panel wm-pipeline-detail-panel">
        ${state.selectedRun ? renderRunDetail(state) : renderEmptyDetail("Select a run to inspect its timeline, input, result, events, and callbacks.")}
      </div>
    </section>
  `;
}

export function renderRunsListPage(state) {
  const runs = getFilteredRuns(state);
  return `
    <section class="wm-pipeline-page-section wm-pipeline-runs-page" aria-labelledby="pipeline-runs-title">
      <div class="wm-pipeline-panel">
        <div class="wm-pipeline-panel-header">
          <div>
            <h2 id="pipeline-runs-title">Previous Runs</h2>
            <p class="wm-muted">${state.runs.length} run${state.runs.length === 1 ? "" : "s"} recorded</p>
          </div>
        </div>
        ${renderRunControls(state)}
        ${runs.length ? renderRunList(state, runs) : renderEmptyState("No pipeline runs match this view.", "Run Pipeline", "open-launcher")}
      </div>
    </section>
  `;
}

export function renderRunDetailPage(state, runId) {
  const loadedRunId = state.selectedRun?.run?.id ?? "";
  const detail = loadedRunId && loadedRunId === runId
    ? renderRunDetail(state)
    : `<div class="wm-pipeline-empty-detail"><h2 id="pipeline-run-detail-title">Loading Run</h2><p>Loading pipeline run...</p></div>`;
  return `
    <section class="wm-pipeline-page-section wm-pipeline-run-detail-page" aria-labelledby="pipeline-run-detail-title">
      <div class="wm-pipeline-panel">
        <div>
          <button type="button" data-action="navigate-pipeline" data-path="/pipelines/runs">Back to Runs</button>
        </div>
        ${detail}
      </div>
    </section>
  `;
}

function renderRunControls(state) {
  const tags = collectTags(state.runs);
  return `
    <div class="wm-pipeline-toolbar">
      <label>
        <span class="wm-sr-only">Search runs</span>
        <input type="search" data-action="run-search" value="${escapeAttribute(state.runSearch)}" placeholder="Search runs" data-testid="pipeline-run-search">
      </label>
      <div class="wm-pipeline-segmented" role="group" aria-label="Filter runs">
        ${RUN_FILTERS.map((filter) => `
          <button type="button" data-action="set-run-filter" data-filter="${escapeAttribute(filter)}" aria-pressed="${state.runFilter === filter}">
            ${escapeHtml(statusLabel(filter))}
          </button>
        `).join("")}
      </div>
      <label class="wm-pipeline-filter-field">
        <span class="wm-sr-only">Filter runs by tag</span>
        <select data-action="run-tag-filter" data-testid="pipeline-run-tag-filter" aria-label="Filter runs by tag">
          <option value="">All tags</option>
          ${tags.map((tag) => `<option value="${escapeAttribute(tag)}" ${state.runTagFilter === tag ? "selected" : ""}>${escapeHtml(tag)}</option>`).join("")}
        </select>
      </label>
    </div>
  `;
}

function renderRunList(state, runs) {
  return `
    <div class="wm-pipeline-run-list" data-testid="pipeline-run-list">
      ${runs.map((run) => `
        <button type="button" class="wm-pipeline-run-item" data-action="open-run" data-id="${escapeAttribute(run.id)}" aria-current="${state.selectedRun?.run?.id === run.id}" data-testid="pipeline-run-row">
          <span class="wm-pipeline-status-chip" data-status="${escapeAttribute(run.status)}">${escapeHtml(statusLabel(run.status))}</span>
          <span class="wm-pipeline-run-main">
            <strong>${escapeHtml(run.name)}</strong>
            <small>${escapeHtml(formatRunMeta(run))}</small>
            ${renderTagPills(run.tags)}
          </span>
          <code>${escapeHtml(run.id.slice(0, 8))}</code>
        </button>
      `).join("")}
    </div>
  `;
}

function renderRunDetail(state) {
  const run = state.selectedRun.run;
  const steps = state.selectedRun.steps ?? [];
  const isErrored = run.status === "error";
  const isResuming = state.resumingRunId === run.id;
  const isActive = ACTIVE_RUN_STATUSES.has(String(run.status ?? ""));
  const isCancelling = state.cancellingRunId === run.id;
  return `
    <article class="wm-pipeline-run-detail" data-testid="pipeline-run-detail">
      <header class="wm-pipeline-detail-header">
        <div>
          <h2 id="pipeline-run-detail-title">${escapeHtml(run.name)}</h2>
          <p><code>${escapeHtml(run.id)}</code></p>
          ${renderTagPills(run.tags)}
        </div>
        <div class="wm-pipeline-run-actions">
          ${isActive ? `
            <button
              type="button"
              data-action="cancel-run"
              data-id="${escapeAttribute(run.id)}"
              data-testid="pipeline-cancel-run-action"
              aria-label="Stop pipeline run ${escapeAttribute(run.name ?? run.id)}"
              ${isCancelling ? "disabled" : ""}
            >
              ${isCancelling ? "Stopping..." : "Stop Run"}
            </button>
          ` : ""}
          ${isErrored ? `
            <button
              type="button"
              data-action="resume-run-from-failure"
              data-id="${escapeAttribute(run.id)}"
              data-testid="pipeline-resume-run-action"
              ${isResuming ? "disabled" : ""}
            >
              ${isResuming ? "Resuming..." : "Resume from Failed Step"}
            </button>
          ` : ""}
          <span class="wm-pipeline-status-chip" data-status="${escapeAttribute(run.status)}">${escapeHtml(statusLabel(run.status))}</span>
        </div>
      </header>
      <dl class="wm-pipeline-facts">
        <div><dt>Started</dt><dd>${escapeHtml(formatDateTime(run.startedAt ?? run.started_at))}</dd></div>
        <div><dt>Completed</dt><dd>${escapeHtml(formatDateTime(run.completedAt ?? run.completed_at))}</dd></div>
        <div><dt>Duration</dt><dd>${escapeHtml(formatDuration(run.startedAt ?? run.started_at, run.completedAt ?? run.completed_at))}</dd></div>
        <div><dt>Definition</dt><dd>${escapeHtml(run.definitionSlug ?? run.definitionId ?? "--")}</dd></div>
        <div><dt>Default</dt><dd>${run.definitionDefault ? "Yes" : "No"}</dd></div>
        <div><dt>Tags</dt><dd>${escapeHtml((run.tags ?? []).join(", ") || "--")}</dd></div>
        <div><dt>Steps</dt><dd>${steps.length}</dd></div>
      </dl>
      <div class="wm-pipeline-detail-tabs" role="tablist" aria-label="Run detail">
        ${["overview", "ledger", "input", "result"].map((tab) => `
          <button type="button" data-action="set-run-tab" data-tab="${tab}" role="tab" aria-selected="${state.selectedRunTab === tab}">
            ${escapeHtml(tab === "ledger" ? "State Ledger" : tab[0].toUpperCase() + tab.slice(1))}
          </button>
        `).join("")}
      </div>
      ${renderSelectedRunTab(state, run, steps)}
    </article>
  `;
}

function renderSelectedRunTab(state, run, steps) {
  if (state.selectedRunTab === "input") {
    if (!hasRunPayload(run)) return renderRunPayloadState(state, "input");
    return renderJsonBlock("Input", run.input);
  }
  if (state.selectedRunTab === "result") {
    if (!hasRunPayload(run)) return renderRunPayloadState(state, "result");
    return renderJsonBlock("Result", run.result ?? run.error ?? {});
  }
  if (state.selectedRunTab === "ledger") {
    return renderStateLedger(run, steps);
  }
  return `
    ${renderStepCardTimeline(state, run, steps, {
      agentOutputFormattingEnabled: Boolean(state.agentOutputFormattingEnabled),
    })}
    ${state.selectedStep ? renderStepDetailModal(state) : ""}
  `;
}

function renderRunPayloadState(state, tab) {
  if (state.selectedRunPayloadError) {
    return `<p class="wm-error" role="alert">${escapeHtml(state.selectedRunPayloadError)}</p>`;
  }
  return `
    <div class="wm-pipeline-empty-detail" aria-live="polite">
      <p>${state.selectedRunPayloadLoading ? `Loading run ${tab}...` : `Select ${escapeHtml(tab)} again to load run data.`}</p>
    </div>
  `;
}

function renderStepDetailModal(state) {
  return `
    <div class="wm-pipeline-step-modal" role="dialog" aria-modal="true" aria-labelledby="pipeline-step-modal-title" data-testid="pipeline-step-modal">
      <section class="wm-pipeline-step-modal-content">
        ${renderStepDetail(state)}
      </section>
    </div>
  `;
}

export function renderStepDetail(state) {
  const { step, events = [], callbacks = [], previousSteps = [] } = state.selectedStep;
  const run = state.selectedRun?.run ?? { input: {} };
  const runSteps = state.selectedRun?.steps ?? [];
  const rawOutput = step.output ?? step.result ?? {};
  return `
    <section class="wm-pipeline-step-detail" data-testid="pipeline-step-detail">
      <div class="wm-pipeline-section-heading wm-pipeline-step-modal-header">
        <div>
          <h3 id="pipeline-step-modal-title">${escapeHtml(step.name)}</h3>
          <p><code>${escapeHtml(step.id)}</code>${step.wingmanSessionId ? ` agent session <code>${escapeHtml(step.wingmanSessionId)}</code>` : ""}</p>
        </div>
        <div class="wm-pipeline-step-actions">
          ${renderAgentSessionLink(step)}
          <span class="wm-pipeline-status-chip" data-status="${escapeAttribute(step.status)}">${escapeHtml(statusLabel(step.status))}</span>
          <button type="button" class="wm-pipeline-step-close" data-action="close-step-detail" aria-label="Close step detail" data-testid="pipeline-step-detail-close">Close</button>
        </div>
      </div>
      ${renderJsonTransformBlock(step.input, rawOutput, {
        cleanAgentText: Boolean(state.agentOutputFormattingEnabled && step.kind === "agent"),
      })}
      <div class="wm-pipeline-step-secondary" aria-label="Step source data and diagnostics">
        ${renderCollapsedJsonBlock("Input", step.input)}
        ${renderCollapsedJsonBlock("Raw output", rawOutput)}
        ${renderCollapsedJsonBlock("State after step", step.result)}
        ${renderStateLedger(run, runSteps, {
          asOfStepIndex: Number(step.stepIndex),
          title: "State Ledger at Step",
          titleId: "pipeline-step-ledger-title",
        })}
        ${renderStepDetailSection("Previous steps", previousSteps.map((entry) => ({
          stepIndex: entry.stepIndex,
          name: entry.name,
          kind: entry.kind,
          status: entry.status,
          wingmanSessionId: entry.wingmanSessionId,
          inputBytes: entry.inputBytes,
          resultBytes: entry.resultBytes,
          completedAt: entry.completedAt,
        })))}
        ${renderStepDetailSection("Events", events)}
        ${renderStepDetailSection("Callbacks", callbacks)}
      </div>
    </section>
  `;
}

function renderAgentSessionLink(step) {
  if (!step.wingmanSessionId) return "";
  const sessionId = step.wingmanSessionId;
  return `
    <a
      class="wm-pipeline-agent-session-link"
      href="/live/${encodeURIComponent(sessionId)}"
      aria-label="Open agent session ${escapeAttribute(sessionId)}"
      title="Open agent session ${escapeAttribute(sessionId)}"
      data-testid="pipeline-agent-session-link"
    >
      Open session <code>${escapeHtml(sessionId.slice(0, 8))}</code>
    </a>
  `;
}

function renderStepDetailSection(title, value) {
  return `
    <details>
      <summary>${escapeHtml(title)}</summary>
      <pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>
    </details>
  `;
}

function renderCollapsedJsonBlock(title, value) {
  return `
    <details class="wm-pipeline-step-data-panel">
      <summary>${escapeHtml(title)}</summary>
      ${renderJsonBlock(title, value)}
    </details>
  `;
}

function getFilteredRuns(state) {
  const query = state.runSearch.trim().toLowerCase();
  const tag = state.runTagFilter;
  return state.runs.filter((run) => {
    const statusMatches = state.runFilter === "all"
      || (state.runFilter === "default" ? run.definitionDefault === true : run.status === state.runFilter);
    const tags = Array.isArray(run.tags) ? run.tags : [];
    const tagMatches = !tag || tags.includes(tag);
    const textMatches = !query || `${run.name} ${run.id} ${run.status} ${run.definitionSlug ?? ""} ${tags.join(" ")}`.toLowerCase().includes(query);
    return statusMatches && tagMatches && textMatches;
  });
}
