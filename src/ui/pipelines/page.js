import {
  PIPELINE_AGENT_OUTPUT_FORMATTING_FLAG_KEY,
} from "./agent-output-format.js";
import {
  fetchPipelineDefinitions,
  fetchPipelineFunction,
  fetchPipelineFunctions,
  fetchPipelineRoot,
  fetchPipelineRuns,
  fetchPipelineRun,
  cancelPipelineRun,
  editPipelineWithWizard,
  resumePipelineRunFromFailure,
  runPipelineDefinition,
  saveManualPipelineEdit,
  startPipelineFunctionWizard,
  startPipelineWizard,
} from "./api.js";
import { createPipelineActionHandlers } from "./action-handlers.js";
import { bindPipelinesPageActions } from "./bindings.js";
import { renderDefinitionDetailPage, renderDefinitionsListPage } from "./definitions-view.js";
import { renderFunctionsWorkspace } from "./functions-view.js";
import { renderRunLauncher } from "./launcher-view.js";
import { makePipelinePath, parsePipelineRoute, pushPipelinePath, replacePipelinePath } from "./routes.js";
import { renderRunDetailPage, renderRunsListPage } from "./runs-view.js";
import {
  createPipelinesState,
  ensureRunInputForSelection,
  ensureSelectedDefinition,
  getRouteDefinition,
  getSelectedDefinition,
  hasRunPayload,
  normalizeTab,
  parseRunInput,
  pickDefaultDefinitionId,
} from "./state.js";
import { escapeHtml } from "./view-utils.js";
import { isActivePipelineRunStatus } from "./db.js";

