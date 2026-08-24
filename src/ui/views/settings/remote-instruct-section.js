import {
  fetchRemoteInstructTemplate,
  saveRemoteInstructTemplate,
} from '../../services/remote-instruct.js';

const VARIABLE_ORDER = [
  'hostname',
  'project_reference',
  'autopilot_url',
  'default_workdir',
  'agent_types',
  'viewer_npub',
  'auth_method',
];
const hasOwn = Object.prototype.hasOwnProperty;

function setStatus(target, message, color = 'var(--text-muted)') {
  target.textContent = message;
  target.style.color = color;
}

function createVariableList(variables) {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;';
  const keys = VARIABLE_ORDER.filter((key) => hasOwn.call(variables ?? {}, key));
  keys.forEach((key) => {
    const item = document.createElement('code');
    item.textContent = `$${key}`;
    item.style.cssText = 'padding:3px 7px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);';
    wrapper.append(item);
  });
  return wrapper;
}

function setControlsDisabled(controls, disabled) {
  controls.forEach((control) => {
    control.disabled = disabled;
  });
}

export function createRemoteInstructSection() {
  const section = document.createElement('section');
  section.className = 'wm-card';
  section.setAttribute('data-testid', 'remote-instruct-settings');

  const heading = document.createElement('h2');
  heading.textContent = 'Remote Instruct';

  const status = document.createElement('p');
  status.className = 'wm-settings__port-note';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('data-testid', 'remote-instruct-status');
  status.textContent = 'Loading Remote Instruct...';

  const label = document.createElement('label');
  label.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:12px;';
  label.textContent = 'Context Prompt';

  const textarea = document.createElement('textarea');
  textarea.className = 'wm-input';
  textarea.rows = 14;
  textarea.spellcheck = false;
  textarea.setAttribute('aria-label', 'Remote Instruct context prompt');
  textarea.setAttribute('data-testid', 'remote-instruct-template');
  textarea.style.cssText = 'font-family:var(--wm-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:0.9em;line-height:1.5;white-space:pre-wrap;';
  label.append(textarea);

  const variableTitle = document.createElement('p');
  variableTitle.className = 'wm-settings__port-note';
  variableTitle.textContent = 'Variables';

  const variablesWrapper = document.createElement('div');

  const actions = document.createElement('div');
  actions.className = 'wm-settings__ports-admin-actions';
  actions.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px;';

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'wm-button';
  saveButton.textContent = 'Save';
  saveButton.setAttribute('aria-label', 'Save Remote Instruct prompt');
  saveButton.setAttribute('data-testid', 'remote-instruct-save');

  const reloadButton = document.createElement('button');
  reloadButton.type = 'button';
  reloadButton.className = 'wm-button secondary';
  reloadButton.textContent = 'Reload';
  reloadButton.setAttribute('aria-label', 'Reload Remote Instruct prompt');
  reloadButton.setAttribute('data-testid', 'remote-instruct-reload');

  actions.append(saveButton, reloadButton);
  section.append(heading, status, label, variableTitle, variablesWrapper, actions);

  async function loadTemplate() {
    setControlsDisabled([textarea, saveButton, reloadButton], true);
    setStatus(status, 'Loading Remote Instruct...');
    try {
      const payload = await fetchRemoteInstructTemplate();
      textarea.value = typeof payload.template === 'string' ? payload.template : '';
      variablesWrapper.replaceChildren(createVariableList(payload.variables ?? {}));
      setStatus(status, 'Loaded.', 'var(--success, #4caf50)');
    } catch (error) {
      setStatus(status, error.message || 'Failed to load Remote Instruct.', 'var(--error, #f44336)');
    } finally {
      setControlsDisabled([textarea, saveButton, reloadButton], false);
    }
  }

  saveButton.addEventListener('click', async () => {
    setControlsDisabled([textarea, saveButton, reloadButton], true);
    saveButton.textContent = 'Saving...';
    setStatus(status, 'Saving Remote Instruct...');
    try {
      const payload = await saveRemoteInstructTemplate(textarea.value);
      textarea.value = typeof payload.template === 'string' ? payload.template : textarea.value;
      variablesWrapper.replaceChildren(createVariableList(payload.variables ?? {}));
      setStatus(status, 'Saved.', 'var(--success, #4caf50)');
    } catch (error) {
      setStatus(status, error.message || 'Failed to save Remote Instruct.', 'var(--error, #f44336)');
    } finally {
      saveButton.textContent = 'Save';
      setControlsDisabled([textarea, saveButton, reloadButton], false);
    }
  });

  reloadButton.addEventListener('click', () => {
    void loadTemplate();
  });

  void loadTemplate();
  return section;
}
