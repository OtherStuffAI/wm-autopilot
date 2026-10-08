/**
 * Editable model lists for harnesses whose CLIs publish their own model
 * catalogue (Claude Code and Codex). These are distinct from the OpenRouter
 * provider list in `models.providers`, which serves Goose, OpenCode and Pi.
 */

export const HARNESS_MODELS_SETTING_KEY = "models.harnesses";
export const CLI_MODEL_HARNESSES = ["claude", "codex"] as const;
export type CliModelHarness = typeof CLI_MODEL_HARNESSES[number];

const DEFAULT_MODEL_OPTION = "default";
const MAX_MODEL_ID_LENGTH = 128;
// Allows full IDs (claude-opus-5-5, gpt-6.1-sol) and CLI aliases (sonnet[1m]).
const HARNESS_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/;

export interface HarnessModelList {
  models: string[];
  source: "cli" | "manual";
  updatedAt: string;
}

export interface HarnessModelSettings {
  harnesses: Partial<Record<CliModelHarness, HarnessModelList>>;
}

export function isCliModelHarness(value: string): value is CliModelHarness {
  return (CLI_MODEL_HARNESSES as readonly string[]).includes(value);
}

/** Trim, dedupe and validate model IDs. `default` is implicit and dropped. */
export function normalizeHarnessModelList(models: readonly unknown[], harness: string): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  models.forEach((raw, index) => {
    if (typeof raw !== "string") {
      throw new Error(`${harness} model ${index + 1} must be a string`);
    }
    const model = raw.trim();
    if (!model || model.toLowerCase() === DEFAULT_MODEL_OPTION) return;
    if (model.length > MAX_MODEL_ID_LENGTH || !HARNESS_MODEL_ID_PATTERN.test(model)) {
      throw new Error(`${harness} model "${model}" is not a valid model ID`);
    }
    if (seen.has(model)) return;
    seen.add(model);
    normalized.push(model);
  });
  if (normalized.length === 0) {
    throw new Error(`Add at least one ${harness} model`);
  }
  return normalized;
}

export function parseHarnessModelSettings(value: string): HarnessModelSettings {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new Error("Harness models setting must be valid JSON");
  }
  const harnesses = asRecord(asRecord(payload)?.harnesses);
  if (!harnesses) {
    throw new Error("Harness models setting must contain a harnesses object");
  }

  const settings: HarnessModelSettings = { harnesses: {} };
  for (const [harness, entry] of Object.entries(harnesses)) {
    if (!isCliModelHarness(harness)) {
      throw new Error(`Unsupported harness "${harness}"; expected one of ${CLI_MODEL_HARNESSES.join(", ")}`);
    }
    const record = asRecord(entry);
    if (!record || !Array.isArray(record.models)) {
      throw new Error(`${harness} must contain a models list`);
    }
    settings.harnesses[harness] = {
      models: normalizeHarnessModelList(record.models, harness),
      source: record.source === "cli" ? "cli" : "manual",
      updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim()
        ? record.updatedAt.trim()
        : new Date(0).toISOString(),
    };
  }
  return settings;
}

export function serializeHarnessModelSettings(settings: HarnessModelSettings): string {
  return JSON.stringify(parseHarnessModelSettings(JSON.stringify(settings)));
}

/** Saved list for the harness when present; otherwise null (use built-ins). */
export function getConfiguredHarnessModels(harness: string, settingValue: string | null): string[] | null {
  if (settingValue === null || !isCliModelHarness(harness)) return null;
  try {
    return parseHarnessModelSettings(settingValue).harnesses[harness]?.models ?? null;
  } catch (error) {
    console.warn(`[harness-models] ignoring invalid ${HARNESS_MODELS_SETTING_KEY}: ${(error as Error).message}`);
    return null;
  }
}

/** Selectable options for a harness: `default` followed by the saved or built-in list. */
export function resolveHarnessModelOptions(
  harness: string,
  builtInOptions: readonly string[],
  settingValue: string | null,
): string[] {
  const configured = getConfiguredHarnessModels(harness, settingValue);
  if (configured === null) return [...builtInOptions];
  return [DEFAULT_MODEL_OPTION, ...configured];
}

/**
 * Pre-launch guard: a requested model outside the harness's current list
 * launches on the harness default instead.
 */
export function resolveLaunchModelForHarness(
  harness: string,
  requestedModel: string,
  options: readonly string[],
): { model: string; fallbackFrom: string | null } {
  const requested = requestedModel.trim();
  if (!requested || !isCliModelHarness(harness) || options.includes(requested)) {
    return { model: requested, fallbackFrom: null };
  }
  return { model: "", fallbackFrom: requested };
}

const MODEL_UNAVAILABLE_PATTERNS = [
  /issue with the selected model/i,
  /unrecognized_model/i,
  /model\b[^.]*\b(is not supported|not found|does not exist|is not available|unavailable|not available)/i,
  /\b(unknown|invalid|unsupported) model\b/i,
];

/** True when a harness error says the selected model cannot be used. */
export function isModelUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return MODEL_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