export function initPipelinesPage({ showToast, isFeatureEnabledForViewer = () => false }) {
  const state = createPipelinesState();
  const loaded = {
    root: false,
    definitions: false,
    runs: false,
    functions: false,
  };

  async function ensureLoaded() {
    await loadAll();
  }

  function renderPage() {
    const page = document.createElement("div");
    page.className = "wm-page wm-pipelines-page";
    state.loading = !isRouteLoaded(getCurrentRoute());
    page.append(renderShell(page));
    void loadAll().then(() => hydrateRouteDetail()).then(() => updatePage(page)).catch((error) => renderError(page, error));
    return page;
  }

  async function loadAll(options = {}) {
    state.loading = true;
    await loadRouteData(getCurrentRoute(), options);
    state.loading = false;
  }

  async function loadRouteData(route, options = {}) {
    const tasks = [loadRoot(options)];
    if (route.section === "runs") {
      tasks.push(loadRuns(options));
    } else if (route.section === "definitions") {
      tasks.push(loadDefinitions(options));
    } else if (route.section === "functions") {
      tasks.push(loadFunctions(options));
    }
    if (state.launcherOpen) {
      tasks.push(loadDefinitions(options));
    }
    await Promise.all(tasks);
  }

  function isRouteLoaded(route) {
    if (!loaded.root) return false;
    if (route.section === "runs") return loaded.runs && (!route.id || state.selectedRun?.run?.id === route.id);
    if (route.section === "definitions") return loaded.definitions;
    if (route.section === "functions") {
      return loaded.functions && (!route.id || state.selectedFunctionDetail?.function?.name === route.id);
    }
    return true;
  }

  async function loadRoot({ force = false } = {}) {
    if (loaded.root && !force) return;
    state.root = await fetchPipelineRoot();
    loaded.root = true;
  }

  async function loadDefinitions({ force = false } = {}) {
    if (loaded.definitions && !force) return;
    const definitions = await fetchPipelineDefinitions();
    state.definitions = definitions.definitions ?? [];
    loaded.definitions = true;
    ensureSelectedDefinition(state);
  }

  async function loadRuns({ force = false } = {}) {
    if (loaded.runs && !force) return;
    const runs = await fetchPipelineRuns();
    state.runs = runs.runs ?? [];
    loaded.runs = true;
  }

  async function loadFunctions({ force = false } = {}) {
    if (loaded.functions && !force) return;
    const functions = await fetchPipelineFunctions();
    state.functions = functions.functions ?? [];
    loaded.functions = true;
  }

  function updatePage(page) {
    page.innerHTML = "";
    page.append(renderShell(page));
  }

  function renderError(page, error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.loading = false;
    updatePage(page);
  }

  function renderShell(page) {
    const route = getCurrentRoute();
    syncFeatureFlagState();
    applyRoute(route);
    const wrap = document.createElement("main");
    wrap.className = "wm-pipelines-shell";
    wrap.setAttribute("aria-labelledby", "pipelines-title");
    const selected = getRouteDefinition(state, route);
    if (state.launcherOpen) {
      ensureRunInputForSelection(state, getSelectedDefinition(state));
    }
    wrap.innerHTML = `
      ${renderHeader(route)}
      ${state.error ? `<p class="wm-error" role="alert">${escapeHtml(state.error)}</p>` : ""}
      ${state.launcherOpen ? renderRunLauncher(state, getSelectedDefinition(state)) : ""}
      ${renderRouteContent(route, selected)}
    `;
    bindActions(wrap, page);
    return wrap;
  }

  function syncFeatureFlagState() {
    state.agentOutputFormattingEnabled = Boolean(
      isFeatureEnabledForViewer(PIPELINE_AGENT_OUTPUT_FORMATTING_FLAG_KEY),
    );
  }

  function renderHeader(route) {
    const rootLabel = state.root?.root ?? "~/.wingmen/pipelines";
    return `
      <header class="wm-pipelines-header">
        <div>
          <h1 id="pipelines-title">Pipelines</h1>
          <p class="wm-muted">Declarative object-in/object-out workflows from <code>${escapeHtml(rootLabel)}</code></p>
        </div>
        <div class="wm-pipelines-header-actions">
          <button type="button" data-action="open-launcher" data-testid="pipeline-run-action">Run Pipeline</button>
          <button type="button" data-action="refresh" data-testid="pipeline-refresh-action">Refresh</button>
        </div>
      </header>
      <nav class="wm-pipeline-tabs" aria-label="Pipeline sections" data-testid="pipeline-tabs">
        <button type="button" data-action="navigate-pipeline" data-path="/pipelines/runs" aria-selected="${route.section === "runs"}">Runs</button>
        <button type="button" data-action="navigate-pipeline" data-path="/pipelines/definitions" aria-selected="${route.section === "definitions"}">Definitions</button>
        <button type="button" data-action="navigate-pipeline" data-path="/pipelines/functions" aria-selected="${route.section === "functions"}">Functions</button>
      </nav>
    `;
  }

  function renderRouteContent(route, selected) {
    if (state.loading) {
      return `
        <section class="wm-pipeline-page-section" aria-live="polite">
          <div class="wm-pipeline-panel">
            <div class="wm-pipeline-empty-detail"><p>Loading pipelines...</p></div>
          </div>
        </section>
      `;
    }
    if (route.section === "definitions") {
      return route.id
        ? renderDefinitionDetailPage(state, selected)
        : renderDefinitionsListPage(state);
    }
    if (route.section === "functions") {
      return renderFunctionsWorkspace(state);
    }
    return route.id ? renderRunDetailPage(state, route.id) : renderRunsListPage(state);
  }

  function getCurrentRoute() {
    const route = parsePipelineRoute();
    if (route.canonical) {
      replacePipelinePath(route.canonical);
      return parsePipelineRoute(route.canonical);
    }
    return route;
  }

  function applyRoute(route) {
    state.activeTab = normalizeTab(route.section);
    if (route.section === "definitions" && route.id) {
      state.selectedDefinitionId = route.id;
      state.creatorOpen = false;
    }
    if (route.section !== "definitions") {
      state.creatorOpen = false;
      state.editDefinitionId = "";
      state.manualEditDefinitionId = "";
    }
    if (route.section !== "functions") {
      state.functionCreatorOpen = false;
      state.selectedFunctionName = "";
      state.selectedFunctionDetail = null;
      state.selectedFunctionLoading = false;
    } else if (route.id) {
      state.selectedFunctionName = route.id;
      state.functionCreatorOpen = false;
    }
  }

  async function hydrateRouteDetail(route = getCurrentRoute()) {
    applyRoute(route);
    const summary = route.section === "runs" && route.id
      ? state.runs.find((run) => run.id === route.id)
      : null;
    const runStatus = summary?.status ?? state.selectedRun?.run?.status;
    const runIsActive = isActivePipelineRunStatus(runStatus);
    const runChanged = state.selectedRun?.run?.id !== route.id;
    const shouldRefreshRun =
      route.section === "runs" &&
      route.id &&
      (runChanged || runIsActive);
    if (shouldRefreshRun) {
      state.selectedRun = await fetchPipelineRun(route.id, {
        includeRunPayload: false,
        includeStepPayload: true,
        forceFresh: runIsActive,
      });
      if (runChanged) {
        state.selectedStep = null;
        state.selectedRunTab = "overview";
      }
      state.selectedRunPayloadLoading = false;
      state.selectedRunPayloadError = null;
    }
    if (route.section === "functions" && route.id && state.selectedFunctionDetail?.function?.name !== route.id) {
      state.selectedFunctionLoading = true;
      try {
        state.selectedFunctionDetail = await fetchPipelineFunction(route.id);
      } finally {
        state.selectedFunctionLoading = false;
      }
    }
  }

  async function ensureSelectedRunPayload(page) {
    const run = state.selectedRun?.run;
    if (!run?.id || hasRunPayload(run)) return;
    state.selectedRunPayloadLoading = true;
    state.selectedRunPayloadError = null;
    updatePage(page);
    try {
      state.selectedRun = await fetchPipelineRun(run.id, {
        includeRunPayload: true,
        includeStepPayload: true,
        forceFresh: isActivePipelineRunStatus(run.status),
      });
    } catch (error) {
      state.selectedRunPayloadError = error instanceof Error ? error.message : String(error);
    } finally {
      state.selectedRunPayloadLoading = false;
      updatePage(page);
    }
  }

  async function navigateToPipelinePath(page, path) {
    if (!path) return;
    pushPipelinePath(path);
    state.error = null;
    updatePage(page);
    try {
      await loadRouteData(getCurrentRoute());
      await hydrateRouteDetail();
      updatePage(page);
    } catch (error) {
      renderError(page, error);
    }
  }

  function bindActions(root, page) {
    bindPipelinesPageActions(root, page, createPipelineActionHandlers({
      state,
      loadAll,
      loadDefinitions,
      hydrateRouteDetail,
      updatePage,
      updatePageAndRestoreFocus,
      navigateToPipelinePath,
      ensureSelectedRunPayload,
      showToast,
      cancelRun,
      resumeRunFromFailure,
      startCreateWizard,
      startEditWizard,
      saveManualEdit,
      startSelectedRun,
      startFunctionWizard,
    }));
  }

  async function startCreateWizard(page) {
    const prompt = state.wizardPrompt.trim();
    if (!prompt) {
      showToast("Describe the pipeline first", { type: "warning" });
      return;
    }
    state.wizardBusy = true;
    state.wizardResult = null;
    state.error = null;
    updatePage(page);
    try {
      state.wizardResult = await startPipelineWizard(prompt);
      showToast("Pipeline wizard session started", { type: "success" });
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      showToast(state.error, { type: "error" });
    } finally {
      state.wizardBusy = false;
      updatePage(page);
    }
  }

  async function resumeRunFromFailure(page, id) {
    if (!id) return;
    state.resumingRunId = id;
    state.error = null;
    updatePage(page);
    try {
      const payload = await resumePipelineRunFromFailure(id);
      state.selectedRun = payload;
      state.selectedStep = null;
      state.selectedRunTab = "overview";
      const runs = await fetchPipelineRuns();
      state.runs = runs.runs ?? [];
      showToast("Pipeline run resumed", { type: "success" });
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      showToast(state.error, { type: "error" });
    } finally {
      state.resumingRunId = null;
      updatePage(page);
    }
  }

  async function cancelRun(page, id) {
    if (!id) return;
    if (!window.confirm("Stop this pipeline run? The active pipeline agent session for the current step will be stopped.")) {
      return;
    }
    state.cancellingRunId = id;
    state.error = null;
    updatePage(page);
    try {
      const payload = await cancelPipelineRun(id);
      state.selectedRun = payload;
      state.selectedStep = null;
      state.selectedRunTab = "overview";
      const runs = await fetchPipelineRuns();
      state.runs = runs.runs ?? [];
      showToast("Pipeline run stopped", { type: "success" });
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      showToast(state.error, { type: "error" });
    } finally {
      state.cancellingRunId = null;
      updatePage(page);
    }
  }

  async function startEditWizard(page, id) {
    const prompt = state.editPrompt.trim();
    if (!id || !prompt) {
      showToast("Describe the change first", { type: "warning" });
      return;
    }
    state.editBusy = true;
    state.editResult = null;
    state.error = null;
    updatePage(page);
    try {
      state.editResult = await editPipelineWithWizard(id, prompt);
      showToast("Pipeline edit wizard session started", { type: "success" });
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      showToast(state.error, { type: "error" });
    } finally {
      state.editBusy = false;
      updatePage(page);
    }
  }

  async function saveManualEdit(page, id) {
    if (!id) return;
    const form = state.manualEditForm ?? {};
    const name = String(form.name ?? "").trim();
    if (!name) {
      showToast("Title is required", { type: "warning" });
      return;
    }

    let input;
    let steps;
    try {
      input = JSON.parse(form.inputText || "{}");
      steps = JSON.parse(form.stepsText || "[]");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { type: "error" });
      return;
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      showToast("Default input must be a JSON object", { type: "warning" });
      return;
    }
    if (!Array.isArray(steps)) {
      showToast("Workflow steps must be a JSON array", { type: "warning" });
      return;
    }

    state.manualEditBusy = true;
    state.manualEditResult = null;
    state.error = null;
    updatePage(page);
    try {
      const tags = String(form.tagsText ?? "")
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean);
      state.manualEditResult = await saveManualPipelineEdit(id, {
        name,
        description: String(form.description ?? ""),
        default: form.default === true,
        tags,
        input,
        steps,
      });
      const definitions = await fetchPipelineDefinitions();
      state.definitions = definitions.definitions ?? [];
      const nextId = state.manualEditResult.definition?.id;
      if (nextId) {
        state.selectedDefinitionId = nextId;
        state.manualEditDefinitionId = "";
        await navigateToPipelinePath(page, makePipelinePath("definitions", nextId));
      } else {
        updatePage(page);
      }
      showToast("Pipeline version saved", { type: "success" });
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      showToast(state.error, { type: "error" });
      updatePage(page);
    } finally {
      state.manualEditBusy = false;
      updatePage(page);
    }
  }

  async function startFunctionWizard(page) {
    const prompt = state.functionPrompt.trim();
    if (!prompt) {
      showToast("Describe the function first", { type: "warning" });
      return;
    }
    state.functionBusy = true;
    state.functionResult = null;
    state.error = null;
    updatePage(page);
    try {
      state.functionResult = await startPipelineFunctionWizard(prompt);
      const functions = await fetchPipelineFunctions();
      state.functions = functions.functions ?? [];
      showToast("Function wizard session started", { type: "success" });
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      showToast(state.error, { type: "error" });
    } finally {
      state.functionBusy = false;
      updatePage(page);
    }
  }

  async function startSelectedRun(page) {
    const id = state.selectedDefinitionId || pickDefaultDefinitionId(state);
    if (!id) return;
    state.runningId = id;
    state.error = null;
    updatePage(page);
    try {
      const payload = await runPipelineDefinition(id, parseRunInput(state));
      state.selectedRun = payload;
      state.selectedStep = null;
      state.selectedRunTab = "overview";
      state.launcherOpen = false;
      const runs = await fetchPipelineRuns();
      state.runs = runs.runs ?? [];
      if (payload?.run?.id) {
        pushPipelinePath(makePipelinePath("runs", payload.run.id));
      }
      showToast("Pipeline run started", { type: "success" });
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      showToast(state.error, { type: "error" });
    } finally {
      state.runningId = null;
      updatePage(page);
    }
  }

  function updatePageAndRestoreFocus(page, selector) {
    updatePage(page);
    const input = page.querySelector(selector);
    if (input && typeof input.focus === "function") {
      input.focus({ preventScroll: true });
      if (typeof input.setSelectionRange === "function") {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    }
  }

  return { renderPage, ensureLoaded };
}
