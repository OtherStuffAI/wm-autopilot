/**
 * Workspace settings sections shared by the Settings view.
 */

import {
  deleteUserSetting,
  fetchUserSettings,
  saveUserSetting,
} from '../../services/user-settings.js';

function loadUserSettings() {
  return fetchUserSettings().catch(() => ({}));
}

function createRowLabel(text, minWidth = 140, htmlFor = '') {
  const label = document.createElement('label');
  label.textContent = text;
  if (htmlFor) {
    label.htmlFor = htmlFor;
  }
  label.style.cssText = `font-size:0.85em;font-weight:500;min-width:${minWidth}px;`;
  return label;
}

function createInput(placeholder, type = 'text', ariaLabel = '', testId = '') {
  const input = document.createElement('input');
  input.type = type;
  input.placeholder = placeholder;
  if (ariaLabel) {
    input.setAttribute('aria-label', ariaLabel);
  }
  if (testId) {
    input.dataset.testid = testId;
  }
  input.className = 'wm-input';
  input.style.cssText = 'flex:1;font-family:monospace;font-size:0.85em;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text);';
  return input;
}

function createStatusText() {
  const status = document.createElement('span');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText = 'font-size:0.8em;color:var(--text-muted);';
  return status;
}

function setStatus(status, message, color = 'var(--text-muted)') {
  status.textContent = message;
  status.style.color = color;
}

function createActionButton(text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wm-button secondary';
  button.textContent = text;
  button.style.cssText = 'font-size:0.85em;padding:6px 12px;';
  return button;
}

const OPENROUTER_SPEECH_DEFAULTS = {
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'hexgrad/kokoro-82m',
  voice: 'af_heart',
  format: 'mp3',
  summaryBaseUrl: 'https://openrouter.ai/api/v1',
  summaryModel: 'openai/gpt-4o-mini',
};

const LOCAL_SPEECH_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8880/v1',
  model: 'kokoro',
  voice: 'am_onyx',
  format: 'mp3',
  summaryBaseUrl: 'http://127.0.0.1:11434/v1',
  summaryModel: 'gemma4:e4b',
};

function normalizeHostname(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return trimmed.replace(/^https?:\/\//, '').split('/')[0] ?? '';
  }
}

function resolveSuggestedRoutingDomain(config, currentOrigin) {
  const configured = normalizeHostname(config?.subdomainBaseDomain);
  if (configured) return configured;

  const baseUrlHost = normalizeHostname(config?.baseUrl);
  if (baseUrlHost && baseUrlHost !== 'localhost') return baseUrlHost;

  const originHost = normalizeHostname(currentOrigin);
  if (originHost && originHost !== 'localhost') return originHost;

  return 'apps.example.invalid';
}

function buildHostedAppEnvSnippet(domain, origin) {
  const normalizedDomain = normalizeHostname(domain) || 'apps.example.invalid';
  const baseUrl = origin && origin.startsWith('https://')
    ? origin
    : `https://${normalizedDomain}`;
  return [
    'WINGMAN_APP_ROUTING=subdomain',
    `WINGMAN_SUBDOMAIN_BASE_DOMAIN=${normalizedDomain}`,
    'WINGMAN_SUBDOMAIN_PROXY_ENABLED=true',
    `WINGMAN_BASE_URL=${baseUrl}`,
  ].join('\n');
}

