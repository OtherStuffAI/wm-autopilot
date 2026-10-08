export const HARNESS_MODELS_SETTING_KEY = 'models.harnesses';
export const CLI_MODEL_HARNESSES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

const DEFAULT_MODEL_OPTION = 'default';
const HARNESS_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/;

/** One model ID per line; `default` is implicit and dropped. Mirrors src/settings/harness-models.ts. */
export function normalizeHarnessModelLines(input, label = 'Harness') {
  const models = [];
  const seen = new Set();
  String(input || '').split(/\r?\n/).forEach((line, index) => {
    const model = line.trim();
    if (!model || model.toLowerCase() === DEFAULT_MODEL_OPTION) return;
    if (model.length > 128 || !HARNESS_MODEL_ID_PATTERN.test(model)) {
      throw new Error(`${label} line ${index + 1} is not a valid model ID`);
    }
    if (!seen.has(model)) {
      seen.add(model);
      models.push(model);
    }
  });
  if (models.length === 0) throw new Error(`Add at least one ${label} model`);
  return models;
}

export function readHarnessModelSettings(value) {
  if (typeof value !== 'string' || !value.trim()) return { harnesses: {} };
  const payload = JSON.parse(value);
  const harnesses = payload && typeof payload.harnesses === 'object' && !Array.isArray(payload.harnesses)
    ? payload.harnesses
    : {};
  return { harnesses };
}

/** Returns the serialized setting with one harness replaced, or removed when `entry` is null. */
export function withHarnessModels(settings, harness, entry) {
  const harnesses = { ...(settings?.harnesses || {}) };
  if (entry) harnesses[harness] = entry;
  else delete harnesses[harness];
  return { harnesses };
}

/** Effective options currently served by /api/config, without the implicit default. */
export function effectiveModelsFromConfig(config, harness) {
  const agent = Array.isArray(config?.agents) ? config.agents.find((item) => item?.id === harness) : null;
  const options = Array.isArray(agent?.modelOptions) ? agent.modelOptions : [];
  return options.filter((model) => typeof model === 'string' && model !== DEFAULT_MODEL_OPTION);
}

export function describeHarnessSource(entry) {
  if (!entry) return 'Built-in defaults';
  const when = entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : 'unknown time';
  return entry.source === 'cli' ? `Refreshed from CLI · ${when}` : `Edited manually · ${when}`;
}
