export const NIGHTWATCH_FEATURE_FLAG_KEY = "nightwatch_enabled";

export const NIGHTWATCH_DEFAULT_MODEL = "google/gemini-3-flash-preview";

export const NIGHTWATCH_MODELS = [
  "z-ai/glm-4.6v",
  "moonshotai/kimi-k2.5",
  "z-ai/glm-4.7-flash",
  "google/gemini-3-flash-preview",
  "x-ai/grok-4.1-fast",
  "anthropic/claude-sonnet-4.5",
] as const;

export const NIGHTWATCH_MAX_CYCLE_OPTIONS = [6, 21, 256] as const;

export const NIGHTWATCH_CHECK_IN_PROMPT = "Any progress?";
export const NIGHTWATCH_DEFAULT_INTERVAL_MINUTES = 5;
export const NIGHTWATCH_MIN_INTERVAL_MINUTES = 2;
export const NIGHTWATCH_MAX_INTERVAL_MINUTES = 60;
export const NIGHTWATCH_CHECK_IN_INTERVAL_MS = NIGHTWATCH_DEFAULT_INTERVAL_MINUTES * 60 * 1000;
export const NIGHTWATCH_RETRY_DELAY_MS = 60 * 1000;

export const NIGHTWATCH_DEFAULT_PROMPT =
  `Night Watchman sends "${NIGHTWATCH_CHECK_IN_PROMPT}" to enabled sessions every 5 minutes.`;

export function normalizeNightWatchPrompt(value: unknown): string {
  if (typeof value !== "string") return NIGHTWATCH_CHECK_IN_PROMPT;
  const trimmed = value.trim();
  return trimmed || NIGHTWATCH_CHECK_IN_PROMPT;
}

export function normalizeNightWatchIntervalMinutes(value: unknown): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return NIGHTWATCH_DEFAULT_INTERVAL_MINUTES;
  return Math.min(
    NIGHTWATCH_MAX_INTERVAL_MINUTES,
    Math.max(NIGHTWATCH_MIN_INTERVAL_MINUTES, Math.trunc(minutes)),
  );
}

export function getNextNightWatchPromptAt(
  intervalMinutes = NIGHTWATCH_DEFAULT_INTERVAL_MINUTES,
  baseMs = Date.now(),
): string {
  return new Date(baseMs + normalizeNightWatchIntervalMinutes(intervalMinutes) * 60 * 1000).toISOString();
}

export function getNightWatchRetryPromptAt(baseMs = Date.now()): string {
  return new Date(baseMs + NIGHTWATCH_RETRY_DELAY_MS).toISOString();
}