export function createHostedAppRoutingSection({ config, currentOrigin } = {}) {
  const container = document.createElement('div');
  container.className = 'wm-settings__hosted-app-routing';
  container.style.cssText = 'margin-top:16px;';

  const heading = document.createElement('h3');
  heading.textContent = 'Hosted App Routing';

  const description = document.createElement('p');
  description.className = 'wm-settings__port-note';
  description.textContent = 'Use the main Wingman hostname and wildcard hostname for apps, both routed by Cloudflare Tunnel to the same container port.';

  const currentMode = config?.appRoutingMode ?? 'path';
  const currentDomain = config?.subdomainBaseDomain ?? '';
  const proxyEnabled = Boolean(config?.subdomainProxyEnabled);
  const suggestedDomain = resolveSuggestedRoutingDomain(config, currentOrigin);

  const statusList = document.createElement('dl');
  statusList.style.cssText = 'display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 12px;margin:10px 0;';

  const addStatus = (labelText, valueText) => {
    const label = document.createElement('dt');
    label.style.cssText = 'font-size:0.85em;color:var(--text-muted);';
    label.textContent = labelText;
    const value = document.createElement('dd');
    value.style.cssText = 'margin:0;font-size:0.85em;';
    const code = document.createElement('code');
    code.textContent = valueText;
    value.append(code);
    statusList.append(label, value);
  };

  addStatus('Current mode', currentMode);
  addStatus('Current app domain', currentDomain || 'not set');
  addStatus('Subdomain proxy', proxyEnabled ? 'enabled' : 'disabled');
  addStatus('Tunnel hostnames', `${suggestedDomain}, *.${suggestedDomain}`);

  const domainRow = document.createElement('div');
  domainRow.className = 'wm-settings__key-row';
  domainRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;';

  const domainLabel = createRowLabel('App domain');
  const domainInput = createInput('apps.example.invalid');
  domainInput.value = suggestedDomain;

  const copyButton = createActionButton('Copy Docker Env');
  const status = createStatusText();
  domainRow.append(domainLabel, domainInput, copyButton, status);

  const snippet = document.createElement('pre');
  snippet.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin:10px 0 0;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);font-size:0.8em;';
  const snippetCode = document.createElement('code');
  snippet.append(snippetCode);

  const refreshSnippet = () => {
    snippetCode.textContent = buildHostedAppEnvSnippet(domainInput.value, currentOrigin);
  };
  refreshSnippet();

  domainInput.addEventListener('input', refreshSnippet);
  copyButton.addEventListener('click', async () => {
    copyButton.disabled = true;
    try {
      await navigator.clipboard.writeText(snippetCode.textContent);
      setStatus(status, 'Copied', 'var(--success, #4caf50)');
    } catch {
      setStatus(status, 'Copy failed', 'var(--error, #f44336)');
    }
    copyButton.disabled = false;
  });

  const note = document.createElement('p');
  note.className = 'wm-settings__port-note';
  note.style.cssText = 'margin-top:6px;font-size:0.8em;';
  note.textContent = 'Apply these values in the Docker .env file and restart the container. The Cloudflare tunnel should route both hostnames to the Wingman host port, and the Cloudflare edge certificate must cover the nested wildcard app hostnames.';

  container.append(heading, description, statusList, domainRow, snippet, note);
  return container;
}

export function createApiKeysSection() {
  const container = document.createElement('div');
  container.className = 'wm-settings__api-keys';

  const heading = document.createElement('h3');
  heading.textContent = 'API Keys';
  container.append(heading);

  const description = document.createElement('p');
  description.className = 'wm-settings__port-note';
  description.textContent = 'Configure API keys for agent tools. Keys are stored per-user and used when agents generate images or call external APIs.';
  container.append(description);

  const keyRow = document.createElement('div');
  keyRow.className = 'wm-settings__key-row';
  keyRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';

  const label = createRowLabel('OpenRouter API Key');
  const input = createInput('sk-or-...', 'password');
  const saveBtn = createActionButton('Save');
  saveBtn.setAttribute('aria-label', 'Save OpenRouter API key');
  saveBtn.dataset.testid = 'settings-openrouter-save';
  const clearBtn = createActionButton('Clear');
  clearBtn.setAttribute('aria-label', 'Clear OpenRouter API key');
  clearBtn.dataset.testid = 'settings-openrouter-clear';
  const status = createStatusText();

  loadUserSettings().then((settings) => {
    const masked = settings.openrouter_api_key;
    if (masked) {
      input.placeholder = masked;
      setStatus(status, 'Key set', 'var(--success, #4caf50)');
    }
  });

  saveBtn.addEventListener('click', async () => {
    const value = input.value.trim();
    if (!value) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      await saveUserSetting('openrouter_api_key', value);
      input.value = '';
      input.placeholder = value.slice(0, 4) + '..' + value.slice(-4);
      setStatus(status, 'Saved', 'var(--success, #4caf50)');
    } catch (error) {
      setStatus(status, error.message || 'Save failed', 'var(--error, #f44336)');
    }

    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  });

  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    try {
      await deleteUserSetting('openrouter_api_key');
      input.value = '';
      input.placeholder = 'sk-or-...';
      setStatus(status, 'Cleared');
    } catch (error) {
      setStatus(status, error.message || 'Failed to clear', 'var(--error, #f44336)');
    }
    clearBtn.disabled = false;
  });

  keyRow.append(label, input, saveBtn, clearBtn, status);
  container.append(keyRow);

  const source = document.createElement('p');
  source.className = 'wm-settings__port-note';
  source.textContent = 'Effective source: personal encrypted setting.';
  container.append(source);

  const helpText = document.createElement('p');
  helpText.className = 'wm-settings__port-note';
  helpText.style.cssText = 'margin-top:6px;font-size:0.8em;';
  helpText.innerHTML = 'Get your API key from <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>. Used by the <code>generate_image</code> agent tool.';
  container.append(helpText);

  return container;
}

