import {
  escapeHtml,
  escapeAttribute,
  formatDateTime,
  formatDuration,
  formatRunMeta,
  renderJsonBlock,
  statusLabel,
} from "./view-utils.js";
import { renderStepCardTimeline } from "./run-flow-view.js";
import { renderStepDetail } from "./runs-view.js";
import { getDefinitionFlowRows } from "./definitions-view.js";
import { bindPipelineValueInspector } from "./value-inspector.js";

const ACTIVE_PIPELINE_RUN_STATUSES = new Set(["queued", "running"]);
const RECENT_PIPELINE_RUN_PAGE_SIZE = 5;

export function isActivePipelineRun(run) {
  return ACTIVE_PIPELINE_RUN_STATUSES.has(String(run?.status ?? ""));
}

export function getActivePipelineRuns(runs) {
  return Array.isArray(runs) ? runs.filter((run) => isActivePipelineRun(run)) : [];
}

export function getRecentPipelineRunPage(runs, page = 0, pageSize = RECENT_PIPELINE_RUN_PAGE_SIZE) {
  const source = Array.isArray(runs) ? runs : [];
  const safePageSize = Math.max(1, Number(pageSize) || RECENT_PIPELINE_RUN_PAGE_SIZE);
  const safePage = Math.max(0, Number(page) || 0);
  const start = safePage * safePageSize;
  return source.slice(start, start + safePageSize);
}

export function getRecentPipelineRunPageCount(runs, pageSize = RECENT_PIPELINE_RUN_PAGE_SIZE) {
  const total = Array.isArray(runs) ? runs.length : 0;
  const safePageSize = Math.max(1, Number(pageSize) || RECENT_PIPELINE_RUN_PAGE_SIZE);
  return Math.max(1, Math.ceil(total / safePageSize));
}

export function getPipelineRunDisplayName(run) {
  const name = typeof run?.name === "string" ? run.name.trim() : "";
  if (name.length > 0) return name;
  return String(run?.id ?? "Pipeline run");
}

export function buildPipelineRunDetailFetchOptions({ forceFresh = false } = {}) {
  return {
    includeRunPayload: false,
    includeStepPayload: true,
    forceFresh,
  };
}

export function getPipelineStepSessionId(step) {
  const sessionId = typeof step?.wingmanSessionId === "string" ? step.wingmanSessionId.trim() : "";
  return sessionId.length > 0 ? sessionId : null;
}

export function renderRunningPipelineAgentSessionLink(step) {
  const sessionId = getPipelineStepSessionId(step);
  if (!sessionId) return "";
  return `
    <a
      class="wm-pipeline-agent-session-link"
      href="/live/${encodeURIComponent(sessionId)}"
      aria-label="Open agent session ${escapeAttribute(sessionId)}"
      title="Open agent session ${escapeAttribute(sessionId)}"
      data-testid="running-pipeline-agent-session-link"
    >
      Open session <code>${escapeHtml(sessionId.slice(0, 8))}</code>
    </a>
  `;
}

export function renderRunningPipelineStepTimeline(run, steps, selectedStepDetail = null, options = {}) {
  const selectedRun = { run, steps };
  const renderState = {
    selectedRun,
    selectedStep: selectedStepDetail,
    agentOutputFormattingEnabled: Boolean(options.agentOutputFormattingEnabled),
  };
  return `
    ${renderStepCardTimeline(renderState, run, steps, {
      agentOutputFormattingEnabled: renderState.agentOutputFormattingEnabled,
    })}
    ${selectedStepDetail ? renderRunningPipelineStepDetailModal(selectedRun, selectedStepDetail, renderState) : ""}
  `;
}

function renderRunningPipelineStepDetailModal(selectedRun, selectedStepDetail, renderState = {}) {
  return `
    <div class="wm-pipeline-step-modal" role="dialog" aria-modal="true" aria-labelledby="pipeline-step-modal-title" data-testid="running-pipeline-step-modal">
      <section class="wm-pipeline-step-modal-content">
        ${renderStepDetail({
          selectedRun,
          selectedStep: selectedStepDetail,
          agentOutputFormattingEnabled: Boolean(renderState.agentOutputFormattingEnabled),
        })}
      </section>
    </div>
  `;
}

