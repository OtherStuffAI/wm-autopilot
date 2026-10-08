import {
  deleteInstanceSetting,
  discoverHarnessModels,
  fetchInstanceSettings,
  saveInstanceSetting,
} from '../../services/instance-settings.js';
import {
  CLI_MODEL_HARNESSES,
  HARNESS_MODELS_SETTING_KEY,
  describeHarnessSource,
  effectiveModelsFromConfig,
  normalizeHarnessModelLines,
  readHarnessModelSettings,
  withHarnessModels,
} from './harness-model-settings.js';

async function fetchAgentConfig() {
  const response = await fetch('/api/config', { credentials: 'include' });
  if (!response.ok) throw new Error('Failed to load harness models');
  return response.json();
}

/** Claude Code and Codex model lists. Separate from the OpenRouter list used by Goose, OpenCode and Pi. */
export function createHarnessModelsSection(options = {}) {
  const loadSettings = options.loadSettings || fetchInstanceSettings;
  const loadConfig = options.loadConfig || fetchAgentConfig;
  const saveSetting = options.saveSetting || saveInstanceSetting;
  const deleteSetting = options.deleteSetting || deleteInstanceSetting;
  const discover = options.discover || discoverHarnessModels;

  const section = document.createElement('section');
  section.className = 'wm-card wm-model-settings';
  section.dataset.testid = 'harness-models-section';
  const heading = document.createElement('h2');
  heading.textContent = 'Claude Code & Codex models';
  const description = document.createElement('p');
  description.textContent = 'Models offered when launching Claude Code or Codex sessions. Refresh from CLI replaces the list with the models the installed CLI reports. If a selected model is unavailable at launch, the session falls back to the harness default.';
  section.append(heading, description);

  let settings = { harnesses: {} };

  const blocks = CLI_MODEL_HARNESSES.map(({ id, label }) => {
    const form = document.createElement('form');
    form.className = 'wm-model-settings__form';
    form.dataset.testid = `harness-models-${id}`;
    const title = document.createElement('h3');
    title.textContent = label;
    const source = document.createElement('p');
    source.className = 'wm-model-settings__source';
    source.dataset.testid = `harness-models-${id}-source`;
    const textLabel = document.createElement('label');
    textLabel.setAttribute('for', `harness-models-${id}-list`);
    textLabel.textContent = `${label} model IDs, one per line (first is listed first; "default" is always available)`;
    const textarea = document.createElement('textarea');
    textarea.id = `harness-models-${id}-list`;
    textarea.className = 'wm-input';
    textarea.rows = 8;
    textarea.spellcheck = false;
    textarea.dataset.testid = `harness-models-${id}-list`;
    const status = document.createElement('p');
    status.className = 'wm-model-settings__status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.dataset.testid = `harness-models-${id}-status`;

    const actions = document.createElement('div');
    actions.className = 'wm-settings-page__actions';
    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'wm-button secondary';
    refreshButton.textContent = 'Refresh from CLI';
    refreshButton.dataset.testid = `harness-models-${id}-refresh`;
    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'wm-button secondary';
    resetButton.textContent = 'Reset to defaults';
    resetButton.dataset.testid = `harness-models-${id}-reset`;
    const saveButton = document.createElement('button');
    saveButton.type = 'submit';
    saveButton.className = 'wm-button';
    saveButton.textContent = 'Save';
    saveButton.dataset.testid = `harness-models-${id}-save`;
    actions.append(refreshButton, resetButton, saveButton);
    form.append(title, source, textLabel, textarea, actions, status);

    const buttons = [refreshButton, resetButton, saveButton];
    function setBusy(busy) { buttons.forEach((button) => { button.disabled = busy; }); }
    function setStatus(message, error = false) {
      status.textContent = message;
      status.classList.toggle('is-error', error);
    }

    async function persist(nextSettings, successMessage) {
      setBusy(true);
      try {
        if (Object.keys(nextSettings.harnesses).length === 0) {
          await deleteSetting(HARNESS_MODELS_SETTING_KEY);
        } else {
          await saveSetting(HARNESS_MODELS_SETTING_KEY, JSON.stringify(nextSettings));
        }
        settings = nextSettings;
        await options.onSaved?.();
        await reload();
        setStatus(successMessage);
        options.notify?.(successMessage, { type: 'success' });
      } catch (error) {
        const message = error?.message || `Failed to save ${label} models`;
        setStatus(message, true);
        options.notify?.(message, { type: 'error' });
      } finally {
        setBusy(false);
      }
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      let models;
      try {
        models = normalizeHarnessModelLines(textarea.value, label);
      } catch (error) {
        setStatus(error.message, true);
        return;
      }
      await persist(
        withHarnessModels(settings, id, { models, source: 'manual', updatedAt: new Date().toISOString() }),
        `Saved ${models.length} ${label} model${models.length === 1 ? '' : 's'}.`,
      );
    });

    refreshButton.addEventListener('click', async () => {
      setBusy(true);
      setStatus(`Reading the ${label} CLI model list…`);
      let discovered;
      try {
        discovered = await discover(id);
      } catch (error) {
        setStatus(`${error?.message || 'CLI model discovery failed'} The current list is unchanged.`, true);
        setBusy(false);
        return;
      }
      await persist(
        withHarnessModels(settings, id, { models: discovered.models, source: 'cli', updatedAt: new Date().toISOString() }),
        `Loaded ${discovered.models.length} models from the ${label} CLI.`,
      );
    });

    resetButton.addEventListener('click', async () => {
      await persist(withHarnessModels(settings, id, null), `${label} models reset to built-in defaults.`);
    });

    section.append(form);
    return { id, source, textarea, setStatus, setBusy };
  });

  async function reload() {
    const [payload, config] = await Promise.all([loadSettings(), loadConfig()]);
    const setting = Array.isArray(payload?.settings)
      ? payload.settings.find((item) => item?.key === HARNESS_MODELS_SETTING_KEY)
      : null;
    settings = readHarnessModelSettings(setting?.value);
    blocks.forEach((block) => {
      const entry = settings.harnesses[block.id] || null;
      block.source.textContent = `Source: ${describeHarnessSource(entry)}`;
      block.textarea.value = (entry?.models || effectiveModelsFromConfig(config, block.id)).join('\n');
    });
  }

  blocks.forEach((block) => { block.setBusy(true); block.setStatus('Loading models…'); });
  reload()
    .then(() => blocks.forEach((block) => { block.setStatus(''); block.setBusy(false); }))
    .catch((error) => blocks.forEach((block) => block.setStatus(error?.message || 'Failed to load models', true)));
  return section;
}
