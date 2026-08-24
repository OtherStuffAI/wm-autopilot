import type { AgentType } from "../agent-types";

export const MODEL_PROVIDERS_SETTING_KEY = "models.providers";
export const OPENROUTER_PROVIDER_ID = "openrouter";

const DEFAULT_MODEL_OPTION = "default";
const OPENROUTER_AGENT_TYPES = new Set<AgentType>(["goose", "opencode", "pi"]);
const MODEL_ID_PART = "[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?";
const OPENROUTER_MODEL_ID_PATTERN = new RegExp(`^${MODEL_ID_PART}/${MODEL_ID_PART}$`);

export interface UnsupportedOpenCodeModel {
  model: string;
  reason: string;
}

export interface OpenCodeOpenRouterModelAvailability {
  available: string[];
  unsupported: UnsupportedOpenCodeModel[];
}

export interface ModelProviderSettings {
  providers: {
    openrouter: {
      models: string[];
    };
  };
}

export function normalizeOpenRouterModelLines(input: string): string[] {
  const models: string[] = [];
  const seen = new Set<string>();
  const lines = input.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const model = lines[index]?.trim() ?? "";
    if (!model) continue;
    if (!OPENROUTER_MODEL_ID_PATTERN.test(model)) {
      throw new Error(
        `OpenRouter model on line ${index + 1} must use provider/model format (for example, anthropic/claude-sonnet-4)`,
      );
    }
    if (model.toLowerCase().startsWith(`${OPENROUTER_PROVIDER_ID}/`)) {
      throw new Error(
        `OpenRouter model on line ${index + 1} must omit the openrouter/ prefix`,
      );
    }
    if (seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }

  if (models.length === 0) {
    throw new Error("Add at least one OpenRouter model ID");
  }
  return models;
}

export function resolveOpenCodeOpenRouterModelAvailability(
  models: readonly string[],
): OpenCodeOpenRouterModelAvailability {
  const available: string[] = [];
  const unsupported: UnsupportedOpenCodeModel[] = [];
  const seen = new Set<string>();

  for (const rawModel of models) {
    const model = rawModel.trim();
    let reason = "";
    if (!model) {
      reason = "OpenCode model IDs cannot be empty";
    } else if (model.toLowerCase().startsWith(`${OPENROUTER_PROVIDER_ID}/`)) {
      reason = "OpenCode OpenRouter model IDs must omit the openrouter/ prefix";
    } else if (model.includes("#")) {
      reason = "OpenCode model variants are not supported in Autopilot OpenRouter availability";
    } else if (!OPENROUTER_MODEL_ID_PATTERN.test(model)) {
      reason = "OpenCode OpenRouter models must use provider/model format";
    }

    if (reason) {
      unsupported.push({ model, reason });
      continue;
    }
    if (seen.has(model)) continue;
    seen.add(model);
    available.push(model);
  }

  return { available, unsupported };
}

export function serializeModelProviderSettings(models: string[]): string {
  const normalized = normalizeOpenRouterModelLines(models.join("\n"));
  return JSON.stringify({
    providers: {
      openrouter: { models: normalized },
    },
  } satisfies ModelProviderSettings);
}

export function parseModelProviderSettings(value: string): ModelProviderSettings {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new Error("Model providers setting must be valid JSON");
  }

  const record = asRecord(payload);
  const providers = asRecord(record?.providers);
  const openrouter = asRecord(providers?.openrouter);
  const models = openrouter?.models;
  if (!Array.isArray(models) || models.some((model) => typeof model !== "string")) {
    throw new Error("Model providers setting must contain an OpenRouter models list");
  }

  return JSON.parse(serializeModelProviderSettings(models)) as ModelProviderSettings;
}

export function getConfiguredOpenRouterModels(value: string | null): string[] | null {
  return value === null
    ? null
    : parseModelProviderSettings(value).providers.openrouter.models;
}

export function resolveAgentModelOptions(
  agent: string,
  legacyOptions: string[],
  settingValue: string | null,
): string[] {
  if (!OPENROUTER_AGENT_TYPES.has(agent as AgentType)) {
    return legacyOptions;
  }
  const configured = getConfiguredOpenRouterModels(settingValue);
  if (configured === null) return legacyOptions;
  const models = agent === "opencode"
    ? resolveOpenCodeOpenRouterModelAvailability(configured).available
    : configured;
  return [DEFAULT_MODEL_OPTION, ...models];
}

export function resolveRuntimeModel(
  agent: AgentType,
  selectedModel: string,
  configuredModels: string[] | null,
): string {
  const selected = selectedModel.trim();
  if (!selected || selected.toLowerCase() === DEFAULT_MODEL_OPTION) return "";

  const relative = selected.toLowerCase().startsWith(`${OPENROUTER_PROVIDER_ID}/`)
    ? selected.slice(OPENROUTER_PROVIDER_ID.length + 1)
    : selected;
  const isConfiguredOpenRouterModel = configuredModels?.includes(relative) ?? false;

  if (agent === "goose") {
    return relative;
  }
  if (agent === "opencode" && configuredModels !== null) {
    if (!isConfiguredOpenRouterModel) {
      throw new Error(
        `OpenCode model "${selected}" is not in the configured Autopilot OpenRouter model list`,
      );
    }
    const availability = resolveOpenCodeOpenRouterModelAvailability([relative]);
    const unsupported = availability.unsupported[0];
    if (unsupported) {
      throw new Error(`OpenCode model "${selected}" is unsupported: ${unsupported.reason}`);
    }
    return `${OPENROUTER_PROVIDER_ID}/${relative}`;
  }
  if (agent === "pi" && isConfiguredOpenRouterModel) {
    return `${OPENROUTER_PROVIDER_ID}/${relative}`;
  }
  return selected;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
