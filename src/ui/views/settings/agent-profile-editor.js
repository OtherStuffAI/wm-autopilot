import { createAgentModelLookupController, modelValueForPayload } from '../../common/agent-model-lookups.js';
import { createButton, createCheckbox, createInput, createStatusLine, createTextarea } from './agent-chat-shared-ui.js';
import { createAgentProfileMediaPicker } from './agent-profile-media-picker.js';

function createSelect(label, testId, ariaLabel) {
  const row = document.createElement('label');
  row.textContent = label;
  row.style.cssText = 'display:grid;gap:6px;';
  const select = document.createElement('select');
  select.dataset.testid = testId;
  select.setAttribute('aria-label', ariaLabel);
  row.append(select);
  return { row, select };
}

export function createAgentProfileEditor({ onSave, onBrowseDirectory } = {}) {
  const overlay = document.createElement('div');
  overlay.hidden = true;
  overlay.className = 'wm-modal-backdrop';
  overlay.dataset.testid = 'agent-profile-editor-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.46);';
  const form = document.createElement('form');
  form.className = 'wm-card';
  form.setAttribute('role', 'dialog');
  form.setAttribute('aria-modal', 'true');
  form.setAttribute('aria-labelledby', 'agent-profile-editor-title');
  form.style.cssText = 'width:min(680px,100%);max-height:86vh;overflow:auto;padding:18px;';
  const title = document.createElement('h2');
  title.id = 'agent-profile-editor-title';
  title.textContent = 'Edit Agent Profile';
  const identity = createInput('Immutable npub', '', 'agent-profile-edit-npub');
  identity.input.readOnly = true;
  const label = createInput('Label', '', 'agent-profile-edit-label', true);
  const directory = createInput('Working / start directory', '', 'agent-profile-edit-directory', true);
  if (typeof onBrowseDirectory === 'function') {
    const browse = createButton('Browse…', 'agent-profile-edit-directory-browse', 'Browse for the agent working directory');
    browse.type = 'button';
    browse.addEventListener('click', () => onBrowseDirectory({
      initialPath: directory.input.value,
      onSelect: (path) => { directory.input.value = path; directory.input.focus(); },
    }));
    directory.row.append(browse);
  }
  const harness = createSelect('Harness', 'agent-profile-edit-harness', 'Agent profile harness');
  const model = createSelect('Model', 'agent-profile-edit-model', 'Agent profile model');
  const lookupStatus = createStatusLine();
  lookupStatus.setAttribute('aria-live', 'polite');
  const lookup = createAgentModelLookupController({ harnessSelect: harness.select, modelSelect: model.select, status: lookupStatus });
  const enabled = createCheckbox('Enabled', 'agent-profile-edit-enabled', true);
  const directChatEnabled = createCheckbox('Respond to direct chat / dispatch', 'agent-profile-edit-direct-chat-enabled', true);
  const name = createInput('Public Nostr name', '', 'agent-profile-edit-name');
  const picture = createInput('Public picture URL', '', 'agent-profile-edit-picture');
  const mediaPicker = createAgentProfileMediaPicker('agent-profile-edit-picture');
  const about = createTextarea('Public about', '', 'agent-profile-edit-about', 4);
  const nip05 = createInput('NIP-05', '', 'agent-profile-edit-nip05');
  const status = createStatusLine();
  status.dataset.testid = 'agent-profile-edit-status';
  status.setAttribute('aria-live', 'polite');
  const save = createButton('Save Agent Profile', 'agent-profile-edit-save', 'Save local and public agent profile fields');
  save.type = 'submit';
  const cancel = createButton('Cancel', 'agent-profile-edit-cancel', 'Close Edit Agent Profile');
  cancel.type = 'button';
  const actions = document.createElement('div');
  actions.className = 'wm-settings-page__actions';
  actions.append(save, cancel);
  form.append(title, identity.row, label.row, directory.row, harness.row, model.row, lookupStatus,
    enabled.row, directChatEnabled.row, name.row, picture.row, mediaPicker.element, about.row, nip05.row, status, actions);
  overlay.append(form);
  let current = null;
  let runtimeConfig = null;

  function close() {
    overlay.hidden = true;
    overlay.style.display = 'none';
  }
  function open(agent) {
    current = agent;
    identity.input.value = agent.botNpub || '';
    label.input.value = agent.label || '';
    directory.input.value = agent.workingDirectory || agent.directChat?.directory || '';
    enabled.input.checked = agent.enabled !== false;
    directChatEnabled.input.checked = agent.directChat?.enabled !== false;
    name.input.value = agent.publicProfile?.name || agent.label || '';
    picture.input.value = agent.publicProfile?.picture || '';
    mediaPicker.reset(picture.input.value);
    about.input.value = agent.publicProfile?.about || '';
    nip05.input.value = agent.publicProfile?.nip05 || '';
    lookup.setConfig(runtimeConfig, { harness: agent.harness || agent.directChat?.sessionAgent || '', model: agent.model || agent.directChat?.model || '' });
    status.textContent = '';
    overlay.hidden = false;
    overlay.style.display = 'flex';
    label.input.focus();
  }
  cancel.addEventListener('click', close);
  picture.input.addEventListener('input', () => mediaPicker.setExternalUrl(picture.input.value));
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  async function submit(event) {
    event.preventDefault();
    if (!current) return;
    save.disabled = true;
    status.textContent = 'Saving agent profile…';
    try {
      const result = await onSave(current, {
        label: label.input.value.trim(),
        workingDirectory: directory.input.value,
        harness: harness.select.value,
        model: modelValueForPayload(model.select.value),
        enabled: enabled.input.checked,
        directChatEnabled: directChatEnabled.input.checked,
        capabilities: current.capabilities,
        publicProfile: {
          name: name.input.value.trim(), picture: picture.input.value.trim(),
          about: about.input.value.trim(), nip05: nip05.input.value.trim(),
        },
        mediaFile: mediaPicker.file,
      });
      status.textContent = result.media?.savedLocally && result.media?.publishedToRelays
        ? 'Image saved locally and profile published to relays.'
        : result.published
          ? 'Saved profile fields and published them to relays. Any picture URL remains externally hosted.'
          : 'Saved local runtime changes. No public publication was needed.';
      close();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Failed to save agent profile.';
    } finally {
      save.disabled = false;
    }
  }
  form.addEventListener('submit', submit);
  save.addEventListener('click', submit);
  return {
    element: overlay,
    open,
    setRuntimeConfig(config) { runtimeConfig = config; },
    setRuntimeConfigUnavailable(message) { runtimeConfig = null; lookup.setUnavailable(message); },
  };
}