export function createSpeechSettingsSection() {
  const container = document.createElement('div');
  container.className = 'wm-settings__speech';
  container.style.cssText = 'margin-top:16px;';

  const heading = document.createElement('h3');
  heading.textContent = 'Speech';

  const description = document.createElement('p');
  description.className = 'wm-settings__port-note';
  description.textContent = 'Optional server speech settings for generated audio. Choose OpenRouter or a local OpenAI-compatible Kokoro server.';

  const providerRow = document.createElement('div');
  providerRow.className = 'wm-settings__key-row';
  providerRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';
  const providerLabel = createRowLabel('Provider', 140, 'speech-provider-input');
  const providerSelect = document.createElement('select');
  providerSelect.id = 'speech-provider-input';
  providerSelect.className = 'wm-input';
  providerSelect.dataset.testid = 'settings-speech-provider';
  providerSelect.setAttribute('aria-label', 'Speech provider');
  providerSelect.style.cssText = 'flex:1;font-size:0.85em;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text);';
  [
    ['openrouter', 'OpenRouter'],
    ['local', 'Local Kokoro'],
  ].forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    providerSelect.append(option);
  });
  providerRow.append(providerLabel, providerSelect);

  const apiKeyRow = document.createElement('div');
  apiKeyRow.className = 'wm-settings__key-row';
  apiKeyRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';
  const apiKeyLabel = createRowLabel('API Key', 140, 'speech-api-key-input');
  const apiKeyInput = createInput('sk-...', 'password', 'Speech API key', 'settings-speech-api-key');
  apiKeyInput.id = 'speech-api-key-input';
  apiKeyRow.append(apiKeyLabel, apiKeyInput);

  const baseUrlRow = document.createElement('div');
  baseUrlRow.className = 'wm-settings__key-row';
  baseUrlRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';
  const baseUrlLabel = createRowLabel('Base URL', 140, 'speech-base-url-input');
  const baseUrlInput = createInput(OPENROUTER_SPEECH_DEFAULTS.baseUrl, 'url', 'Speech API base URL', 'settings-speech-base-url');
  baseUrlInput.id = 'speech-base-url-input';
  baseUrlInput.value = OPENROUTER_SPEECH_DEFAULTS.baseUrl;
  baseUrlRow.append(baseUrlLabel, baseUrlInput);

  const modelRow = document.createElement('div');
  modelRow.className = 'wm-settings__key-row';
  modelRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';
  const modelLabel = createRowLabel('Model', 140, 'speech-model-input');
  const modelInput = createInput(OPENROUTER_SPEECH_DEFAULTS.model, 'text', 'Speech model', 'settings-speech-model');
  modelInput.id = 'speech-model-input';
  modelInput.value = OPENROUTER_SPEECH_DEFAULTS.model;
  modelRow.append(modelLabel, modelInput);

  const voiceRow = document.createElement('div');
  voiceRow.className = 'wm-settings__key-row';
  voiceRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';
  const voiceLabel = createRowLabel('Voice', 140, 'speech-voice-input');
  const voiceInput = createInput(OPENROUTER_SPEECH_DEFAULTS.voice, 'text', 'Speech voice', 'settings-speech-voice');
  voiceInput.id = 'speech-voice-input';
  voiceInput.value = OPENROUTER_SPEECH_DEFAULTS.voice;
  voiceRow.append(voiceLabel, voiceInput);

  const formatRow = document.createElement('div');
  formatRow.className = 'wm-settings__key-row';
  formatRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';
  const formatLabel = createRowLabel('Format', 140, 'speech-format-input');
  const formatInput = createInput(OPENROUTER_SPEECH_DEFAULTS.format, 'text', 'Speech response format', 'settings-speech-format');
  formatInput.id = 'speech-format-input';
  formatInput.value = OPENROUTER_SPEECH_DEFAULTS.format;
  formatRow.append(formatLabel, formatInput);

  const summaryBaseUrlRow = document.createElement('div');
  summaryBaseUrlRow.className = 'wm-settings__key-row';
  summaryBaseUrlRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';
  const summaryBaseUrlLabel = createRowLabel('Summary URL', 140, 'speech-summary-base-url-input');
  const summaryBaseUrlInput = createInput(OPENROUTER_SPEECH_DEFAULTS.summaryBaseUrl, 'url', 'Speech summary API base URL', 'settings-speech-summary-base-url');
  summaryBaseUrlInput.id = 'speech-summary-base-url-input';
  summaryBaseUrlInput.value = OPENROUTER_SPEECH_DEFAULTS.summaryBaseUrl;
  summaryBaseUrlRow.append(summaryBaseUrlLabel, summaryBaseUrlInput);

  const summaryModelRow = document.createElement('div');
  summaryModelRow.className = 'wm-settings__key-row';
  summaryModelRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';
  const summaryModelLabel = createRowLabel('Summary Model', 140, 'speech-summary-model-input');
  const summaryModelInput = createInput(OPENROUTER_SPEECH_DEFAULTS.summaryModel, 'text', 'Speech summary model', 'settings-speech-summary-model');
  summaryModelInput.id = 'speech-summary-model-input';
  summaryModelInput.value = OPENROUTER_SPEECH_DEFAULTS.summaryModel;
  summaryModelRow.append(summaryModelLabel, summaryModelInput);

  const chatReplyRow = document.createElement('div');
  chatReplyRow.className = 'wm-settings__key-row';
  chatReplyRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';
  const chatReplyLabel = createRowLabel('Chat Replies', 140, 'speech-chat-replies-enabled');
  const chatReplyEnabledInput = document.createElement('input');
  chatReplyEnabledInput.id = 'speech-chat-replies-enabled';
  chatReplyEnabledInput.type = 'checkbox';
  chatReplyEnabledInput.dataset.testid = 'settings-speech-chat-replies-enabled';
  chatReplyEnabledInput.setAttribute('aria-label', 'Generate audio for chat pipeline replies');
  const chatReplyEnabledText = document.createElement('span');
  chatReplyEnabledText.className = 'wm-settings__port-note';
  chatReplyEnabledText.textContent = 'Generate audio card for Flight Deck chat pipeline replies';
  chatReplyRow.append(chatReplyLabel, chatReplyEnabledInput, chatReplyEnabledText);

  const chatReplyModeRow = document.createElement('div');
  chatReplyModeRow.className = 'wm-settings__key-row';
  chatReplyModeRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';
  const chatReplyModeLabel = createRowLabel('Reply Audio', 140, 'speech-chat-replies-mode');
  const chatReplyModeSelect = document.createElement('select');
  chatReplyModeSelect.id = 'speech-chat-replies-mode';
  chatReplyModeSelect.className = 'wm-input';
  chatReplyModeSelect.dataset.testid = 'settings-speech-chat-replies-mode';
  chatReplyModeSelect.setAttribute('aria-label', 'Chat reply audio mode');
  chatReplyModeSelect.style.cssText = 'flex:1;font-size:0.85em;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text);';
  [
    ['summary', 'Spoken summary'],
    ['full', 'Full reply'],
  ].forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    chatReplyModeSelect.append(option);
  });
  chatReplyModeRow.append(chatReplyModeLabel, chatReplyModeSelect);

  const actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';
  const saveBtn = createActionButton('Save');
  saveBtn.dataset.testid = 'settings-speech-save';
  saveBtn.setAttribute('aria-label', 'Save speech settings');
  const clearBtn = createActionButton('Clear');
  clearBtn.dataset.testid = 'settings-speech-clear';
  clearBtn.setAttribute('aria-label', 'Clear speech settings');
  const status = createStatusText();
  actionsRow.append(saveBtn, clearBtn, status);

  const getProviderDefaults = () => (
    providerSelect.value === 'local' ? LOCAL_SPEECH_DEFAULTS : OPENROUTER_SPEECH_DEFAULTS
  );

  const applyProviderDefaults = ({ overwrite = false } = {}) => {
    const defaults = getProviderDefaults();
    if (overwrite || !baseUrlInput.value.trim()) baseUrlInput.value = defaults.baseUrl;
    if (overwrite || !modelInput.value.trim()) modelInput.value = defaults.model;
    if (overwrite || !voiceInput.value.trim()) voiceInput.value = defaults.voice;
    if (overwrite || !formatInput.value.trim()) formatInput.value = defaults.format;
    if (overwrite || !summaryBaseUrlInput.value.trim()) summaryBaseUrlInput.value = defaults.summaryBaseUrl;
    if (overwrite || !summaryModelInput.value.trim()) summaryModelInput.value = defaults.summaryModel;
    apiKeyInput.disabled = providerSelect.value === 'local';
    apiKeyInput.placeholder = providerSelect.value === 'local' ? 'not required for local' : 'sk-...';
  };

  providerSelect.addEventListener('change', () => {
    applyProviderDefaults({ overwrite: true });
  });

  loadUserSettings().then((settings) => {
    providerSelect.value = settings.speech_provider === 'local' ? 'local' : 'openrouter';
    const keyMasked = settings.speech_api_key;
    if (keyMasked) {
      apiKeyInput.placeholder = keyMasked;
      setStatus(status, 'Speech provider configured', 'var(--success, #4caf50)');
    }
    applyProviderDefaults({ overwrite: true });
    if (typeof settings.speech_base_url === 'string') {
      baseUrlInput.value = settings.speech_base_url;
    }
    if (typeof settings.speech_model === 'string') {
      modelInput.value = settings.speech_model;
    }
    if (typeof settings.speech_voice === 'string') {
      voiceInput.value = settings.speech_voice;
    }
    if (typeof settings.speech_format === 'string') {
      formatInput.value = settings.speech_format;
    }
    if (typeof settings.speech_summary_base_url === 'string') {
      summaryBaseUrlInput.value = settings.speech_summary_base_url;
    }
    if (typeof settings.speech_summary_model === 'string') {
      summaryModelInput.value = settings.speech_summary_model;
    }
    chatReplyEnabledInput.checked = settings.speech_chat_replies_enabled === 'true';
    chatReplyModeSelect.value = settings.speech_chat_replies_mode === 'full' ? 'full' : 'summary';
    applyProviderDefaults({ overwrite: false });
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      const apiKey = apiKeyInput.value.trim();
      const provider = providerSelect.value === 'local' ? 'local' : 'openrouter';
      const baseUrl = baseUrlInput.value.trim();
      const model = modelInput.value.trim();
      const voice = voiceInput.value.trim();
      const format = formatInput.value.trim();
      const summaryBaseUrl = summaryBaseUrlInput.value.trim();
      const summaryModel = summaryModelInput.value.trim();
      const chatReplyMode = chatReplyModeSelect.value === 'full' ? 'full' : 'summary';
      const saves = [];
      saves.push(saveUserSetting('speech_provider', provider));
      saves.push(saveUserSetting('speech_chat_replies_enabled', chatReplyEnabledInput.checked ? 'true' : 'false'));
      saves.push(saveUserSetting('speech_chat_replies_mode', chatReplyMode));
      if (provider === 'openrouter' && apiKey) saves.push(saveUserSetting('speech_api_key', apiKey));
      if (provider === 'local') saves.push(deleteUserSetting('speech_api_key'));
      if (baseUrl) saves.push(saveUserSetting('speech_base_url', baseUrl));
      if (model) saves.push(saveUserSetting('speech_model', model));
      if (voice) saves.push(saveUserSetting('speech_voice', voice));
      if (format) saves.push(saveUserSetting('speech_format', format));
      if (summaryBaseUrl) saves.push(saveUserSetting('speech_summary_base_url', summaryBaseUrl));
      if (summaryModel) saves.push(saveUserSetting('speech_summary_model', summaryModel));
      if (saves.length === 0) {
        setStatus(status, 'Enter at least one value to save', 'var(--error, #f44336)');
      } else {
        await Promise.all(saves);
        if (apiKey) {
          apiKeyInput.value = '';
          apiKeyInput.placeholder = apiKey.length > 8 ? `${apiKey.slice(0, 4)}..${apiKey.slice(-4)}` : '****';
        }
        setStatus(status, 'Saved', 'var(--success, #4caf50)');
      }
    } catch (error) {
      setStatus(status, error.message || 'Save failed', 'var(--error, #f44336)');
    }
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  });

  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    try {
      await Promise.all([
        deleteUserSetting('speech_api_key'),
        deleteUserSetting('speech_provider'),
        deleteUserSetting('speech_base_url'),
        deleteUserSetting('speech_model'),
        deleteUserSetting('speech_voice'),
        deleteUserSetting('speech_format'),
        deleteUserSetting('speech_summary_base_url'),
        deleteUserSetting('speech_summary_model'),
        deleteUserSetting('speech_chat_replies_enabled'),
        deleteUserSetting('speech_chat_replies_mode'),
      ]);
      apiKeyInput.value = '';
      apiKeyInput.placeholder = 'sk-...';
      providerSelect.value = 'openrouter';
      chatReplyEnabledInput.checked = false;
      chatReplyModeSelect.value = 'summary';
      applyProviderDefaults({ overwrite: true });
      setStatus(status, 'Cleared');
    } catch (error) {
      setStatus(status, error.message || 'Failed to clear', 'var(--error, #f44336)');
    }
    clearBtn.disabled = false;
  });

  const helpText = document.createElement('p');
  helpText.className = 'wm-settings__port-note';
  helpText.style.cssText = 'margin-top:6px;font-size:0.8em;';
  helpText.textContent = 'OpenRouter default: hexgrad/kokoro-82m with OpenRouter summaries. Local default: Kokoro at http://127.0.0.1:8880/v1 plus Ollama summaries at http://127.0.0.1:11434/v1, model gemma4:e4b.';

  container.append(heading, description, providerRow, apiKeyRow, baseUrlRow, modelRow, voiceRow, formatRow, summaryBaseUrlRow, summaryModelRow, chatReplyRow, chatReplyModeRow, actionsRow, helpText);
  return container;
}

