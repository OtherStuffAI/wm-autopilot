export const DEFAULT_MODEL_OPTION = 'default';

function dedupeValues(values) {
  const unique = new Set();
  values.forEach((value) => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) unique.add(normalized);
  });
  return Array.from(unique);
}

export function getAvailableHarnesses(config) {
  if (!Array.isArray(config?.agents)) return [];
  return config.agents.flatMap((agent) => {
    const id = typeof agent?.id === 'string' ? agent.id.trim() : '';
    if (!id) return [];
    const label = typeof agent?.label === 'string' ? agent.label.trim() : '';
    return [{ id, label: label || id }];
  });
}

export function getModelOptionsForAgent(config, agentId) {
  const configuredAgent = Array.isArray(config?.agents)
    ? config.agents.find((agent) => agent?.id === agentId)
    : null;
  const configuredModels = Array.isArray(configuredAgent?.modelOptions)
    ? configuredAgent.modelOptions
    : [];
  return dedupeValues(configuredModels);
}

export function getModelOptionLabel(model) {
  switch (model) {
    case DEFAULT_MODEL_OPTION:
      return 'Default';
    case 'opus':
      return 'Opus';
    case 'sonnet':
      return 'Sonnet';
    case 'sonnet[1m]':
      return 'Sonnet (1M Cntx)';
    case 'haiku':
      return 'Haiku';
    case 'DeepSeek V4 Flash':
      return 'DeepSeek V4 Flash (Maple Desktop default)';
    default:
      return model;
  }
}

export function modelValueForPayload(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized !== DEFAULT_MODEL_OPTION ? normalized : null;
}

function appendOption(select, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.append(option);
}

export function createAgentModelLookupController({ harnessSelect, modelSelect, status }) {
  let config = null;

  function setStatus(message) {
    if (status) status.textContent = message;
  }

  function syncModels(selectedModel = modelSelect.value) {
    const harnessId = harnessSelect.value;
    const models = getModelOptionsForAgent(config, harnessId);
    modelSelect.replaceChildren();
    if (!harnessId) {
      appendOption(modelSelect, '', 'Select a harness first');
      modelSelect.disabled = true;
      setStatus(getAvailableHarnesses(config).length ? 'Select a harness to load its models.' : 'No harnesses are available.');
      return;
    }
    if (!models.length) {
      appendOption(modelSelect, '', 'No models available');
      modelSelect.disabled = true;
      setStatus(`No models are configured for ${harnessSelect.options[harnessSelect.selectedIndex]?.textContent || harnessId}.`);
      return;
    }
    models.forEach((model) => appendOption(modelSelect, model, getModelOptionLabel(model)));
    modelSelect.disabled = false;
    modelSelect.value = models.includes(selectedModel) ? selectedModel : models[0];
    setStatus('');
  }

  function setConfig(nextConfig, { harness = '', model = '' } = {}) {
    config = nextConfig;
    const harnesses = getAvailableHarnesses(config);
    harnessSelect.replaceChildren();
    if (!harnesses.length) {
      appendOption(harnessSelect, '', 'No harnesses available');
      harnessSelect.disabled = true;
      syncModels('');
      return;
    }
    harnesses.forEach((item) => appendOption(harnessSelect, item.id, item.label));
    harnessSelect.disabled = false;
    harnessSelect.value = harnesses.some((item) => item.id === harness) ? harness : harnesses[0].id;
    syncModels(model || DEFAULT_MODEL_OPTION);
  }

  function setLoading() {
    config = null;
    harnessSelect.replaceChildren();
    appendOption(harnessSelect, '', 'Loading harnesses...');
    harnessSelect.disabled = true;
    modelSelect.replaceChildren();
    appendOption(modelSelect, '', 'Loading models...');
    modelSelect.disabled = true;
    setStatus('Loading available harnesses and models...');
  }

  function setUnavailable(message = 'Harness and model options are unavailable.') {
    config = null;
    harnessSelect.replaceChildren();
    appendOption(harnessSelect, '', 'Harnesses unavailable');
    harnessSelect.disabled = true;
    modelSelect.replaceChildren();
    appendOption(modelSelect, '', 'Models unavailable');
    modelSelect.disabled = true;
    setStatus(message);
  }

  harnessSelect.addEventListener('change', () => syncModels(''));
  setLoading();
  return { setConfig, setLoading, setUnavailable, syncModels };
}
