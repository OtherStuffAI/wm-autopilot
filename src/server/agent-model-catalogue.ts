import { resolveAgentModelOptions } from "../settings/openrouter-models";

export interface AgentModelCatalogueEntry {
  id: string;
  label: string;
  modelOptions: string[];
}

export function resolveAgentModelCatalogue(
  agents: Record<string, { label: string; modelOptions?: string[] }> | undefined,
  modelProviderSetting: string | null,
): AgentModelCatalogueEntry[] {
  return Object.entries(agents ?? {}).map(([id, definition]) => ({
    id,
    label: definition.label,
    modelOptions: resolveAgentModelOptions(
      id,
      Array.isArray(definition.modelOptions) ? definition.modelOptions : ["default"],
      modelProviderSetting,
    ),
  }));
}
