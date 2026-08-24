import {
  DEFAULT_MODEL_OPTION,
  getModelOptionLabel,
  getModelOptionsForAgent,
  modelValueForPayload,
} from "../common/agent-model-lookups.js";

const DIRECTORY_FIELDS = new Set(["workingDirectory", "watchDirectory"]);

export function createSchedulerFormSupport({ getConfig, getDefaultAgent, openDirectoryBrowser }) {
  function modelOptions(agent) {
    return getModelOptionsForAgent(getConfig?.(), agent);
  }

  function defaultModel(agent) {
    const options = modelOptions(agent);
    return options.includes(DEFAULT_MODEL_OPTION) ? DEFAULT_MODEL_OPTION : (options[0] ?? "");
  }

  function syncModel(form) {
    if (!form || typeof form !== "object") return;
    const options = modelOptions(form.agent);
    if (!options.includes(form.model)) {
      form.model = defaultModel(form.agent);
    }
  }

  function createFormValues() {
    const agent = getDefaultAgent();
    return {
      name: "",
      agent,
      model: defaultModel(agent),
      workingDirectory: "",
      initialPrompt: "",
      pipelineDefinitionId: "",
      pipelineAgent: "",
      pipelineInput: "{}",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      watchDirectory: "",
      filePattern: "*",
      activeStartTime: "",
      activeEndTime: "",
    };
  }

  async function browseDirectory(form, field, title) {
    if (!form || typeof form !== "object" || !DIRECTORY_FIELDS.has(field)) {
      throw new Error(`Unsupported scheduler directory field: ${field}`);
    }
    if (typeof openDirectoryBrowser !== "function") {
      throw new Error("The scheduler directory browser is unavailable");
    }
    await openDirectoryBrowser({
      initialPath: form[field]?.trim() || getConfig?.()?.defaultDirectory || "",
      title,
      confirmLabel: "Use This Directory",
      allowCreate: true,
      onSelect: (path) => {
        form[field] = path;
      },
    });
  }

  return {
    browseDirectory,
    createFormValues,
    defaultModel,
    getModelOptionLabel,
    modelForPayload: modelValueForPayload,
    modelOptions,
    syncModel,
  };
}
