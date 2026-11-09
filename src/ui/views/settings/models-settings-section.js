import { fetchInstanceSettings, saveInstanceSetting } from '../../services/instance-settings.js';
import {
  FALLBACK_OPENROUTER_MODELS,
  MODEL_PROVIDERS_SETTING_KEY,
  normalizeOpenRouterModelLines,
  readOpenRouterModelsSetting,
  serializeModelProviderSettings,
} from './model-provider-settings.js';

function settingSourceLabel(setting) {
  const source = setting?.source || setting?.effectiveSource;
  if (!source) return 'Built-in compatibility default';
  return String(source).replace(/_/g, ' ');
}

export function moveModel(models, fromIndex, direction) {
  const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
  if (fromIndex < 0 || fromIndex >= models.length || toIndex < 0 || toIndex >= models.length) return models;
  const next = [...models];
  [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
  return next;
}

export function createModelsSettingsSection(options = {}) {
  const loadSettings = options.loadSettings || fetchInstanceSettings;
  const saveSetting = options.saveSetting || saveInstanceSetting;
  const section = document.createElement('section');
  section.className = 'wm-card wm-model-settings';
  section.dataset.testid = 'models-settings-section';

  const heading = document.createElement('h2');
  heading.textContent = 'OpenRouter launch order';
  const description = document.createElement('p');
  description.textContent = 'The first configured row is the default choice; later rows are ordered fallbacks. Configured does not imply current provider availability.';
  const provider = document.createElement('p');
  provider.className = 'wm-model-settings__provider';
  provider.dataset.testid = 'models-provider';
  provider.textContent = 'Provider: OpenRouter';
  const source = document.createElement('p');
  source.className = 'wm-model-settings__source';
  source.dataset.testid = 'models-source';

  const form = document.createElement('form');
  form.className = 'wm-model-settings__form';
  const rows = document.createElement('div');
  rows.className = 'wm-model-settings__rows';
  rows.dataset.testid = 'models-structured-rows';

  const rowActions = document.createElement('div');
  rowActions.className = 'wm-settings-page__actions';
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'wm-button secondary';
  addButton.textContent = 'Add model';
  addButton.dataset.testid = 'models-add';
  addButton.setAttribute('aria-label', 'Add OpenRouter model row');
  rowActions.append(addButton);

  const advanced = document.createElement('details');
  advanced.className = 'wm-settings-disclosure wm-model-settings__advanced';
  const advancedSummary = document.createElement('summary');
  advancedSummary.textContent = 'Edit as text';
  const textLabel = document.createElement('label');
  textLabel.setAttribute('for', 'openrouter-model-list');
  textLabel.textContent = 'OpenRouter model IDs, one per line';
  const textarea = document.createElement('textarea');
  textarea.id = 'openrouter-model-list';
  textarea.className = 'wm-input';
  textarea.rows = 9;
  textarea.spellcheck = false;
  textarea.dataset.testid = 'models-openrouter-list';
  textarea.setAttribute('aria-describedby', 'openrouter-model-help openrouter-model-status');
  const textHelp = document.createElement('p');
  textHelp.id = 'openrouter-model-help';
  textHelp.className = 'wm-model-settings__help';
  textHelp.textContent = 'Use provider/model IDs without an openrouter/ prefix. Applying text updates the draft rows; it does not save.';
  const applyTextButton = document.createElement('button');
  applyTextButton.type = 'button';
  applyTextButton.className = 'wm-button secondary';
  applyTextButton.textContent = 'Apply text to draft';
  applyTextButton.dataset.testid = 'models-apply-text';
  advanced.append(advancedSummary, textLabel, textarea, textHelp, applyTextButton);

  const status = document.createElement('p');
  status.id = 'openrouter-model-status';
  status.className = 'wm-model-settings__status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.dataset.testid = 'models-save-status';
  status.textContent = 'Loading models…';
  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'wm-button';
  saveButton.textContent = 'Save models';
  saveButton.dataset.testid = 'models-save';
  saveButton.setAttribute('aria-label', 'Save ordered OpenRouter launch models');
  saveButton.disabled = true;
  form.append(rows, rowActions, advanced, status, saveButton);

  let models = [];
  let savedModels = [];
  let dragIndex = null;

  function setStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('is-error', error);
  }

  function markDirty(message = 'Unsaved model order.') {
    textarea.value = models.join('\n');
    setStatus(message);
  }

  function renderRows({ focusIndex = null } = {}) {
    rows.replaceChildren();
    models.forEach((model, index) => {
      const row = document.createElement('div');
      row.className = 'wm-model-settings__row';
      row.draggable = true;
      row.dataset.modelIndex = String(index);
      const handle = document.createElement('span');
      handle.className = 'wm-model-settings__drag';
      handle.textContent = '⋮⋮';
      handle.title = 'Drag to reorder; keyboard buttons are also available.';
      handle.setAttribute('aria-hidden', 'true');
      const input = document.createElement('input');
      input.className = 'wm-input';
      input.value = model;
      input.dataset.testid = `models-row-${index}`;
      input.setAttribute('aria-label', `OpenRouter model ${index + 1}`);
      input.addEventListener('input', () => {
        models[index] = input.value;
        markDirty('Unsaved model change.');
      });
      const role = document.createElement('span');
      role.className = 'wm-model-settings__role';
      role.textContent = index === 0 ? 'Default' : `Fallback ${index}`;
      const reorder = document.createElement('div');
      reorder.className = 'wm-model-settings__reorder';
      reorder.setAttribute('aria-label', `Reorder ${model || `model ${index + 1}`}`);
      ['up', 'down'].forEach((direction) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wm-button secondary';
        button.textContent = direction === 'up' ? '↑' : '↓';
        button.disabled = direction === 'up' ? index === 0 : index === models.length - 1;
        button.dataset.testid = `models-move-${direction}-${index}`;
        button.setAttribute('aria-label', `Move ${model || `model ${index + 1}`} ${direction}`);
        button.addEventListener('click', () => {
          const nextIndex = direction === 'up' ? index - 1 : index + 1;
          models = moveModel(models, index, direction);
          renderRows({ focusIndex: nextIndex });
          markDirty(`${model || 'Model'} moved to position ${nextIndex + 1}. Unsaved.`);
        });
        reorder.append(button);
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'wm-button secondary';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${model || `model ${index + 1}`}`);
      remove.addEventListener('click', () => {
        models = models.filter((_, candidateIndex) => candidateIndex !== index);
        renderRows({ focusIndex: Math.min(index, models.length - 1) });
        markDirty(`${model || 'Model'} removed from the draft.`);
      });
      row.addEventListener('dragstart', () => { dragIndex = index; });
      row.addEventListener('dragover', (event) => event.preventDefault());
      row.addEventListener('drop', (event) => {
        event.preventDefault();
        if (dragIndex === null || dragIndex === index) return;
        const moved = models[dragIndex];
        const next = [...models];
        next.splice(dragIndex, 1);
        next.splice(index, 0, moved);
        models = next;
        dragIndex = null;
        renderRows({ focusIndex: index });
        markDirty(`${moved} moved to position ${index + 1}. Unsaved.`);
      });
      row.append(handle, input, role, reorder, remove);
      rows.append(row);
    });
    if (focusIndex !== null && focusIndex >= 0) rows.querySelector?.(`[data-testid="models-row-${focusIndex}"]`)?.focus();
  }

  addButton.addEventListener('click', () => {
    models = [...models, ''];
    renderRows({ focusIndex: models.length - 1 });
    markDirty('New model row added. Enter a provider/model ID before saving.');
  });

  applyTextButton.addEventListener('click', () => {
    try {
      models = normalizeOpenRouterModelLines(textarea.value);
      renderRows();
      markDirty('Text applied to the draft. Save to make it effective.');
    } catch (error) {
      setStatus(error?.message || 'Invalid model list', true);
      textarea.setAttribute('aria-invalid', 'true');
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    let value;
    try {
      value = serializeModelProviderSettings(models.join('\n'));
      textarea.setAttribute('aria-invalid', 'false');
    } catch (error) {
      const message = error?.message || 'Invalid model list';
      setStatus(message, true);
      options.notify?.(message, { type: 'error' });
      return;
    }
    saveButton.disabled = true;
    setStatus('Saving models…');
    try {
      await saveSetting(MODEL_PROVIDERS_SETTING_KEY, value);
      models = readOpenRouterModelsSetting(value);
      savedModels = [...models];
      renderRows();
      textarea.value = models.join('\n');
      await options.onSaved?.();
      const message = `Saved ${models.length} OpenRouter model${models.length === 1 ? '' : 's'}.`;
      setStatus(message);
      options.notify?.(message, { type: 'success' });
    } catch (error) {
      const message = error?.message || 'Failed to save models';
      models = models.length ? models : [...savedModels];
      setStatus(`${message} The last saved model list remains effective; this draft is available to retry.`, true);
      options.notify?.(message, { type: 'error' });
    } finally {
      saveButton.disabled = false;
    }
  });

  async function load() {
    try {
      const payload = await loadSettings();
      const setting = Array.isArray(payload?.settings)
        ? payload.settings.find((item) => item?.key === MODEL_PROVIDERS_SETTING_KEY)
        : null;
      const configured = readOpenRouterModelsSetting(setting?.value);
      models = [...(configured || FALLBACK_OPENROUTER_MODELS)];
      savedModels = [...models];
      source.textContent = `Effective source: ${settingSourceLabel(setting)}`;
      textarea.value = models.join('\n');
      renderRows();
      setStatus(configured
        ? `${models.length} configured model${models.length === 1 ? '' : 's'} loaded.`
        : 'Using compatibility defaults until this list is saved.');
      saveButton.disabled = false;
    } catch (error) {
      source.textContent = 'Effective source unavailable';
      setStatus(error?.message || 'Failed to load models', true);
    }
  }

  section.append(heading, description, provider, source, form);
  void load();
  return section;
}
