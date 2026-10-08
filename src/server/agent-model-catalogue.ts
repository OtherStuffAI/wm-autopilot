import { HARNESS_MODELS_SETTING_KEY, resolveHarnessModelOptions } from "../settings/harness-models";
import { MODEL_PROVIDERS_SETTING_KEY, resolveAgentModelOptions } from "../settings/openrouter-models";

export interface AgentModelCatalogueEntry {
  id: string;
  label: string;
  modelOptions: string[];
}

/** Model-related instance setting values that shape each harness's options. */
export interface AgentModelSettingValues {
  /** `models.providers` — OpenRouter models for Goose, OpenCode and Pi. */
  modelProviders: string | null;
  /** `models.harnesses` — CLI-sourced or saved lists for Claude and Codex. */
  harnessModels: string | null;
}

export function readAgentModelSettings(settings: { get(key: string): string | null }): AgentModelSettingValues {
  return {
    modelProviders: settings.get(MODEL_PROVIDERS_SETTING_KEY),
    harnessModels: settings.get(HARNESS_MODELS_SETTING_KEY),
  };
}

export function resolveAgentModelCatalogue(
  agents: Record<string, { label: string; modelOptions?: string[] }> | undefined,
  settings: AgentModelSettingValues,
): AgentModelCatalogueEntry[] {
  return Object.entries(agents ?? {}).map(([id, definition]) => {
    const builtIn = Array.isArray(definition.modelOptions) ? definition.modelOptions : ["default"];
    return {
      id,
      label: definition.label,
      modelOptions: resolveAgentModelOptions(
        id,
        resolveHarnessModelOptions(id, builtIn, settings.harnessModels),
        settings.modelProviders,
      ),
    };
  });
}
