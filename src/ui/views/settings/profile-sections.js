import {
  AGENT_OPTIONS,
  DEFAULT_AGENT,
  getAgentLabel,
  normalizeAgentValue,
} from '../../common/agent-options.js';
import { deleteUserSetting, saveUserSetting } from '../../services/user-settings.js';

const DEFAULT_AGENT_SETTING_KEY = 'default_agent';

function setStatus(target, message, color = 'var(--text-muted)') {
  target.textContent = message;
  target.style.color = color;
}

function resolveSystemDefaultAgent(state) {
  return normalizeAgentValue(state?.config?.systemDefaultAgent ?? DEFAULT_AGENT);
}

function resolveEffectiveDefaultAgent(state) {
  return normalizeAgentValue(state?.config?.defaultAgent ?? resolveSystemDefaultAgent(state));
}

function updateDefaultAgentState(state, agentId) {
  if (!state?.config) return;
  state.config.defaultAgent = normalizeAgentValue(agentId);
  window.dispatchEvent(new CustomEvent('wingman:default-agent-changed', {
    detail: { agent: state.config.defaultAgent },
  }));
}

export function createDefaultAgentSection({ state }) {
  const section = document.createElement('section');
  section.className = 'wm-card wm-settings-profile__default-agent';
  section.dataset.testid = 'settings-profile-default-agent';

  const heading = document.createElement('h2');
  heading.textContent = 'Default Agent';
  section.append(heading);

  const description = document.createElement('p');
  description.className = 'wm-settings__port-note';
  description.textContent =
    'Choose which agent new sessions use by default in the main launcher, quick launcher, and trigger builders.';
  section.append(description);

  if (!state.identity.authenticated) {
    const note = document.createElement('p');
    note.className = 'wm-settings__port-note';
    note.textContent = 'Sign in to save a personal default agent.';
    section.append(note);
    return section;
  }

  const controls = document.createElement('div');
  controls.className = 'wm-settings__key-row';
  controls.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;';

  const label = document.createElement('label');
  label.textContent = 'Launch Agent';
  label.setAttribute('for', 'profile-default-agent');
  label.style.cssText = 'font-size:0.85em;font-weight:500;min-width:140px;';

  const select = document.createElement('select');
  select.id = 'profile-default-agent';
  select.className = 'wm-input';
  select.setAttribute('aria-label', 'Default launch agent');
  select.dataset.testid = 'profile-default-agent';
  select.style.cssText =
    'flex:1;min-width:180px;font-size:0.85em;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text);';
  AGENT_OPTIONS.forEach((option) => {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    select.append(item);
  });
  select.value = resolveEffectiveDefaultAgent(state);

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'wm-button secondary';
  saveButton.textContent = 'Save';
  saveButton.style.cssText = 'font-size:0.85em;padding:6px 12px;';

  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.className = 'wm-button secondary';
  resetButton.textContent = 'Reset';
  resetButton.style.cssText = 'font-size:0.85em;padding:6px 12px;';

  const status = document.createElement('span');
  status.style.cssText = 'font-size:0.8em;color:var(--text-muted);';
  setStatus(status, `Current default: ${getAgentLabel(select.value)}`);

  saveButton.addEventListener('click', async () => {
    const nextAgent = normalizeAgentValue(select.value);
    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';
    try {
      await saveUserSetting(DEFAULT_AGENT_SETTING_KEY, nextAgent);
      updateDefaultAgentState(state, nextAgent);
      setStatus(status, `Saved: ${getAgentLabel(nextAgent)}`, 'var(--success, #4caf50)');
    } catch (error) {
      setStatus(status, error.message || 'Failed to save default', 'var(--error, #f44336)');
    }
    saveButton.disabled = false;
    saveButton.textContent = 'Save';
  });

  resetButton.addEventListener('click', async () => {
    const systemDefault = resolveSystemDefaultAgent(state);
    resetButton.disabled = true;
    resetButton.textContent = 'Resetting...';
    try {
      await deleteUserSetting(DEFAULT_AGENT_SETTING_KEY);
      select.value = systemDefault;
      updateDefaultAgentState(state, systemDefault);
      setStatus(status, `Reset to workspace default: ${getAgentLabel(systemDefault)}`, 'var(--text-muted)');
    } catch (error) {
      setStatus(status, error.message || 'Failed to reset default', 'var(--error, #f44336)');
    }
    resetButton.disabled = false;
    resetButton.textContent = 'Reset';
  });

  controls.append(label, select, saveButton, resetButton, status);
  section.append(controls);

  return section;
}
