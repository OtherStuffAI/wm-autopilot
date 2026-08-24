import { fetchPipelineStep } from "./api.js";
import { makePipelinePath } from "./routes.js";
import { ensureSelectedDefinition } from "./state.js";

export function createPipelineActionHandlers(deps) {
  const {
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
  } = deps;

  const updateField = (page, key, value) => {
    state[key] = value;
    updatePage(page);
  };
  const updateSearch = (page, key, value, selector) => {
    state[key] = value;
    updatePageAndRestoreFocus(page, selector);
  };

  return {
    navigate: navigateToPipelinePath,
    refresh: async (page) => {
      await loadAll({ force: true });
      await hydrateRouteDetail();
      updatePage(page);
      showToast("Pipelines refreshed");
    },
    openLauncher: async (page) => {
      await loadDefinitions();
      state.launcherOpen = true;
      ensureSelectedDefinition(state);
      state.runInputText = "";
      updatePage(page);
    },
    closeLauncher: (page) => updateField(page, "launcherOpen", false),
    updateRunSearch: (page, value) => updateSearch(page, "runSearch", value, '[data-action="run-search"]'),
    setRunFilter: (page, value) => updateField(page, "runFilter", value),
    setRunTagFilter: (page, value) => updateField(page, "runTagFilter", value),
    openRun: (page, id) => navigateToPipelinePath(page, makePipelinePath("runs", id)),
    setRunTab: async (page, value) => {
      state.selectedRunTab = value;
      updatePage(page);
      if (value === "input" || value === "result") {
        await ensureSelectedRunPayload(page);
      }
    },
    selectStep: async (page, runId, stepId) => {
      if (!runId || !stepId) return;
      state.selectedStep = await fetchPipelineStep(runId, stepId);
      updatePage(page);
    },
    closeStepDetail: (page) => updateField(page, "selectedStep", null),
    cancelRun,
    resumeRunFromFailure,
    updateDefinitionSearch: (page, value) => updateSearch(page, "definitionSearch", value, '[data-action="definition-search"]'),
    setDefinitionFilter: (page, value) => updateField(page, "definitionFilter", value),
    setDefinitionTagFilter: (page, value) => updateField(page, "definitionTagFilter", value),
    openDefinition: async (page, id) => {
      if (!id) return;
      state.selectedDefinitionId = id;
      state.creatorOpen = false;
      state.editDefinitionId = "";
      state.manualEditDefinitionId = "";
      await navigateToPipelinePath(page, makePipelinePath("definitions", id));
    },
    selectLauncherDefinition: (page, id) => {
      state.selectedDefinitionId = id;
      state.runInputText = "";
      updatePage(page);
    },
    updateRunInput: (value) => { state.runInputText = value; },
    openLauncherForDefinition: async (page, id) => {
      await loadDefinitions();
      if (id) state.selectedDefinitionId = id;
      state.launcherOpen = true;
      state.runInputText = "";
      updatePage(page);
    },
    openCreator: async (page) => {
      state.creatorOpen = true;
      state.editDefinitionId = "";
      state.manualEditDefinitionId = "";
      state.wizardResult = null;
      await navigateToPipelinePath(page, makePipelinePath("definitions"));
      const prompt = page.querySelector('[data-action="wizard-prompt"]');
      if (prompt && typeof prompt.focus === "function") {
        prompt.focus({ preventScroll: false });
      }
    },
    closeCreator: (page) => updateField(page, "creatorOpen", false),
    updateWizardPrompt: (value) => { state.wizardPrompt = value; },
    startCreateWizard,
    openEditWizard: (page, id) => {
      if (!id) return;
      state.creatorOpen = false;
      state.manualEditDefinitionId = "";
      state.editDefinitionId = id;
      state.editPrompt = "";
      state.editResult = null;
      updatePage(page);
    },
    cancelEditWizard: (page) => {
      state.editDefinitionId = "";
      state.editPrompt = "";
      state.editResult = null;
      updatePage(page);
    },
    updateEditPrompt: (value) => { state.editPrompt = value; },
    startEditWizard,
    openManualEdit: (page, id) => {
      const definition = state.definitions.find((entry) => entry.id === id);
      if (!definition) return;
      state.creatorOpen = false;
      state.editDefinitionId = "";
      state.manualEditDefinitionId = id;
      state.manualEditResult = null;
      state.manualEditForm = {
        name: definition.name ?? "",
        description: definition.description ?? "",
        tagsText: Array.isArray(definition.tags) ? definition.tags.join(", ") : "",
        default: definition.default === true,
        inputText: JSON.stringify(definition.input ?? {}, null, 2),
        stepsText: JSON.stringify(definition.steps ?? [], null, 2),
      };
      updatePage(page);
    },
    cancelManualEdit: (page) => {
      state.manualEditDefinitionId = "";
      state.manualEditResult = null;
      updatePage(page);
    },
    updateManualEditField: (field, value) => {
      if (!state.manualEditForm) state.manualEditForm = {};
      state.manualEditForm[field] = value;
    },
    updateManualAgentPrompt: (stepIndex, value) => {
      if (!state.manualEditForm) state.manualEditForm = {};
      const index = Number(stepIndex);
      if (!Number.isInteger(index) || index < 0) return;
      let steps;
      try {
        steps = JSON.parse(state.manualEditForm.stepsText || "[]");
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), { type: "error" });
        return;
      }
      if (!Array.isArray(steps) || !steps[index] || typeof steps[index] !== "object") {
        showToast("Agent prompt cannot be updated because the workflow steps JSON is invalid.", { type: "error" });
        return;
      }
      steps[index] = { ...steps[index], prompt: value };
      state.manualEditForm.stepsText = JSON.stringify(steps, null, 2);
    },
    updateManualEditDefault: (value) => {
      if (!state.manualEditForm) state.manualEditForm = {};
      state.manualEditForm.default = value === true;
    },
    saveManualEdit,
    startSelectedRun,
    openFunctionCreator: async (page) => {
      state.functionCreatorOpen = true;
      state.functionResult = null;
      await navigateToPipelinePath(page, makePipelinePath("functions"));
    },
    closeFunctionCreator: (page) => updateField(page, "functionCreatorOpen", false),
    updateFunctionPrompt: (value) => { state.functionPrompt = value; },
    startFunctionWizard,
    openFunction: (page, name) => navigateToPipelinePath(page, makePipelinePath("functions", name)),
  };
}
