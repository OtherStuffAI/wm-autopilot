import type { SessionApiContext } from "../server/session-api-routes";

const MISSING_CLASSIFIER_KEY_ERROR = "Classifier OpenRouter API key is not configured. Configure the pipeline classifier OpenRouter key, an owner OpenRouter key, the instance OpenRouter runtime key, or a compatible OpenRouter environment variable.";

type EnvLike = Record<string, string | undefined>;

export interface ClassifierOpenRouterCredentialContext {
  ownerNpub: string | null;
  sessionApiContext: Pick<SessionApiContext, "userSettingsStore" | "getStoredInstanceSetting">;
  env?: EnvLike;
}

export function resolveClassifierOpenRouterApiKey(input: ClassifierOpenRouterCredentialContext): string {
  const env = input.env ?? process.env;
  const ownerSettings = input.ownerNpub && typeof input.sessionApiContext.userSettingsStore?.getAll === "function"
    ? input.sessionApiContext.userSettingsStore.getAll(input.ownerNpub)
    : {};
  const getStoredInstanceSetting = input.sessionApiContext.getStoredInstanceSetting;
  const candidates = [
    getStoredInstanceSetting?.("pipelines.classifier_openrouter_api_key"),
    env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY,
    ownerSettings.openrouter_api_key,
    getStoredInstanceSetting?.("integrations.openrouter_api_key"),
    ownerSettings.speech_api_key,
    ownerSettings.openai_api_key,
    env.OPENROUTER_API_KEY,
    env.OPENROUTER_API,
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return value;
  }
  throw new Error(MISSING_CLASSIFIER_KEY_ERROR);
}
