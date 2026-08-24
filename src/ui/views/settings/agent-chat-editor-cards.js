import {
  createButton,
  createCapabilityPicker,
  createCard,
  createCheckbox,
  createInlineActions,
  createInput,
  createPlaceholderNote,
  createStatusLine,
  createTextarea,
  setPanelVisible,
} from './agent-chat-shared-ui.js';
import {
  createAgentModelLookupController,
  modelValueForPayload,
} from '../../common/agent-model-lookups.js';

function createLookupField(label, testId, ariaLabel) {
  const row = document.createElement('label');
  row.textContent = label;
  row.style.cssText = 'display:grid;gap:6px;';
  const select = document.createElement('select');
  select.setAttribute('aria-label', ariaLabel);
  select.setAttribute('data-testid', testId);
  row.append(select);
  return { row, select };
}

function createDisclosureSection(title, description, testId) {
  const details = document.createElement('details');
  details.style.cssText = 'margin-top:12px;padding:12px;border:1px solid var(--wm-border-muted, rgba(255,255,255,0.12));border-radius:10px;background:rgba(127,127,127,0.04);';
  if (testId) {
    details.setAttribute('data-testid', testId);
  }

  const summary = document.createElement('summary');
  summary.style.cssText = 'cursor:pointer;font-weight:600;';
  summary.textContent = title;
  details.append(summary);

  const body = document.createElement('div');
  body.style.marginTop = '10px';

  if (description) {
    const note = document.createElement('p');
    note.className = 'wm-settings__port-note';
    note.style.margin = '0 0 8px 0';
    note.textContent = description;
    body.append(note);
  }

  details.append(body);
  return {
    element: details,
    body,
    setOpen(open) {
      details.open = Boolean(open);
    },
  };
}

function setModalVisible(overlay, visible) {
  overlay.hidden = !visible;
  overlay.style.display = visible ? 'flex' : 'none';
}

function createModalShell({ testId, labelledBy }) {
  const overlay = document.createElement('div');
  overlay.hidden = true;
  overlay.className = 'wm-modal-backdrop';
  if (testId) {
    overlay.setAttribute('data-testid', testId);
  }
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:1000',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'padding:20px',
    'background:rgba(0,0,0,0.46)',
  ].join(';');

  const panel = document.createElement('section');
  panel.className = 'wm-card';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  if (labelledBy) {
    panel.setAttribute('aria-labelledby', labelledBy);
  }
  panel.style.cssText = [
    'width:min(860px,100%)',
    'max-height:min(86vh,820px)',
    'overflow:auto',
    'padding:18px',
    'border-radius:8px',
    'box-shadow:0 18px 60px rgba(0,0,0,0.28)',
  ].join(';');

  overlay.append(panel);
  return { overlay, panel };
}

function wireModalClose(overlay, onClose) {
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      onClose();
    }
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      onClose();
    }
  });
}

export function createSubscriptionEditorCard() {
  const workspaceOwnerField = createInput('Workspace Owner npub', 'npub1workspace...', 'agent-chat-workspace-owner');
  const backendUrlField = createInput('Backend Base URL', 'https://tower.example.com', 'agent-chat-backend-url');
  const sourceAppField = createInput('Source App npub', 'npub1flightdeckapp...', 'agent-chat-source-app');

  const card = createCard(
    'Workspace Connection',
    'Save the shared workspace connection once. Agent dispatch reuses this same live subscription.',
  );
  const saveButton = createButton(
    'Save Connection',
    'agent-chat-save',
    'Create or refresh Agent Dispatch subscription',
  );
  const closeButton = createButton(
    'Done',
    'agent-chat-close-subscription-editor',
    'Close Agent Dispatch subscription editor',
  );

  card.append(
    workspaceOwnerField.row,
    backendUrlField.row,
    sourceAppField.row,
    createInlineActions(saveButton, closeButton),
  );
  setPanelVisible(card, false);

  return {
    card,
    saveButton,
    closeButton,
    workspaceOwnerField,
    backendUrlField,
    sourceAppField,
  };
}

