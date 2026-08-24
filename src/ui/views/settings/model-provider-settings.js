export const MODEL_PROVIDERS_SETTING_KEY = 'models.providers';
export const FALLBACK_OPENROUTER_MODELS = [
  'qwen/qwen3.7-flash',
  'anthropic/claude-opus-5-fast',
  'google/gemini-3.6-flash',
  'thinkingmachines/inkling',
];

const MODEL_ID_PART = '[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?';
const OPENROUTER_MODEL_ID_PATTERN = new RegExp(`^${MODEL_ID_PART}/${MODEL_ID_PART}$`);

export function normalizeOpenRouterModelLines(input) {
  const models = [];
  const seen = new Set();
  String(input || '').split(/\r?\n/).forEach((line, index) => {
    const model = line.trim();
    if (!model) return;
    if (!OPENROUTER_MODEL_ID_PATTERN.test(model)) {
      throw new Error(
        `Line ${index + 1} must use provider/model format (for example, anthropic/claude-sonnet-4)`,
      );
    }
    if (model.toLowerCase().startsWith('openrouter/')) {
      throw new Error(`Line ${index + 1} must omit the openrouter/ prefix`);
    }
    if (!seen.has(model)) {
      seen.add(model);
      models.push(model);
    }
  });
  if (models.length === 0) {
    throw new Error('Add at least one OpenRouter model ID');
  }
  return models;
}

export function serializeModelProviderSettings(input) {
  return JSON.stringify({
    providers: {
      openrouter: { models: normalizeOpenRouterModelLines(input) },
    },
  });
}

export function readOpenRouterModelsSetting(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const payload = JSON.parse(value);
  const models = payload?.providers?.openrouter?.models;
  if (!Array.isArray(models) || models.some((model) => typeof model !== 'string')) {
    throw new Error('Saved model settings do not contain an OpenRouter models list');
  }
  return normalizeOpenRouterModelLines(models.join('\n'));
}
