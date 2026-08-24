export function createPipelinesState() {
  return {
    activeTab: "runs",
    root: null,
    definitions: [],
    functions: [],
    runs: [],
    selectedRun: null,
    selectedStep: null,
    selectedRunTab: "overview",
    agentOutputFormattingEnabled: false,
    selectedRunPayloadLoading: false,
    selectedRunPayloadError: null,
    selectedDefinitionId: "",
    runFilter: "all",
    definitionFilter: "all",
    runSearch: "",
    definitionSearch: "",
    runTagFilter: "",
    definitionTagFilter: "",
    launcherOpen: false,
    creatorOpen: false,
    wizardPrompt: "",
    wizardBusy: false,
    wizardResult: null,
    editDefinitionId: "",
    editPrompt: "",
    editBusy: false,
    editResult: null,
    manualEditDefinitionId: "",
    manualEditForm: {
      name: "",
      description: "",
      tagsText: "",
      default: false,
      inputText: "{}",
      stepsText: "[]",
    },
    manualEditBusy: false,
    manualEditResult: null,
    functionCreatorOpen: false,
    functionPrompt: "",
    functionBusy: false,
    functionResult: null,
    selectedFunctionName: "",
    selectedFunctionDetail: null,
    selectedFunctionLoading: false,
    runInputText: "",
    runningId: null,
    resumingRunId: null,
    cancellingRunId: null,
    loading: false,
    error: null,
  };
}

export function getSelectedDefinition(state) {
  return state.definitions.find((definition) => definition.id === state.selectedDefinitionId) ?? state.definitions[0] ?? null;
}

export function getRouteDefinition(state, route) {
  if (route.section === "definitions" && route.id) {
    return state.definitions.find((definition) => definition.id === route.id) ?? null;
  }
  return getSelectedDefinition(state);
}

export function ensureSelectedDefinition(state) {
  if (state.selectedDefinitionId && state.definitions.some((definition) => definition.id === state.selectedDefinitionId)) {
    return;
  }
  state.selectedDefinitionId = pickDefaultDefinitionId(state);
}

export function ensureRunInputForSelection(state, definition) {
  if (state.runInputText || !definition) return;
  state.runInputText = JSON.stringify(definition.input ?? {}, null, 2);
}

export function parseRunInput(state) {
  const text = state.runInputText.trim();
  if (!text) return null;
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Run input must be a JSON object");
  }
  return parsed;
}

export function hasRunPayload(run) {
  if (!run) return false;
  return Object.prototype.hasOwnProperty.call(run, "input")
    || Object.prototype.hasOwnProperty.call(run, "current")
    || Object.prototype.hasOwnProperty.call(run, "result");
}

export function pickDefaultDefinitionId(state) {
  return state.definitions.find((definition) => definition.name === "do-and-review")?.id
    ?? state.definitions[0]?.id
    ?? "";
}

export function normalizeTab(tab) {
  if (tab === "definitions" || tab === "functions") return tab;
  return "runs";
}