export function createGitHubSection() {
  const container = document.createElement('div');
  container.className = 'wm-settings__github';
  container.style.cssText = 'margin-top:16px;';

  const heading = document.createElement('h3');
  heading.textContent = 'GitHub';
  container.append(heading);

  const description = document.createElement('p');
  description.className = 'wm-settings__port-note';
  description.textContent = 'Optional per-user HTTPS credentials for GitHub remotes. Used by GitHub pull/push actions in Live sessions and stored encrypted at rest.';
  container.append(description);

  const usernameRow = document.createElement('div');
  usernameRow.className = 'wm-settings__key-row';
  usernameRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';

  const usernameLabel = createRowLabel('GitHub Username', 140, 'github-username-input');
  const usernameInput = createInput('x-access-token', 'text', 'GitHub username', 'settings-github-username');
  usernameInput.id = 'github-username-input';
  usernameRow.append(usernameLabel, usernameInput);

  const tokenRow = document.createElement('div');
  tokenRow.className = 'wm-settings__key-row';
  tokenRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';

  const tokenLabel = createRowLabel('Personal Access Token', 140, 'github-token-input');
  const tokenInput = createInput('ghp_...', 'password', 'GitHub personal access token', 'settings-github-token');
  tokenInput.id = 'github-token-input';
  tokenRow.append(tokenLabel, tokenInput);

  const authorNameRow = document.createElement('div');
  authorNameRow.className = 'wm-settings__key-row';
  authorNameRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';

  const authorNameLabel = createRowLabel('Commit Name', 140, 'github-author-name-input');
  const authorNameInput = createInput('Your GitHub name', 'text', 'Git commit author name', 'settings-github-author-name');
  authorNameInput.id = 'github-author-name-input';
  authorNameRow.append(authorNameLabel, authorNameInput);

  const authorEmailRow = document.createElement('div');
  authorEmailRow.className = 'wm-settings__key-row';
  authorEmailRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';

  const authorEmailLabel = createRowLabel('Commit Email', 140, 'github-author-email-input');
  const authorEmailInput = createInput('you@users.noreply.github.com', 'email', 'Git commit author email', 'settings-github-author-email');
  authorEmailInput.id = 'github-author-email-input';
  authorEmailRow.append(authorEmailLabel, authorEmailInput);

  const actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px;';

  const saveBtn = createActionButton('Save');
  const clearBtn = createActionButton('Clear');
  const status = createStatusText();

  let currentUsername = 'x-access-token';
  let hasStoredToken = false;

  loadUserSettings().then((settings) => {
    const storedUsername = typeof settings.github_username === 'string' ? settings.github_username.trim() : '';
    const tokenMasked = settings.github_api_key || settings.github_token;

    if (storedUsername) {
      currentUsername = storedUsername;
      usernameInput.value = storedUsername;
    }

    if (typeof settings.github_git_name === 'string' && settings.github_git_name.trim()) {
      authorNameInput.value = settings.github_git_name.trim();
    }

    if (typeof settings.github_git_email === 'string' && settings.github_git_email.trim()) {
      authorEmailInput.value = settings.github_git_email.trim();
    }

    if (tokenMasked) {
      hasStoredToken = true;
      tokenInput.placeholder = tokenMasked;
      setStatus(status, 'Credential set', 'var(--success, #4caf50)');
    }
  });

  saveBtn.addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    const username = usernameInput.value.trim() || currentUsername || 'x-access-token';
    const authorName = authorNameInput.value.trim() || (username !== 'x-access-token' ? username : '');
    const authorEmail = authorEmailInput.value.trim();

    if (!token && !hasStoredToken) {
      setStatus(status, 'Token is required', 'var(--error, #f44336)');
      return;
    }

    if (!authorEmail) {
      setStatus(status, 'Commit email is required', 'var(--error, #f44336)');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const saves = [
        saveUserSetting('github_username', username),
        saveUserSetting('github_git_name', authorName),
        saveUserSetting('github_git_email', authorEmail),
      ];
      if (token) {
        saves.push(saveUserSetting('github_api_key', token));
      }

      await Promise.all(saves);
      currentUsername = username;
      usernameInput.value = username;
      authorNameInput.value = authorName;
      authorEmailInput.value = authorEmail;
      if (token) {
        hasStoredToken = true;
        tokenInput.value = '';
        tokenInput.placeholder = token.slice(0, 4) + '..' + token.slice(-4);
      }
      setStatus(status, 'Saved', 'var(--success, #4caf50)');
    } catch (error) {
      setStatus(status, error.message || 'Save failed', 'var(--error, #f44336)');
    }

    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  });

  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    try {
      await Promise.all([
        deleteUserSetting('github_api_key'),
        deleteUserSetting('github_token'),
        deleteUserSetting('github_username'),
        deleteUserSetting('github_user'),
        deleteUserSetting('github_git_name'),
        deleteUserSetting('github_git_email'),
        deleteUserSetting('github_name'),
        deleteUserSetting('github_email'),
      ]);

      currentUsername = 'x-access-token';
      hasStoredToken = false;
      usernameInput.value = '';
      usernameInput.placeholder = 'x-access-token';
      authorNameInput.value = '';
      authorEmailInput.value = '';
      tokenInput.value = '';
      tokenInput.placeholder = 'ghp_...';
      setStatus(status, 'Cleared');
    } catch (error) {
      setStatus(status, error.message || 'Failed to clear', 'var(--error, #f44336)');
    }
    clearBtn.disabled = false;
  });

  actionsRow.append(saveBtn, clearBtn, status);

  const helpText = document.createElement('p');
  helpText.className = 'wm-settings__port-note';
  helpText.style.cssText = 'margin-top:6px;font-size:0.8em;';
  helpText.innerHTML = 'Create a token at <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">github.com/settings/tokens</a>. Use a GitHub-verified commit email, such as your no-reply address, so pushed commits attribute to you.';

  container.append(usernameRow, tokenRow, authorNameRow, authorEmailRow, actionsRow, helpText);
  return container;
}