export function createPrimaryAgentEditorCard({ onBrowseDirectory } = {}) {
  const modal = createModalShell({
    testId: 'agent-chat-agent-editor-modal',
    labelledBy: 'agent-chat-agent-editor-title',
  });
  const agentIdField = createInput('Agent ID', 'agent_workspace', 'agent-chat-agent-id');
  const labelField = createInput('Agent Label', 'Wingman 21', 'agent-chat-agent-label', true);
  const agentBotField = createInput('Agent Bot npub', 'npub1bot...', 'agent-chat-agent-bot');
  const agentWorkspaceField = createInput('Agent Workspace Owner npub', 'npub1workspace...', 'agent-chat-agent-workspace-owner');
  const publicNameField = createInput('Public Nostr name', 'Workspace Agent', 'agent-chat-agent-public-name');
  const publicPictureField = createInput('Public picture URL', 'https://...', 'agent-chat-agent-public-picture');
  const publicAboutField = createTextarea('Public about', 'What this agent does', 'agent-chat-agent-public-about', 4);
  const publicNip05Field = createInput('NIP-05 (optional)', 'agent@example.com', 'agent-chat-agent-public-nip05');
  const workingDirectoryField = createInput('Direct Chat Directory', '', 'agent-chat-agent-directory');
  const directChatEnabledField = createCheckbox(
    'Respond to direct chat',
    'agent-chat-agent-direct-chat-enabled',
    true,
  );
  const harnessField = createLookupField('Direct Chat Harness', 'agent-chat-agent-harness', 'Agent harness');
  const modelField = createLookupField('Direct Chat Model', 'agent-chat-agent-model', 'Agent model');
  const lookupStatus = createStatusLine();
  lookupStatus.setAttribute('aria-live', 'polite');
  lookupStatus.setAttribute('data-testid', 'agent-chat-agent-lookup-status');
  const lookupController = createAgentModelLookupController({
    harnessSelect: harnessField.select,
    modelSelect: modelField.select,
    status: lookupStatus,
  });
  let browseDirectoryButton = null;
  if (typeof onBrowseDirectory === 'function') {
    browseDirectoryButton = createButton(
      'Browse...',
      'agent-chat-agent-directory-browse',
      'Browse for the backend agent working directory',
    );
    const directoryInputRow = document.createElement('div');
    directoryInputRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
    workingDirectoryField.input.style.flex = '1 1 auto';
    workingDirectoryField.input.style.minWidth = '0';
    directoryInputRow.append(workingDirectoryField.input, browseDirectoryButton);
    workingDirectoryField.row.append(directoryInputRow);
    browseDirectoryButton.addEventListener('click', (event) => {
      event.preventDefault();
      onBrowseDirectory({
        initialPath: workingDirectoryField.input.value.trim(),
        onSelect: (path) => {
          workingDirectoryField.input.value = path;
          workingDirectoryField.input.dispatchEvent(new Event('input', { bubbles: true }));
          workingDirectoryField.input.focus();
        },
      });
    });
  }
  const chatPromptTemplateField = createTextarea(
    'Chat Prompt Template',
    'Editable chat dispatch prompt with {{placeholders}}',
    'agent-chat-chat-prompt-template',
    16,
  );
  const taskPromptTemplateField = createTextarea(
    'Task Prompt Template',
    'Editable task dispatch prompt with {{placeholders}}',
    'agent-chat-task-prompt-template',
    14,
  );
  const flowDispatchPromptTemplateField = createTextarea(
    'Flow Dispatch Prompt Template',
    'Editable flow dispatch prompt with {{placeholders}}',
    'agent-chat-flow-dispatch-prompt-template',
    14,
  );
  const taskReviewPromptTemplateField = createTextarea(
    'Task Review Prompt Template',
    'Editable task review prompt with {{placeholders}}',
    'agent-chat-task-review-prompt-template',
    14,
  );
  const approvalDispatchPromptTemplateField = createTextarea(
    'Approval Dispatch Prompt Template',
    'Editable approval dispatch prompt with {{placeholders}}',
    'agent-chat-approval-dispatch-prompt-template',
    12,
  );
  const capabilityPicker = createCapabilityPicker();
  const enabledField = createCheckbox('Enabled', 'agent-chat-agent-enabled', true);
  const archivedField = createCheckbox('Archived', 'agent-chat-agent-archived', false);

  const card = createCard(
    'Workspace Agent Binding',
    'Bind the selected workspace to a backend agent directory and choose which dispatch roles it should handle here.',
  );
  const heading = card.querySelector('h4');
  if (heading) {
    heading.id = 'agent-chat-agent-editor-title';
    heading.textContent = 'Edit Workspace Binding';
  }

  const directChatSection = createDisclosureSection(
    'Agent Direct Chat',
    'Handle direct messages and tagged chat in an agent session without starting a pipeline.',
    'agent-chat-direct-chat-section',
  );
  directChatSection.setOpen(true);
  directChatSection.body.append(
    directChatEnabledField.row,
    harnessField.row,
    modelField.row,
    lookupStatus,
    workingDirectoryField.row,
  );

  const intro = document.createElement('p');
  intro.className = 'wm-settings__port-note';
  intro.textContent = 'Use the short form below for this workspace binding. Open the advanced sections only when you need routing overrides or prompt customization.';

  const identityNote = document.createElement('p');
  identityNote.className = 'wm-settings__port-note';
  identityNote.style.display = 'none';

  const identitySection = createDisclosureSection(
    'Manual identity fields',
    'Only use these if the shared connection is not available. When the workspace connection exists, the bot and workspace values are inherited automatically.',
    'agent-chat-identity-overrides',
  );
  identitySection.body.append(agentBotField.row, agentWorkspaceField.row);
  const publicProfileSection = createDisclosureSection(
    'Public Nostr profile',
    'These kind-0 fields can be edited and republished without changing the immutable agent identity.',
    'agent-chat-public-profile-section',
  );
  publicProfileSection.body.append(
    publicNameField.row,
    publicPictureField.row,
    publicAboutField.row,
    publicNip05Field.row,
  );

  const chatTemplateSection = createDisclosureSection(
    'Chat Dispatch Template',
    'Open this only when the default chat prompt contract needs an override for this local agent.',
    'agent-chat-chat-template-section',
  );
  chatTemplateSection.body.append(
    chatPromptTemplateField.row,
    createPlaceholderNote(
      'Chat placeholders',
      [
        '{{chat_runtime_event}}',
        '{{agent_id}}',
        '{{agent_label}}',
        '{{workspace_owner_npub}}',
        '{{channel_id}}',
        '{{thread_id}}',
        '{{bot_npub}}',
        '{{managed_by_npub}}',
        '{{session_id}}',
        '{{recent_turn_count}}',
        '{{participants}}',
        '{{recent_turns}}',
        '{{merge_package_json}}',
        '{{yoke_context_command}}',
        '{{yoke_history_command}}',
        '{{yoke_search_command}}',
        '{{yoke_related_command}}',
        '{{yoke_reply_current_command}}',
        '{{yoke_context_status}}',
        '{{chat_dispatch_instructions}}',
      ],
    ),
  );

  const taskTemplateSection = createDisclosureSection(
    'Task Dispatch Template',
    'Open this only when the default task dispatch prompt needs an override for this local agent.',
    'agent-chat-task-template-section',
  );
  taskTemplateSection.body.append(
    taskPromptTemplateField.row,
    createPlaceholderNote(
      'Task placeholders',
      [
        '{{dispatch_reason}}',
        '{{task_id}}',
        '{{flow_id}}',
        '{{flow_run_id}}',
        '{{flow_step}}',
        '{{scope_id}}',
        '{{scope_lineage}}',
        '{{title}}',
        '{{description}}',
      ],
    ),
  );

  const flowDispatchTemplateSection = createDisclosureSection(
    'Flow Dispatch Template',
    'Open this only when the kickoff pipeline prompt needs an override for this local agent.',
    'agent-chat-flow-template-section',
  );
  flowDispatchTemplateSection.body.append(
    flowDispatchPromptTemplateField.row,
    createPlaceholderNote(
      'Flow placeholders',
      [
        '{{dispatch_reason}}',
        '{{task_id}}',
        '{{flow_id}}',
        '{{scope_id}}',
        '{{scope_lineage}}',
        '{{title}}',
        '{{description}}',
      ],
    ),
  );

  const taskReviewTemplateSection = createDisclosureSection(
    'Task Review Template',
    'Open this only when the review pipeline prompt needs an override for this local agent.',
    'agent-chat-task-review-template-section',
  );
  taskReviewTemplateSection.body.append(
    taskReviewPromptTemplateField.row,
    createPlaceholderNote(
      'Review placeholders',
      [
        '{{dispatch_reason}}',
        '{{task_id}}',
        '{{flow_id}}',
        '{{flow_run_id}}',
        '{{flow_step}}',
        '{{state}}',
        '{{title}}',
        '{{description}}',
      ],
    ),
  );

  const approvalDispatchTemplateSection = createDisclosureSection(
    'Approval Dispatch Template',
    'Open this only when the approval-continuation prompt needs an override for this local agent.',
    'agent-chat-approval-template-section',
  );
  approvalDispatchTemplateSection.body.append(
    approvalDispatchPromptTemplateField.row,
    createPlaceholderNote(
      'Approval placeholders',
      [
        '{{dispatch_reason}}',
        '{{approval_id}}',
        '{{flow_id}}',
        '{{flow_run_id}}',
        '{{flow_step}}',
        '{{approval_state}}',
      ],
    ),
  );

  const saveButton = createButton(
    'Save Agent',
    'agent-chat-save-agent',
    'Create or update local Agent Dispatch agent',
  );
  const closeButton = createButton(
    'Done',
    'agent-chat-close-agent-editor',
    'Close Agent Dispatch local agent editor',
  );
  closeButton.addEventListener('click', () => setModalVisible(modal.overlay, false));
  wireModalClose(modal.overlay, () => setModalVisible(modal.overlay, false));

  card.append(
    agentIdField.row,
    labelField.row,
    directChatSection.element,
    intro,
    identityNote,
    capabilityPicker.row,
    enabledField.row,
    archivedField.row,
    identitySection.element,
    publicProfileSection.element,
    chatTemplateSection.element,
    taskTemplateSection.element,
    flowDispatchTemplateSection.element,
    taskReviewTemplateSection.element,
    approvalDispatchTemplateSection.element,
    createInlineActions(saveButton, closeButton),
  );
  modal.panel.append(...card.childNodes);
  setModalVisible(modal.overlay, false);

  function applyInheritedIdentity(subscription) {
    const inheritedBot = subscription?.botNpub?.trim() || '';
    const inheritedWorkspace = subscription?.workspaceOwnerNpub?.trim() || '';
    const hasInheritedIdentity = inheritedBot.length > 0 && inheritedWorkspace.length > 0;

    setPanelVisible(identitySection.element, !hasInheritedIdentity);
    identityNote.style.display = hasInheritedIdentity ? '' : 'none';

    if (hasInheritedIdentity) {
      identityNote.textContent = `This agent will reuse bot ${inheritedBot} and workspace ${inheritedWorkspace} from the shared connection.`;
      agentBotField.input.value = inheritedBot;
      agentWorkspaceField.input.value = inheritedWorkspace;
      identitySection.setOpen(false);
      return;
    }

    identityNote.textContent = '';
    identitySection.setOpen(true);
  }

  function setFocusState(focusField, options = {}) {
    chatTemplateSection.setOpen(focusField === 'chat-template');
    taskTemplateSection.setOpen(focusField === 'task-template');
    flowDispatchTemplateSection.setOpen(focusField === 'flow-template');
    taskReviewTemplateSection.setOpen(focusField === 'review-template');
    approvalDispatchTemplateSection.setOpen(focusField === 'approval-template');
  }

  return {
    card: modal.overlay,
    saveButton,
    closeButton,
    agentIdField,
    labelField,
    agentBotField,
    agentWorkspaceField,
    publicNameField,
    publicPictureField,
    publicAboutField,
    publicNip05Field,
    harnessSelect: harnessField.select,
    modelSelect: modelField.select,
    workingDirectoryField,
    directChatEnabledField,
    browseDirectoryButton,
    chatPromptTemplateField,
    taskPromptTemplateField,
    flowDispatchPromptTemplateField,
    taskReviewPromptTemplateField,
    approvalDispatchPromptTemplateField,
    capabilityPicker,
    enabledField,
    archivedField,
    applyInheritedIdentity,
    setRuntimeConfig(config, selectedHarness = '', selectedModel = '') {
      lookupController.setConfig(config, {
        harness: selectedHarness,
        model: selectedModel || 'default',
      });
    },
    setRuntimeConfigUnavailable(message) {
      lookupController.setUnavailable(message);
    },
    setFocusState,
    open() {
      setModalVisible(modal.overlay, true);
    },
    close() {
      setModalVisible(modal.overlay, false);
    },
  };
}