async function fetchPipelineRunDetail(runId, options) {
  const { fetchPipelineRun } = await import("./api.js");
  return fetchPipelineRun(runId, options);
}

async function fetchPipelineStepDetail(runId, stepId) {
  const { fetchPipelineStep } = await import("./api.js");
  return fetchPipelineStep(runId, stepId);
}

async function fetchPipelineRunSummaries() {
  const { fetchPipelineRuns } = await import("./api.js");
  return fetchPipelineRuns({ includeDefinitionMeta: false });
}

async function fetchPipelineDefinitionSummaries() {
  const { fetchPipelineDefinitions } = await import("./api.js");
  return fetchPipelineDefinitions();
}

async function startPipelineRun(definitionId, input) {
  const { runPipelineDefinition } = await import("./api.js");
  return runPipelineDefinition(definitionId, input);
}

async function stopPipelineRun(runId) {
  const { cancelPipelineRun } = await import("./api.js");
  return cancelPipelineRun(runId);
}

export function showRunningPipelinesModal({ showToast, agentOutputFormattingEnabled = false } = {}) {
  const existing = document.getElementById("running-pipelines-modal");
  if (typeof HTMLDialogElement === "function" && existing instanceof HTMLDialogElement && existing.open) {
    existing.close();
    existing.remove();
  } else {
    existing?.remove();
  }

  const dialog = document.createElement("dialog");
  dialog.id = "running-pipelines-modal";
  dialog.className = "wm-running-pipelines-modal";
  dialog.dataset.testid = "running-pipelines-modal";
  dialog.setAttribute("aria-labelledby", "running-pipelines-modal-title");

  const shell = document.createElement("div");
  shell.className = "wm-running-pipelines-modal__shell";

  const header = document.createElement("header");
  header.className = "wm-running-pipelines-modal__header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "wm-running-pipelines-modal__title";
  const title = document.createElement("h2");
  title.id = "running-pipelines-modal-title";
  title.textContent = "Running Pipelines";
  const subtitle = document.createElement("p");
  subtitle.setAttribute("aria-live", "polite");
  titleWrap.append(title, subtitle);

  const headerActions = document.createElement("div");
  headerActions.className = "wm-running-pipelines-modal__header-actions";

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "wm-button secondary wm-button--small";
  refreshButton.textContent = "Refresh";
  refreshButton.dataset.testid = "running-pipelines-modal-refresh";

  const definitionsButton = document.createElement("button");
  definitionsButton.type = "button";
  definitionsButton.className = "wm-button secondary wm-button--small";
  definitionsButton.textContent = "Definitions";
  definitionsButton.dataset.testid = "running-pipelines-modal-definitions";
  definitionsButton.setAttribute("aria-label", "Show pipeline definitions");

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wm-button secondary wm-button--small";
  closeButton.textContent = "Close";
  closeButton.setAttribute("aria-label", "Close running pipelines");
  closeButton.dataset.testid = "running-pipelines-modal-close";
  closeButton.addEventListener("click", () => dialog.close());

  headerActions.append(definitionsButton, refreshButton, closeButton);
  header.append(titleWrap, headerActions);

  const body = document.createElement("div");
  body.className = "wm-running-pipelines-modal__body";

  const status = document.createElement("p");
  status.className = "wm-running-pipelines-modal__status";
  status.setAttribute("aria-live", "polite");

  shell.append(header, body, status);
  dialog.append(shell);

  let runs = [];
  let selectedRunId = null;
  let definitions = [];
  let selectedDefinitionId = null;
  let selectedRunDetail = null;
  let selectedStepDetail = null;
  let viewMode = "runs";
  let loading = false;
  let detailLoading = false;
  let definitionsLoading = false;
  let stoppingRunId = null;
  let showRecentRuns = false;
  let recentRunPage = 0;

  function setStatus(message, type = "") {
    status.textContent = message ?? "";
    status.dataset.state = type;
  }

  async function refreshModalRuns() {
    if (loading) return;
    loading = true;
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing...";
    setStatus("Refreshing pipelines...");
    renderContent();
    try {
      const payload = await fetchPipelineRunSummaries();
      runs = Array.isArray(payload?.runs) ? payload.runs : [];
      const recentPageCount = getRecentPipelineRunPageCount(runs);
      if (recentRunPage >= recentPageCount) {
        recentRunPage = Math.max(0, recentPageCount - 1);
      }
      if (selectedRunId) {
        const stillVisible = runs.some((run) => run.id === selectedRunId);
        if (!stillVisible) {
          selectedRunId = null;
          selectedRunDetail = null;
          selectedStepDetail = null;
        } else {
          await loadSelectedRun({ forceFresh: true, silent: true });
        }
      }
      setStatus("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to refresh pipelines.";
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
    } finally {
      loading = false;
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh";
      renderContent();
    }
  }

  async function refreshModalDefinitions({ silent = false } = {}) {
    if (definitionsLoading) return;
    definitionsLoading = true;
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing...";
    if (!silent) {
      setStatus("Refreshing definitions...");
      renderContent();
    }
    try {
      const payload = await fetchPipelineDefinitionSummaries();
      definitions = Array.isArray(payload?.definitions) ? payload.definitions : [];
      if (selectedDefinitionId && !definitions.some((definition) => definition.id === selectedDefinitionId)) {
        selectedDefinitionId = null;
      }
      if (!selectedDefinitionId && definitions.length) {
        selectedDefinitionId = definitions.find((definition) => definition.default)?.id ?? definitions[0].id;
      }
      setStatus("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to refresh definitions.";
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
    } finally {
      definitionsLoading = false;
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh";
      if (!silent) renderContent();
    }
  }

  async function loadSelectedRun({ forceFresh = false, silent = false } = {}) {
    if (!selectedRunId) return;
    detailLoading = true;
    if (!silent) {
      setStatus("Loading pipeline run...");
      renderContent();
    }
    try {
      selectedRunDetail = await fetchPipelineRunDetail(selectedRunId, buildPipelineRunDetailFetchOptions({ forceFresh }));
      if (selectedStepDetail) {
        const selectedStepId = selectedStepDetail?.step?.id;
        const nextStep = selectedRunDetail?.steps?.find((step) => step.id === selectedStepId);
        selectedStepDetail = nextStep ? { ...selectedStepDetail, step: nextStep } : null;
      }
      if (!silent) setStatus("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load pipeline run.";
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
    } finally {
      detailLoading = false;
      if (!silent) renderContent();
    }
  }

  async function openRunDetails(runId) {
    selectedRunId = runId;
    selectedRunDetail = null;
    selectedStepDetail = null;
    await loadSelectedRun({ forceFresh: isActivePipelineRun(runs.find((run) => run.id === runId)) });
  }

  async function openStepDetails(runId, stepId) {
    if (!runId || !stepId) return;
    setStatus("Loading pipeline step...");
    try {
      selectedStepDetail = await fetchPipelineStepDetail(runId, stepId);
      setStatus("");
      renderContent();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load pipeline step.";
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
    }
  }

  function closeStepDetails() {
    selectedStepDetail = null;
    renderContent();
  }

  async function runDefinition(definition, button) {
    if (!definition?.id || button.disabled) return;
    button.disabled = true;
    button.textContent = "Running...";
    setStatus(`Starting ${definition.name ?? definition.id}...`);
    try {
      const input = definition.input && typeof definition.input === "object" && !Array.isArray(definition.input)
        ? definition.input
        : {};
      const payload = await startPipelineRun(definition.id, input);
      const nextRunId = payload?.run?.id;
      showToast?.("Pipeline run started", { type: "success" });
      viewMode = "runs";
      selectedRunId = nextRunId ?? null;
      selectedRunDetail = nextRunId ? payload : null;
      selectedStepDetail = null;
      showRecentRuns = true;
      await refreshModalRuns();
      renderContent();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start pipeline.";
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = "Run";
      }
    }
  }

  async function restartRun(run, button) {
    if (!run?.id || button.disabled) return;
    button.disabled = true;
    button.textContent = "Restarting...";
    setStatus(`Restarting ${getPipelineRunDisplayName(run)}...`);
    try {
      const detail = await fetchPipelineRunDetail(run.id, { includeRunPayload: true, forceFresh: true });
      const sourceRun = detail?.run ?? run;
      const definitionId = sourceRun.definitionId ?? sourceRun.definition_id;
      if (!definitionId) {
        throw new Error("Pipeline definition id is unavailable for this run.");
      }
      const input = sourceRun.input && typeof sourceRun.input === "object" && !Array.isArray(sourceRun.input)
        ? sourceRun.input
        : {};
      const payload = await startPipelineRun(definitionId, input);
      const nextRunId = payload?.run?.id;
      showToast?.("Pipeline run restarted", { type: "success" });
      await refreshModalRuns();
      if (nextRunId) {
        selectedRunId = nextRunId;
        selectedRunDetail = payload;
        selectedStepDetail = null;
        renderContent();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to restart pipeline.";
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = "Restart";
      }
    }
  }

  async function stopRun(run, button) {
    if (!run?.id || button.disabled) return;
    if (!window.confirm(`Stop ${getPipelineRunDisplayName(run)}? The active pipeline agent session for the current step will be stopped.`)) {
      return;
    }
    stoppingRunId = run.id;
    button.disabled = true;
    button.textContent = "Stopping...";
    setStatus(`Stopping ${getPipelineRunDisplayName(run)}...`);
    try {
      const payload = await stopPipelineRun(run.id);
      selectedRunId = run.id;
      selectedRunDetail = payload;
      selectedStepDetail = null;
      showToast?.("Pipeline run stopped", { type: "success" });
      await refreshModalRuns();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to stop pipeline.";
      setStatus(message, "error");
      showToast?.(message, { type: "error" });
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = "Stop";
      }
    } finally {
      stoppingRunId = null;
      renderContent();
    }
  }

  function renderStatusChip(value) {
    const chip = document.createElement("span");
    chip.className = "wm-pipeline-status-chip";
    chip.dataset.status = String(value ?? "");
    chip.textContent = statusLabel(value);
    return chip;
  }

  function renderListView() {
    const activeRuns = getActivePipelineRuns(runs);
    const recentPageCount = getRecentPipelineRunPageCount(runs);
    const recentRuns = getRecentPipelineRunPage(runs, recentRunPage);
    subtitle.textContent = loading
      ? "Refreshing..."
      : showRecentRuns
        ? `${runs.length} recent run${runs.length === 1 ? "" : "s"} - page ${recentRunPage + 1} of ${recentPageCount}`
        : `${activeRuns.length} active run${activeRuns.length === 1 ? "" : "s"}`;

    if (loading && activeRuns.length === 0) {
      const loadingEl = document.createElement("p");
      loadingEl.className = "wm-running-pipelines-modal__empty";
      loadingEl.textContent = "Loading pipelines...";
      body.append(loadingEl);
      renderRecentRunsToggle(runs.length);
      return;
    }

    if (activeRuns.length === 0 && !showRecentRuns) {
      const empty = document.createElement("p");
      empty.className = "wm-running-pipelines-modal__empty";
      empty.textContent = "No pipeline runs are currently active.";
      body.append(empty);
    } else if (!showRecentRuns) {
      renderPipelineRunList(activeRuns, { testId: "running-pipelines-list" });
    }

    renderRecentRunsToggle(runs.length);
    renderRecentRunsList(recentRuns, recentPageCount);
  }

  function renderDefinitionListView() {
    title.textContent = "Pipeline Definitions";
    definitionsButton.textContent = "Runs";
    definitionsButton.setAttribute("aria-label", "Show pipeline runs");
    subtitle.textContent = definitionsLoading
      ? "Refreshing..."
      : `${definitions.length} definition${definitions.length === 1 ? "" : "s"} available`;

    if (definitionsLoading && definitions.length === 0) {
      const loadingEl = document.createElement("p");
      loadingEl.className = "wm-running-pipelines-modal__empty";
      loadingEl.textContent = "Loading definitions...";
      body.append(loadingEl);
      return;
    }

    if (definitions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-running-pipelines-modal__empty";
      empty.textContent = "No pipeline definitions found.";
      body.append(empty);
      return;
    }

    const layout = document.createElement("div");
    layout.className = "wm-running-pipelines-definitions";
    layout.dataset.testid = "running-pipelines-definitions";

    const list = document.createElement("div");
    list.className = "wm-running-pipelines-list";
    definitions.forEach((definition) => {
      list.append(renderDefinitionListItem(definition));
    });

    const selected = definitions.find((definition) => definition.id === selectedDefinitionId) ?? definitions[0];
    const preview = document.createElement("article");
    preview.className = "wm-running-pipelines-definition-detail";
    preview.dataset.testid = "running-pipeline-definition-detail";
    preview.innerHTML = renderDefinitionPreview(selected);

    layout.append(list, preview);
    body.append(layout);
  }

  function renderDefinitionListItem(definition) {
    const item = document.createElement("article");
    item.className = "wm-running-pipelines-list__item";
    item.dataset.definitionId = String(definition.id ?? "");

    const mainButton = document.createElement("button");
    mainButton.type = "button";
    mainButton.className = "wm-running-pipelines-list__main";
    mainButton.dataset.testid = "running-pipeline-definition";
    mainButton.setAttribute("aria-current", selectedDefinitionId === definition.id ? "true" : "false");
    mainButton.setAttribute("aria-label", `Show definition ${definition.name ?? definition.id}`);
    mainButton.addEventListener("click", () => {
      selectedDefinitionId = definition.id;
      renderContent();
    });

    const name = document.createElement("span");
    name.className = "wm-running-pipelines-list__name";
    name.textContent = definition.name ?? definition.id ?? "Pipeline";

    const meta = document.createElement("span");
    meta.className = "wm-running-pipelines-list__meta";
    const stepCount = Array.isArray(definition.steps) ? definition.steps.length : 0;
    meta.textContent = `${definition.scope ?? "definition"} - ${stepCount} step${stepCount === 1 ? "" : "s"}`;
    mainButton.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "wm-running-pipelines-list__actions";
    if (definition.default) {
      const defaultChip = document.createElement("span");
      defaultChip.className = "wm-pipeline-status-chip";
      defaultChip.dataset.status = "default";
      defaultChip.textContent = "Default";
      actions.append(defaultChip);
    }
    const runButton = document.createElement("button");
    runButton.type = "button";
    runButton.className = "wm-button secondary wm-button--small";
    runButton.textContent = "Run";
    runButton.dataset.testid = "running-pipeline-definition-run";
    runButton.setAttribute("aria-label", `Run ${definition.name ?? definition.id}`);
    runButton.addEventListener("click", () => void runDefinition(definition, runButton));
    actions.append(runButton);

    item.append(mainButton, actions);
    return item;
  }

  function renderDefinitionPreview(definition) {
    if (!definition) {
      return `<p class="wm-running-pipelines-modal__empty">Select a definition.</p>`;
    }
    const steps = Array.isArray(definition.steps) ? definition.steps : [];
    return `
      <header class="wm-pipeline-detail-header">
        <div>
          <h2>${escapeHtml(definition.name ?? definition.id ?? "Pipeline")}</h2>
          ${definition.description ? `<p>${escapeHtml(definition.description)}</p>` : `<p class="wm-muted">No description.</p>`}
          <p><code>${escapeHtml(definition.id ?? "")}</code></p>
        </div>
        <span class="wm-pipeline-status-chip" data-status="${escapeAttribute(definition.default ? "default" : definition.scope)}">${escapeHtml(definition.default ? "Default" : definition.scope ?? "Definition")}</span>
      </header>
      <section class="wm-running-pipelines-definition-steps" aria-label="Pipeline definition steps">
        ${steps.length ? steps.map((step, index) => renderDefinitionStepPreview(step, index)).join("") : `<p class="wm-muted">No steps defined.</p>`}
      </section>
    `;
  }

  function renderDefinitionStepPreview(step, index) {
    const inputRows = getDefinitionFlowRows(step, "in");
    const outputRows = getDefinitionFlowRows(step, "out");
    return `
      <article class="wm-pipeline-definition-step">
        <div>
          <span class="wm-pipeline-step-number">${escapeHtml(String(index + 1))}</span>
          <strong>${escapeHtml(step.name ?? `Step ${index + 1}`)}</strong>
          <small>${escapeHtml(step.type ?? "step")}</small>
        </div>
        ${step.description ? `<p>${escapeHtml(step.description)}</p>` : ""}
        <div class="wm-pipeline-step-flow-grid">
          ${renderDefinitionFieldSet("Definitions In", inputRows)}
          ${renderDefinitionFieldSet("Activity Out", outputRows)}
        </div>
      </article>
    `;
  }

  function renderDefinitionFieldSet(label, rows) {
    return `
      <div class="wm-pipeline-flow-fieldset">
        <span>${escapeHtml(label)}</span>
        ${renderDefinitionFieldRows(rows)}
      </div>
    `;
  }

  function renderDefinitionFieldRows(rows) {
    if (!rows.length) return `<span class="wm-pipeline-flow-empty">No user-facing fields</span>`;
    return `
      <div class="wm-pipeline-flow-rows">
        ${rows.slice(0, 5).map((row) => `
          <div class="wm-pipeline-flow-row">
            <code>${escapeHtml(row.name)}</code><span>${escapeHtml(row.value || "--")}</span>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderPipelineRunList(listRuns, { testId = "" } = {}) {
    const list = document.createElement("div");
    list.className = "wm-running-pipelines-list";
    if (testId) list.dataset.testid = testId;

    listRuns.forEach((run) => {
      list.append(renderPipelineRunListItem(run));
    });

    body.append(list);
  }

  function renderPipelineRunListItem(run) {
    const item = document.createElement("article");
    item.className = "wm-running-pipelines-list__item";
    item.dataset.runId = String(run.id ?? "");

    const mainButton = document.createElement("button");
    mainButton.type = "button";
    mainButton.className = "wm-running-pipelines-list__main";
    mainButton.dataset.testid = "running-pipeline-details";
    mainButton.setAttribute("aria-label", `Show details for ${getPipelineRunDisplayName(run)}`);
    mainButton.addEventListener("click", () => void openRunDetails(run.id));

    const name = document.createElement("span");
    name.className = "wm-running-pipelines-list__name";
    name.textContent = getPipelineRunDisplayName(run);

    const meta = document.createElement("span");
    meta.className = "wm-running-pipelines-list__meta";
    meta.textContent = `${run.definitionSlug ?? run.definitionId ?? "pipeline"} - ${formatRunMeta(run)}`;

    mainButton.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "wm-running-pipelines-list__actions";
    actions.append(renderStatusChip(run.status));

    if (isActivePipelineRun(run)) {
      const stopButton = document.createElement("button");
      stopButton.type = "button";
      stopButton.className = "wm-button secondary wm-button--small";
      stopButton.textContent = stoppingRunId === run.id ? "Stopping..." : "Stop";
      stopButton.disabled = stoppingRunId === run.id;
      stopButton.dataset.testid = "running-pipeline-stop";
      stopButton.setAttribute("aria-label", `Stop ${getPipelineRunDisplayName(run)}`);
      stopButton.addEventListener("click", () => void stopRun(run, stopButton));
      actions.append(stopButton);
    }

    const restartButton = document.createElement("button");
    restartButton.type = "button";
    restartButton.className = "wm-button secondary wm-button--small";
    restartButton.textContent = "Restart";
    restartButton.dataset.testid = "running-pipeline-restart";
    restartButton.setAttribute("aria-label", `Restart ${getPipelineRunDisplayName(run)}`);
    restartButton.addEventListener("click", () => void restartRun(run, restartButton));
    actions.append(restartButton);

    item.append(mainButton, actions);
    return item;
  }

  function renderRecentRunsToggle(totalRuns) {
    if (totalRuns === 0) return;
    const footer = document.createElement("div");
    footer.className = "wm-running-pipelines-modal__list-footer";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "wm-button";
    button.textContent = showRecentRuns ? "Hide Recent" : "Show Recent";
    button.dataset.testid = "running-pipelines-show-recent-toggle";
    button.setAttribute("aria-label", showRecentRuns ? "Hide recent pipeline runs" : "Show recent pipeline runs");
    button.setAttribute("aria-expanded", showRecentRuns ? "true" : "false");
    button.addEventListener("click", () => {
      showRecentRuns = !showRecentRuns;
      if (!showRecentRuns) recentRunPage = 0;
      renderContent();
    });

    footer.append(button);
    body.append(footer);
  }

  function renderRecentRunsList(recentRuns, pageCount) {
    if (!showRecentRuns) return;

    const section = document.createElement("section");
    section.className = "wm-running-pipelines-modal__recent";
    section.setAttribute("aria-labelledby", "running-pipelines-recent-title");
    section.dataset.testid = "running-pipelines-recent";

    const header = document.createElement("div");
    header.className = "wm-running-pipelines-modal__recent-header";

    const heading = document.createElement("h3");
    heading.id = "running-pipelines-recent-title";
    heading.textContent = "Recent Runs";

    const pager = document.createElement("div");
    pager.className = "wm-running-pipelines-modal__pager";
    pager.setAttribute("aria-label", "Recent pipeline pages");

    const previousButton = document.createElement("button");
    previousButton.type = "button";
    previousButton.className = "wm-button secondary wm-button--small";
    previousButton.textContent = "Previous";
    previousButton.disabled = recentRunPage <= 0;
    previousButton.dataset.testid = "running-pipelines-recent-previous";
    previousButton.setAttribute("aria-label", "Show previous recent pipeline runs");
    previousButton.addEventListener("click", () => {
      recentRunPage = Math.max(0, recentRunPage - 1);
      renderContent();
    });

    const pageLabel = document.createElement("span");
    pageLabel.textContent = `Page ${recentRunPage + 1} of ${pageCount}`;
    pageLabel.setAttribute("aria-live", "polite");

    const nextButton = document.createElement("button");
    nextButton.type = "button";
    nextButton.className = "wm-button secondary wm-button--small";
    nextButton.textContent = "Next";
    nextButton.disabled = recentRunPage >= pageCount - 1;
    nextButton.dataset.testid = "running-pipelines-recent-next";
    nextButton.setAttribute("aria-label", "Show next recent pipeline runs");
    nextButton.addEventListener("click", () => {
      recentRunPage = Math.min(pageCount - 1, recentRunPage + 1);
      renderContent();
    });

    pager.append(previousButton, pageLabel, nextButton);
    header.append(heading, pager);
    section.append(header);

    if (recentRuns.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wm-running-pipelines-modal__empty";
      empty.textContent = "No pipeline runs have been recorded yet.";
      section.append(empty);
      body.append(section);
      return;
    }

    const list = document.createElement("div");
    list.className = "wm-running-pipelines-list";
    list.dataset.testid = "running-pipelines-recent-list";
    recentRuns.forEach((run) => {
      list.append(renderPipelineRunListItem(run));
    });
    section.append(list);
    body.append(section);
  }

  function renderDetailsView() {
    title.textContent = "Running Pipelines";
    definitionsButton.textContent = "Definitions";
    definitionsButton.setAttribute("aria-label", "Show pipeline definitions");
    const run = selectedRunDetail?.run ?? runs.find((entry) => entry.id === selectedRunId) ?? null;
    subtitle.textContent = run ? getPipelineRunDisplayName(run) : "Pipeline run";

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "wm-button secondary wm-button--small wm-running-pipelines-modal__back";
    backButton.textContent = "Back to pipelines";
    backButton.dataset.testid = "running-pipelines-back";
    backButton.addEventListener("click", () => {
      selectedRunId = null;
      selectedRunDetail = null;
      selectedStepDetail = null;
      renderContent();
    });
    body.append(backButton);

    if (detailLoading && !selectedRunDetail) {
      const loadingEl = document.createElement("p");
      loadingEl.className = "wm-running-pipelines-modal__empty";
      loadingEl.textContent = "Loading run details...";
      body.append(loadingEl);
      return;
    }

    if (!run) {
      const empty = document.createElement("p");
      empty.className = "wm-running-pipelines-modal__empty";
      empty.textContent = "Pipeline run details are unavailable.";
      body.append(empty);
      return;
    }

    body.append(renderRunDetail(run, selectedRunDetail?.steps ?? []));
  }

  function renderRunDetail(run, steps) {
    const article = document.createElement("article");
    article.className = "wm-running-pipelines-detail";
    article.dataset.testid = "running-pipeline-detail";
    article.innerHTML = `
      <header class="wm-pipeline-detail-header">
        <div>
          <h2>${escapeHtml(getPipelineRunDisplayName(run))}</h2>
          <p><code>${escapeHtml(run.id)}</code></p>
        </div>
        <div class="wm-pipeline-run-actions">
          ${isActivePipelineRun(run) ? `
            <button
              type="button"
              class="wm-button secondary wm-button--small"
              data-action="running-pipeline-stop-selected"
              data-run-id="${escapeAttribute(run.id)}"
              data-testid="running-pipeline-detail-stop"
              aria-label="Stop ${escapeAttribute(getPipelineRunDisplayName(run))}"
              ${stoppingRunId === run.id ? "disabled" : ""}
            >${stoppingRunId === run.id ? "Stopping..." : "Stop Run"}</button>
          ` : ""}
          <span class="wm-pipeline-status-chip" data-status="${escapeHtml(run.status)}">${escapeHtml(statusLabel(run.status))}</span>
        </div>
      </header>
      <dl class="wm-pipeline-facts">
        <div><dt>Started</dt><dd>${escapeHtml(formatDateTime(run.startedAt ?? run.started_at))}</dd></div>
        <div><dt>Completed</dt><dd>${escapeHtml(formatDateTime(run.completedAt ?? run.completed_at))}</dd></div>
        <div><dt>Duration</dt><dd>${escapeHtml(formatDuration(run.startedAt ?? run.started_at, run.completedAt ?? run.completed_at))}</dd></div>
        <div><dt>Definition</dt><dd>${escapeHtml(run.definitionSlug ?? run.definitionId ?? "--")}</dd></div>
        <div><dt>Steps</dt><dd>${escapeHtml(String(steps.length))}</dd></div>
      </dl>
      <section class="wm-running-pipelines-detail__steps" aria-label="Pipeline steps">
        ${steps.length ? renderRunningPipelineStepTimeline(run, steps, selectedStepDetail, {
          agentOutputFormattingEnabled: Boolean(agentOutputFormattingEnabled),
        }) : `<p class="wm-muted">No steps recorded for this run.</p>`}
      </section>
      <div class="wm-running-pipelines-detail__data">
        ${renderJsonBlock("Input", run.input ?? {})}
        ${renderJsonBlock("Result", run.result ?? run.error ?? {})}
      </div>
    `;
    return article;
  }

  function renderContent() {
    body.innerHTML = "";
    if (viewMode === "definitions") {
      renderDefinitionListView();
    } else if (selectedRunId) {
      title.textContent = "Running Pipelines";
      definitionsButton.textContent = "Definitions";
      definitionsButton.setAttribute("aria-label", "Show pipeline definitions");
      renderDetailsView();
    } else {
      title.textContent = "Running Pipelines";
      definitionsButton.textContent = "Definitions";
      definitionsButton.setAttribute("aria-label", "Show pipeline definitions");
      renderListView();
    }
    bindPipelineValueInspector(body);
  }

  refreshButton.addEventListener("click", () => {
    if (viewMode === "definitions") {
      void refreshModalDefinitions();
      return;
    }
    void refreshModalRuns();
  });
  definitionsButton.addEventListener("click", () => {
    if (viewMode === "definitions") {
      viewMode = "runs";
      renderContent();
      return;
    }
    viewMode = "definitions";
    selectedRunId = null;
    selectedRunDetail = null;
    selectedStepDetail = null;
    renderContent();
    if (definitions.length === 0) {
      void refreshModalDefinitions();
    }
  });
  body.addEventListener("click", (event) => {
    const selectStepButton = event.target?.closest?.('[data-action="select-step"]');
    if (selectStepButton) {
      event.preventDefault();
      void openStepDetails(selectStepButton.dataset.runId ?? "", selectStepButton.dataset.stepId ?? "");
      return;
    }
    const closeStepButton = event.target?.closest?.('[data-action="close-step-detail"]');
    if (closeStepButton) {
      event.preventDefault();
      closeStepDetails();
      return;
    }
    const stopSelectedButton = event.target?.closest?.('[data-action="running-pipeline-stop-selected"]');
    if (stopSelectedButton) {
      event.preventDefault();
      const run = selectedRunDetail?.run ?? runs.find((entry) => entry.id === stopSelectedButton.dataset.runId);
      void stopRun(run, stopSelectedButton);
    }
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
  });

  document.body.append(dialog);
  renderContent();
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else if (typeof dialog.show === "function") {
    dialog.show();
  } else {
    dialog.setAttribute("open", "open");
  }

  void refreshModalRuns();
}
