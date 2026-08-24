import {
  OPENROUTER_PROVIDER_ID,
  resolveOpenCodeOpenRouterModelAvailability,
} from "../settings/openrouter-models";

type JsonObject = Record<string, unknown>;

export const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";

export function withOpenCodeModelConfigEnvironment(
  env: Record<string, string> | undefined,
  configuredModels: readonly string[],
  inheritedContent?: string,
): Record<string, string> {
  const existingContent = env?.[OPENCODE_CONFIG_CONTENT_ENV] ?? inheritedContent;
  return {
    ...env,
    [OPENCODE_CONFIG_CONTENT_ENV]: buildOpenCodeModelConfigContent(
      configuredModels,
      existingContent,
    ),
  };
}

export function buildOpenCodeModelConfigContent(
  configuredModels: readonly string[],
  existingContent?: string,
): string {
  const availability = resolveOpenCodeOpenRouterModelAvailability(configuredModels);
  if (availability.unsupported.length > 0) {
    const details = availability.unsupported
      .map(({ model, reason }) => `${model || "<empty>"}: ${reason}`)
      .join("; ");
    throw new Error(`Cannot configure OpenCode OpenRouter models: ${details}`);
  }

  const existingConfig = parseExistingConfig(existingContent);
  const providers = readOptionalObject(existingConfig, "provider");
  const openrouter = readOptionalObject(providers, OPENROUTER_PROVIDER_ID);
  const existingModels = readOptionalObject(openrouter, "models");
  const configuredEntries = Object.fromEntries(
    availability.available.map((model) => [model, existingModels[model] ?? {}]),
  );

  return JSON.stringify({
    ...existingConfig,
    provider: {
      ...providers,
      [OPENROUTER_PROVIDER_ID]: {
        ...openrouter,
        models: {
          ...existingModels,
          ...configuredEntries,
        },
      },
    },
  });
}

function parseExistingConfig(content?: string): JsonObject {
  const value = content?.trim();
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${OPENCODE_CONFIG_CONTENT_ENV} must contain valid JSON`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`${OPENCODE_CONFIG_CONTENT_ENV} must contain a JSON object`);
  }
  return parsed;
}

function readOptionalObject(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (value === undefined) return {};
  if (!isJsonObject(value)) {
    throw new Error(`${OPENCODE_CONFIG_CONTENT_ENV} field "${key}" must be a JSON object`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