export function createPrimaryAgentNameModal({ onCreate, onBrowseDirectory, standalone = false } = {}) {
  const modal = createModalShell({
    testId: 'agent-chat-agent-name-modal',
    labelledBy: 'agent-chat-agent-name-title',
  });
  modal.panel.style.width = 'min(560px,100%)';

  const heading = document.createElement('h3');
  heading.id = 'agent-chat-agent-name-title';
  heading.textContent = 'Create Agent Profile';

  const note = document.createElement('p');
  note.className = 'wm-settings__port-note';
  note.textContent = standalone
    ? 'Create a sovereign local agent profile. Its Nostr identity is generated into the encrypted local vault and cannot be exported.'
    : 'Create a sovereign local agent profile and non-exportable Nostr identity for this workspace.';

  const nameField = createInput('Agent name', 'Lara', 'agent-chat-agent-name');
  const workingDirectoryField = createInput('Working Directory', '/workspace/lara', 'agent-chat-agent-working-directory');
  const harnessField = createLookupField('Harness', 'agent-chat-agent-create-harness', 'Agent profile harness');
  const modelField = createLookupField('Model', 'agent-chat-agent-create-model', 'Agent profile model');
  const lookupStatus = createStatusLine();
  lookupStatus.setAttribute('aria-live', 'polite');
  lookupStatus.setAttribute('data-testid', 'agent-chat-agent-create-lookup-status');
  const lookupController = createAgentModelLookupController({
    harnessSelect: harnessField.select,
    modelSelect: modelField.select,
    status: lookupStatus,
  });
  const pictureField = createInput('Public picture URL (optional)', 'https://...', 'agent-chat-agent-create-picture');
  const aboutField = createTextarea('Public about (optional)', 'What this agent does', 'agent-chat-agent-create-about', 3);
  const nip05Field = createInput('NIP-05 (optional)', 'agent@example.com', 'agent-chat-agent-create-nip05');
  const advancedPanel = document.createElement('div');
  advancedPanel.setAttribute('data-testid', 'agent-chat-agent-name-advanced-panel');
  advancedPanel.style.cssText = 'display:none;margin-top:12px;padding:12px;border:1px solid var(--wm-border-muted, rgba(255,255,255,0.14));border-radius:8px;background:rgba(127,127,127,0.04);';

  const advancedNote = document.createElement('p');
  advancedNote.className = 'wm-settings__port-note';
  advancedNote.style.margin = '0 0 8px 0';
  advancedNote.textContent = 'Choose the backend agent directory. Use the same directory when this workspace should be handled by the same local agent process.';

  let browseDirectoryButton = null;
  if (typeof onBrowseDirectory === 'function') {
    browseDirectoryButton = createButton(
      'Browse...',
      'agent-chat-agent-name-directory-browse',
      'Browse for the backend agent working directory',
    );
    const directoryInputRow = document.createElement('div');
    directoryInputRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
    workingDirectoryField.input.style.flex = '1 1 auto';
    workingDirectoryField.input.style.minWidth = '0';
    directoryInputRow.append(workingDirectoryField.input, browseDirectoryButton);
    workingDirectoryField.row.append(directoryInputRow);
    browseDirectoryButton.addEventListener('click', (event) => {
      event.preventDefault();
      onBrowseDirectory({
        initialPath: workingDirectoryField.input.value.trim(),
        onSelect: (path) => {
          directoryTouched = true;
          workingDirectoryField.input.value = path;
          workingDirectoryField.input.dispatchEvent(new Event('input', { bubbles: true }));
          workingDirectoryField.input.focus();
        },
      });
    });
  }

  advancedPanel.append(
    advancedNote,
    workingDirectoryField.row,
    harnessField.row,
    modelField.row,
    lookupStatus,
    pictureField.row,
    aboutField.row,
    nip05Field.row,
  );

  const preview = document.createElement('dl');
  preview.className = 'wm-settings__detail-list';
  preview.style.cssText = 'display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 12px;margin:14px 0 0;';

  const statusLine = createStatusLine();
  statusLine.setAttribute('data-testid', 'agent-chat-agent-name-status');

  const createButtonEl = createButton(
    'Create Profile',
    'agent-chat-agent-name-submit',
    standalone ? 'Create sovereign local agent profile' : 'Create Agent Dispatch workspace binding from name',
  );
  const cancelButton = createButton(
    'Cancel',
    'agent-chat-agent-name-cancel',
    'Close workspace binding creation',
  );
  const advancedButton = createButton(
    'Advanced',
    'agent-chat-agent-name-advanced-toggle',
    standalone ? 'Show agent profile fields' : 'Show advanced workspace binding fields',
  );

  let advancedOpen = false;
  let directoryTouched = false;

  function close() {
    setModalVisible(modal.overlay, false);
  }

  function deriveDefaultWorkingDirectory(agentId) {
    return `/workspace/${agentId}`;
  }

  function deriveDefaults(name, options = {}) {
    const label = name.trim();
    const agentId = label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'agent';
    const customWorkingDirectory = typeof options.workingDirectory === 'string'
      ? options.workingDirectory.trim()
      : '';
    return {
      agentId,
      label: label || 'Agent',
      workingDirectory: customWorkingDirectory || deriveDefaultWorkingDirectory(agentId),
      harness: harnessField.select.value.trim(),
      model: modelValueForPayload(modelField.select.value),
      picture: pictureField.input.value.trim() || null,
      about: aboutField.input.value.trim() || null,
      nip05: nip05Field.input.value.trim() || null,
      capabilities: ['chat_intercept', 'task_dispatch', 'comment_dispatch', 'task_review'],
    };
  }

  function syncAdvancedDirectoryToName() {
    if (directoryTouched) {
      return;
    }
    const defaults = deriveDefaults(nameField.input.value);
    workingDirectoryField.input.value = defaults.workingDirectory;
  }

  function setAdvancedOpen(open) {
    advancedOpen = Boolean(open);
    advancedPanel.style.display = advancedOpen ? '' : 'none';
    advancedButton.textContent = advancedOpen ? 'Hide Advanced' : 'Advanced';
    advancedButton.setAttribute(
      'aria-label',
      advancedOpen
        ? (standalone ? 'Hide agent profile fields' : 'Hide advanced workspace binding fields')
        : (standalone ? 'Show agent profile fields' : 'Show advanced workspace binding fields'),
    );
    advancedButton.setAttribute('aria-expanded', String(advancedOpen));
    if (advancedOpen) {
      syncAdvancedDirectoryToName();
    }
    renderPreview();
  }

  function renderPreview() {
    const defaults = deriveDefaults(nameField.input.value, {
      workingDirectory: advancedOpen ? workingDirectoryField.input.value : '',
    });
    preview.replaceChildren();
    [
      ['Profile ID', defaults.agentId],
      ['Label', defaults.label],
      ['Backend Directory', defaults.workingDirectory],
      ['Identity', 'Generated directly into the encrypted local vault'],
      ['Harness', defaults.harness],
      ['Capabilities', 'Chat, Task, Comment, Task Review'],
    ].forEach(([label, value]) => {
      const term = document.createElement('dt');
      term.style.fontWeight = '600';
      term.textContent = label;
      const detail = document.createElement('dd');
      detail.style.margin = '0';
      detail.textContent = value;
      preview.append(term, detail);
    });
  }

  nameField.input.addEventListener('input', () => {
    syncAdvancedDirectoryToName();
    renderPreview();
  });
  workingDirectoryField.input.addEventListener('input', () => {
    directoryTouched = true;
    renderPreview();
  });
  nameField.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      createButtonEl.click();
    }
  });
  advancedButton.addEventListener('click', () => {
    setAdvancedOpen(!advancedOpen);
    if (advancedOpen) {
      workingDirectoryField.input.focus();
    }
  });
  cancelButton.addEventListener('click', close);
  wireModalClose(modal.overlay, close);

  createButtonEl.addEventListener('click', async () => {
    const name = nameField.input.value.trim();
    if (!name) {
      statusLine.textContent = 'Enter an agent name.';
      nameField.input.focus();
      return;
    }
    if (!harnessField.select.value || harnessField.select.disabled) {
      statusLine.textContent = 'Select an available harness before creating the profile.';
      harnessField.select.focus();
      return;
    }
    if (modelField.select.disabled) {
      statusLine.textContent = 'The selected harness has no available model configuration.';
      modelField.select.focus();
      return;
    }
    createButtonEl.disabled = true;
    statusLine.textContent = standalone ? 'Creating agent profile...' : 'Creating workspace binding...';
    try {
      const defaults = deriveDefaults(name, {
        workingDirectory: advancedOpen ? workingDirectoryField.input.value : '',
      });
      await onCreate?.(defaults);
      statusLine.textContent = standalone ? 'Agent profile created.' : 'Workspace binding created.';
      close();
    } catch (error) {
      statusLine.textContent = error instanceof Error
        ? error.message
        : standalone ? 'Failed to create agent profile.' : 'Failed to create workspace binding.';
    } finally {
      createButtonEl.disabled = false;
    }
  });

  modal.panel.append(
    heading,
    note,
    nameField.row,
    advancedPanel,
    preview,
    createInlineActions(advancedButton, createButtonEl, cancelButton),
    statusLine,
  );
  renderPreview();

  return {
    element: modal.overlay,
    setRuntimeConfig(config, selectedHarness = '', selectedModel = '') {
      lookupController.setConfig(config, { harness: selectedHarness, model: selectedModel || 'default' });
    },
    setRuntimeConfigUnavailable(message) {
      lookupController.setUnavailable(message);
    },
    open(defaultName = '') {
      statusLine.textContent = '';
      nameField.input.value = defaultName;
      directoryTouched = false;
      workingDirectoryField.input.value = deriveDefaults(defaultName).workingDirectory;
      setAdvancedOpen(standalone);
      renderPreview();
      setModalVisible(modal.overlay, true);
      nameField.input.focus();
      nameField.input.select();
    },
  };
}