export function createGiteaSection(giteaUrl) {
  const container = document.createElement('div');
  container.className = 'wm-settings__gitea';
  container.style.cssText = 'margin-top:16px;';

  const heading = document.createElement('h3');
  heading.textContent = 'Gitea';
  container.append(heading);

  const row = document.createElement('div');
  row.className = 'wm-settings__key-row';
  row.style.cssText = 'display:flex;gap:12px;align-items:center;margin-top:8px;';

  const usernameLabel = document.createElement('span');
  usernameLabel.style.cssText = 'font-size:0.85em;font-weight:500;min-width:80px;';
  usernameLabel.textContent = 'Username:';

  const usernameValue = document.createElement('code');
  usernameValue.style.cssText = 'font-size:0.85em;color:var(--text-muted);';
  usernameValue.textContent = 'Loading...';

  const statusBadge = document.createElement('span');
  statusBadge.style.cssText = 'font-size:0.8em;padding:2px 8px;border-radius:10px;';

  const repoLink = document.createElement('a');
  repoLink.style.cssText = 'font-size:0.85em;display:none;';
  repoLink.target = '_blank';
  repoLink.rel = 'noopener';
  repoLink.textContent = 'My Repositories';

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'wm-button secondary';
  resetBtn.textContent = 'Reset';
  resetBtn.style.cssText = 'font-size:0.8em;padding:4px 10px;margin-left:auto;display:none;';
  resetBtn.title = 'Clear stored Gitea credentials — re-provisioned on next login';

  loadUserSettings()
    .then((settings) => {
      const username = settings.gitea_username;
      const token = settings.gitea_api_token;
      if (username && token) {
        usernameValue.textContent = username;
        statusBadge.textContent = 'Account active';
        statusBadge.style.background = 'var(--success, #4caf50)';
        statusBadge.style.color = '#fff';
        repoLink.href = `${giteaUrl}/${username}`;
        repoLink.style.display = 'inline';
        resetBtn.style.display = 'inline-block';
      } else {
        usernameValue.textContent = '—';
        statusBadge.textContent = 'Not provisioned';
        statusBadge.style.background = 'var(--bg-secondary)';
        statusBadge.style.color = 'var(--text-muted)';
      }
    })
    .catch(() => {
      usernameValue.textContent = 'Error loading';
    });

  resetBtn.addEventListener('click', async () => {
    resetBtn.disabled = true;
    resetBtn.textContent = 'Resetting...';
    try {
      await deleteUserSetting('gitea_api_token');
      await deleteUserSetting('gitea_username');
      usernameValue.textContent = '—';
      statusBadge.textContent = 'Reset — log in again to re-provision';
      statusBadge.style.background = 'var(--bg-secondary)';
      statusBadge.style.color = 'var(--text-muted)';
      repoLink.style.display = 'none';
      resetBtn.style.display = 'none';
    } catch (error) {
      resetBtn.textContent = error.message || 'Failed';
    }
    resetBtn.disabled = false;
    resetBtn.textContent = 'Reset';
  });

  row.append(usernameLabel, usernameValue, statusBadge, repoLink, resetBtn);
  container.append(row);

  const helpText = document.createElement('p');
  helpText.className = 'wm-settings__port-note';
  helpText.style.cssText = 'margin-top:6px;font-size:0.8em;';
  helpText.textContent = 'Your Gitea account is auto-provisioned on login. Repos you create via agents are owned by your account.';
  container.append(helpText);

  return container;
}
