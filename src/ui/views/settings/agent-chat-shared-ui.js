function createTonePill(label, tone = 'muted') {
  const pill = document.createElement('span');
  const styles = {
    success: 'background:var(--wm-pill-success-bg);border:1px solid var(--wm-pill-success-border);color:var(--wm-pill-success-fg);',
    warning: 'background:var(--wm-pill-warning-bg);border:1px solid var(--wm-pill-warning-border);color:var(--wm-pill-warning-fg);',
    danger: 'background:var(--wm-pill-danger-bg);border:1px solid var(--wm-pill-danger-border);color:var(--wm-pill-danger-fg);',
    muted: 'background:var(--wm-pill-muted-bg);border:1px solid var(--wm-pill-muted-border);color:var(--wm-pill-muted-fg);',
  };
  pill.style.cssText = `display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;font-size:0.85em;${styles[tone] || styles.muted}`;
  pill.textContent = label;
  return pill;
}

function formatCapability(capability) {
  if (capability === 'chat_intercept') {
    return 'Chat Dispatch';
  }
  if (capability === 'task_dispatch') {
    return 'Task Dispatch';
  }
  if (capability === 'comment_dispatch') {
    return 'Comment Dispatch';
  }
  if (capability === 'flow_dispatch') {
    return 'Flow Dispatch';
  }
  if (capability === 'task_review') {
    return 'Task Review';
  }
  if (capability === 'approval_dispatch') {
    return 'Approval Dispatch';
  }
  return capability;
}

function createDispatchReferenceCard({
  title,
  enabledAgents,
  description,
  promptPreview,
  actionLabel,
  onAction,
  actionTestId,
}) {
  const card = createCard(title, description);
  const enabled = document.createElement('p');
  enabled.className = 'wm-settings__port-note';
  enabled.textContent = enabledAgents.length > 0
    ? `Enabled on: ${enabledAgents.join(', ')}`
    : 'Enabled on: none';
  const promptLabel = document.createElement('div');
  promptLabel.className = 'wm-settings__port-note';
  promptLabel.style.marginTop = '12px';
  promptLabel.textContent = 'Current prompt template';
  const prompt = document.createElement('pre');
  prompt.style.cssText = 'margin:8px 0 0;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);background:rgba(15,23,42,0.72);overflow:auto;font-size:0.85em;line-height:1.45;white-space:pre-wrap;';
  prompt.textContent = promptPreview;
  card.append(enabled, promptLabel, prompt);
  if (typeof onAction === 'function' && typeof actionLabel === 'string' && actionLabel) {
    const actionButton = createButton(actionLabel, actionTestId, actionLabel);
    actionButton.addEventListener('click', () => onAction());
    card.append(createInlineActions(actionButton));
  }
  return card;
}

export function createStatusLine() {
  const line = document.createElement('p');
  line.className = 'wm-settings__port-note';
  line.setAttribute('aria-live', 'polite');
  return line;
}

export function createInput(labelText, placeholder, testId, optional = false) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:10px;';
  row.textContent = labelText + (optional ? ' (optional)' : '');

  const input = document.createElement('input');
  input.className = 'wm-input';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', labelText);
  input.setAttribute('data-testid', testId);
  row.append(input);

  return { row, input };
}

export function createTextarea(labelText, placeholder, testId, rows = 10) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:10px;';
  row.textContent = labelText;

  const textarea = document.createElement('textarea');
  textarea.className = 'wm-input';
  textarea.rows = rows;
  textarea.placeholder = placeholder;
  textarea.setAttribute('aria-label', labelText);
  textarea.setAttribute('data-testid', testId);
  textarea.style.whiteSpace = 'pre-wrap';
  row.append(textarea);

  return { row, input: textarea };
}

export function createCheckbox(labelText, testId, checked = true) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px;';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('aria-label', labelText);
  input.setAttribute('data-testid', testId);

  const text = document.createElement('span');
  text.textContent = labelText;
  row.append(input, text);

  return { row, input };
}

export function createCard(title, description) {
  const card = document.createElement('section');
  card.className = 'wm-card';
  card.style.cssText = 'padding:14px;margin-top:12px;';

  const heading = document.createElement('h4');
  heading.textContent = title;
  card.append(heading);

  if (description) {
    const note = document.createElement('p');
    note.className = 'wm-settings__port-note';
    note.textContent = description;
    card.append(note);
  }

  return card;
}

export function createButton(label, testId, ariaLabel) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wm-button secondary';
  button.textContent = label;
  if (testId) {
    button.setAttribute('data-testid', testId);
  }
  if (ariaLabel) {
    button.setAttribute('aria-label', ariaLabel);
  }
  return button;
}

export function createInlineActions(...buttons) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;';
  row.append(...buttons);
  return row;
}

export function setPanelVisible(panel, visible) {
  panel.style.display = visible ? '' : 'none';
}

export function createPlaceholderNote(title, placeholders) {
  const wrapper = document.createElement('div');
  wrapper.style.marginTop = '10px';
  const heading = document.createElement('div');
  heading.className = 'wm-settings__port-note';
  heading.textContent = title;
  const body = document.createElement('div');
  body.className = 'wm-settings__port-note';
  body.style.marginTop = '4px';
  body.textContent = placeholders.join(', ');
  wrapper.append(heading, body);
  return wrapper;
}

export function createCapabilityPicker() {
  const fieldset = document.createElement('fieldset');
  fieldset.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:12px;padding:12px;border:1px solid var(--wm-border-muted, rgba(255,255,255,0.12));border-radius:10px;';
  fieldset.setAttribute('aria-label', 'Agent capabilities');
  fieldset.setAttribute('data-testid', 'agent-chat-agent-capabilities');

  const legend = document.createElement('legend');
  legend.textContent = 'Capabilities';
  legend.style.cssText = 'padding:0 6px;font-weight:600;';
  fieldset.append(legend);

  const note = document.createElement('p');
  note.className = 'wm-settings__port-note';
  note.style.margin = '0 0 4px 0';
  note.textContent = 'Enable only the dispatch roles this workspace should send to the backend agent.';
  fieldset.append(note);

  const capabilityControls = [
    ['chat_intercept', createCheckbox('Chat Dispatch', 'agent-chat-capability-chat-dispatch', true)],
    ['task_dispatch', createCheckbox('Task Dispatch', 'agent-chat-capability-task-dispatch', false)],
    ['comment_dispatch', createCheckbox('Comment Dispatch', 'agent-chat-capability-comment-dispatch', false)],
    ['flow_dispatch', createCheckbox('Flow Dispatch', 'agent-chat-capability-flow-dispatch', false)],
    ['task_review', createCheckbox('Task Review', 'agent-chat-capability-task-review', false)],
    ['approval_dispatch', createCheckbox('Approval Dispatch', 'agent-chat-capability-approval-dispatch', false)],
  ];
  fieldset.append(...capabilityControls.map(([, control]) => control.row));

  return {
    row: fieldset,
    setSelectedCapabilities(capabilities = []) {
      const selected = new Set(Array.isArray(capabilities) ? capabilities : []);
      capabilityControls.forEach(([capability, control]) => {
        control.input.checked = capability === 'chat_intercept'
          ? selected.has('chat_intercept') || selected.size === 0
          : selected.has(capability);
      });
    },
    getSelectedCapabilities() {
      const capabilities = [];
      capabilityControls.forEach(([capability, control]) => {
        if (control.input.checked) {
          capabilities.push(capability);
        }
      });
      return capabilities.length > 0 ? capabilities : ['chat_intercept'];
    },
  };
}

function normaliseAgentCapabilities(agent) {
  return Array.isArray(agent?.capabilities) && agent.capabilities.length > 0
    ? agent.capabilities
    : ['chat_intercept'];
}

function findDispatchRoute(routes, triggerKind, capability) {
  return Array.isArray(routes)
    ? routes.find((route) => route.triggerKind === triggerKind && route.capability === capability) ?? null
    : null;
}

function stableBuiltInDispatchPipelineValue(definition) {
  const name = definition?.name || definition?.slug;
  if (
    name === 'fd-agent-dispatch-chat'
    || name === 'fd-agent-dispatch-task-response'
    || name === 'fd-agent-dispatch-comment-response'
  ) {
    return name;
  }
  return definition?.id || '';
}

function normaliseBuiltInDispatchPipelineSelection(value) {
  if (value === 'shared:7df6cda5438c') return 'fd-agent-dispatch-chat';
  if (value === 'shared:4e7e569c4c5f') return 'fd-agent-dispatch-task-response';
  if (value === 'shared:e4cd47744fb8') return 'fd-agent-dispatch-comment-response';
  return value || '';
}

function findDefaultPipelineId(definitions, defaultName, fallbackToFirst = true) {
  const list = Array.isArray(definitions) ? definitions : [];
  if (defaultName) {
    const exact = list.find((definition) => definition?.name === defaultName || definition?.slug === defaultName);
    const value = stableBuiltInDispatchPipelineValue(exact);
    if (value) {
      return value;
    }
  }
  return fallbackToFirst ? stableBuiltInDispatchPipelineValue(list[0]) : '';
}

function createPipelineSelect({ title, definitions, selectedId, defaultName, fallbackToFirst = true }) {
  const label = document.createElement('label');
  label.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:12px;';
  label.textContent = `${title} pipeline`;

  const select = document.createElement('select');
  select.className = 'wm-input';
  select.setAttribute('aria-label', `${title} pipeline`);
  select.setAttribute('data-testid', `agent-chat-capability-pipeline-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = 'Select a pipeline';
  select.append(empty);

  definitions.forEach((definition) => {
    const option = document.createElement('option');
    option.value = stableBuiltInDispatchPipelineValue(definition);
    option.textContent = definition.name || definition.id || 'Pipeline';
    select.append(option);
  });
  select.value = normaliseBuiltInDispatchPipelineSelection(selectedId)
    || findDefaultPipelineId(definitions, defaultName, fallbackToFirst);
  label.append(select);
  return { label, select };
}

function createInputObjectEditor({ title, value }) {
  const label = document.createElement('label');
  label.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:12px;';
  label.textContent = `${title} input object`;

  const textarea = document.createElement('textarea');
  textarea.className = 'wm-input';
  textarea.rows = 8;
  textarea.spellcheck = false;
  textarea.value = JSON.stringify(value, null, 2);
  textarea.setAttribute('aria-label', `${title} input object`);
  textarea.setAttribute('data-testid', `agent-chat-capability-input-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
  textarea.style.cssText = 'font-family:var(--wm-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:0.86em;line-height:1.45;';
  label.append(textarea);
  return { label, textarea };
}

function parseInputObject(textarea) {
  const parsed = JSON.parse(textarea.value || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Pipeline input object must be a JSON object.');
  }
  return parsed;
}

function defaultInputObject({ title, promptPreview }) {
  const prompt = promptPreview && !promptPreview.startsWith('No ')
    ? promptPreview
    : `Handle this ${title.toLowerCase()} event. Use the dispatch, workspace, agent, record, routing, and runtime fields in this pipeline input.`;
  return {
    entry: {
      type: 'prompt',
      prompt,
    },
    prompt,
  };
}

function createPromptPreview({ sourceLabel, promptPreview }) {
  const details = document.createElement('details');
  details.style.marginTop = '10px';

  const summary = document.createElement('summary');
  summary.style.cssText = 'cursor:pointer;font-size:0.92em;color:var(--text-secondary);';
  summary.textContent = `Prompt preview · ${sourceLabel}`;

  const prompt = document.createElement('pre');
  prompt.className = 'wm-agent-dispatch-preview';
  prompt.textContent = promptPreview;

  details.append(summary, prompt);
  return details;
}

function createCapabilityCard({
  title,
  description,
  enabled,
  subscription,
  routeConfig,
  route,
  pipelineDefinitions = [],
  promptSource,
  promptPreview,
  onEdit,
  onToggle,
  onSaveRoute,
  toggleLabel,
  toggleDisabled = false,
  toggleDisabledReason = '',
}) {
  const card = document.createElement('article');
  card.className = 'wm-agent-dispatch-capability-card';

  const headingRow = document.createElement('div');
  headingRow.style.cssText = 'display:flex;justify-content:space-between;gap:12px;align-items:flex-start;';

  const headingBlock = document.createElement('div');
  headingBlock.style.flex = '1';

  const heading = document.createElement('h5');
  heading.style.cssText = 'margin:0;';
  heading.textContent = title;

  const note = document.createElement('p');
  note.className = 'wm-settings__port-note';
  note.style.margin = '6px 0 0 0';
  note.textContent = description;
  headingBlock.append(heading, note);

  const status = createTonePill(enabled ? 'On' : 'Off', enabled ? 'success' : 'muted');
  headingRow.append(headingBlock, status);
  card.append(headingRow);

  const sourceNote = document.createElement('p');
  sourceNote.className = 'wm-settings__port-note';
  sourceNote.style.margin = '12px 0 0 0';
  sourceNote.textContent = `Prompt source: ${promptSource}`;
  card.append(sourceNote);

  card.append(createPromptPreview({ sourceLabel: promptSource, promptPreview }));

  const toggleButton = createButton(toggleLabel, null, toggleLabel);
  const canToggle = typeof onToggle === 'function';
  toggleButton.disabled = toggleDisabled || !canToggle;
  if (!canToggle) {
    toggleButton.title = 'Agent Dispatch setup is shared and can only be changed by an administrator.';
  } else if (toggleDisabledReason) {
    toggleButton.title = toggleDisabledReason;
  }
  toggleButton.addEventListener('click', () => onToggle?.());

  const editButton = createButton('Edit Prompt', null, `Edit ${title} prompt`);
  editButton.disabled = typeof onEdit !== 'function';
  if (editButton.disabled) {
    editButton.title = 'Prompt editing is not available for this dispatch path yet.';
  }
  editButton.addEventListener('click', () => onEdit?.());

  card.append(createInlineActions(toggleButton, editButton));

  if (enabled && subscription && routeConfig) {
    const canSaveRoute = typeof onSaveRoute === 'function';
    const pipelineSelect = createPipelineSelect({
      title,
      definitions: pipelineDefinitions,
      selectedId: route?.pipelineDefinitionId || '',
      defaultName: routeConfig.defaultPipelineName,
      fallbackToFirst: routeConfig.defaultPipelineName !== '',
    });
    const inputObjectEditor = createInputObjectEditor({
      title,
      value: route?.inputTemplateJson && Object.keys(route.inputTemplateJson).length > 0
        ? route.inputTemplateJson
        : defaultInputObject({ title, promptPreview }),
    });
    const routeStatus = document.createElement('p');
    routeStatus.className = 'wm-settings__port-note';
    routeStatus.setAttribute('aria-live', 'polite');
    routeStatus.textContent = route
      ? `Pipeline route saved${route.enabled === false ? ' but disabled' : ''}${canSaveRoute ? '' : ' and shared read-only'}.`
      : 'Pipeline route required before this capability can dispatch.';

    const savePipelineButton = createButton(
      route ? 'Update Pipeline' : 'Save Pipeline',
      null,
      `Save ${title} pipeline route`,
    );
    pipelineSelect.select.disabled = !canSaveRoute;
    inputObjectEditor.textarea.disabled = !canSaveRoute;
    savePipelineButton.disabled = !canSaveRoute || pipelineDefinitions.length === 0;
    if (!canSaveRoute) {
      savePipelineButton.title = 'Agent Dispatch pipeline routes are shared and can only be changed by an administrator.';
    }
    savePipelineButton.addEventListener('click', async () => {
      if (!canSaveRoute) {
        routeStatus.textContent = 'Agent Dispatch pipeline routes are shared and can only be changed by an administrator.';
        return;
      }
      savePipelineButton.disabled = true;
      routeStatus.textContent = 'Saving pipeline route...';
      try {
        if (!pipelineSelect.select.value) {
          routeStatus.textContent = 'Select a pipeline first.';
          return;
        }
        const inputTemplateJson = parseInputObject(inputObjectEditor.textarea);
        await onSaveRoute?.({
          routeId: route?.routeId,
          subscriptionId: subscription.subscriptionId,
          triggerKind: routeConfig.triggerKind,
          capability: routeConfig.capability,
          pipelineDefinitionId: pipelineSelect.select.value,
          pipelineVersionPolicy: 'latest',
          enabled: true,
          priority: routeConfig.priority,
          activePolicy: routeConfig.activePolicy,
          matchJson: routeConfig.matchJson,
          inputTemplateJson,
        });
        routeStatus.textContent = 'Pipeline route saved.';
      } catch (error) {
        routeStatus.textContent = error instanceof Error ? error.message : 'Failed to save pipeline route.';
      } finally {
        savePipelineButton.disabled = false;
      }
    });

    card.append(
      pipelineSelect.label,
      inputObjectEditor.label,
      createInlineActions(savePipelineButton),
      routeStatus,
    );
  }

  return card;
}

export function createConfiguredDispatchesPanel(primaryAgent, defaults = {}, options = {}) {
  const wrapper = document.createElement('div');
  wrapper.style.marginTop = '12px';

  const heading = document.createElement('h4');
  heading.textContent = 'Selected Workspace Binding';
  wrapper.append(heading);

  const note = document.createElement('p');
  note.className = 'wm-settings__port-note';
  note.textContent = primaryAgent
    ? 'This binding tells the shared backend agent which roles to handle for the selected workspace subscription.'
    : 'Create a binding for the shared backend agent, then enable the dispatch roles it should handle in this workspace.';
  wrapper.append(note);

  if (!primaryAgent) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No agent binding is configured for the selected workspace yet.';
    wrapper.append(empty);
    if (typeof options.onCreateAgent === 'function') {
      const createAgentButton = createButton('Create Binding', 'agent-chat-capabilities-create-agent', 'Create Agent Dispatch workspace binding');
      createAgentButton.addEventListener('click', () => options.onCreateAgent());
      wrapper.append(createInlineActions(createAgentButton));
    }
    return wrapper;
  }

  const summary = document.createElement('section');
  summary.className = 'wm-card';
  summary.style.cssText = 'padding:14px;margin-top:12px;';

  const summaryHeading = document.createElement('h5');
  summaryHeading.style.cssText = 'margin:0;';
  summaryHeading.textContent = primaryAgent.label || primaryAgent.agentId || 'Local agent';

  const summaryNote = document.createElement('p');
  summaryNote.className = 'wm-settings__port-note';
  summaryNote.style.margin = '8px 0 0 0';
  summaryNote.textContent = `Backend agent directory: ${primaryAgent.workingDirectory || 'Not set'}`;

  const summaryPills = document.createElement('div');
  summaryPills.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;';
  summaryPills.append(
    createTonePill(primaryAgent.enabled === false ? 'Agent Disabled' : 'Agent Enabled', primaryAgent.enabled === false ? 'warning' : 'success'),
    createTonePill(`${normaliseAgentCapabilities(primaryAgent).length} Capabilities`, 'muted'),
  );
  const summaryActions = [];
  if (typeof options.onEditAgent === 'function') {
    const editButton = createButton('Edit Binding', 'agent-chat-capabilities-edit-agent', 'Edit Agent Dispatch workspace binding');
    editButton.addEventListener('click', () => options.onEditAgent(primaryAgent));
    summaryActions.push(editButton);
  }
  if (typeof options.onRemoveAgent === 'function') {
    const removeButton = createButton('Remove Binding', 'agent-chat-capabilities-remove-agent', 'Remove Agent Dispatch workspace binding');
    removeButton.addEventListener('click', () => options.onRemoveAgent(primaryAgent));
    summaryActions.push(removeButton);
  }
  summary.append(summaryHeading, summaryNote, summaryPills);
  if (summaryActions.length > 0) {
    summary.append(createInlineActions(...summaryActions));
  }
  wrapper.append(summary);

  const grid = document.createElement('div');
  grid.className = 'wm-agent-dispatch-capability-grid';

  const dispatchCards = [
    {
      capability: 'chat_intercept',
      triggerKind: 'chat',
      priority: 10,
      activePolicy: 'queue',
      defaultPipelineName: 'fd-agent-dispatch-chat',
      title: 'Chat Dispatch',
      description: 'When a workspace chat advisory matches a local agent, Wingmen reuses or creates the routed session and the agent must decide whether to respond in-thread or ignore.',
      promptKey: 'chatPromptTemplate',
      onEdit: options.onEditChatTemplate,
    },
    {
      capability: 'task_dispatch',
      triggerKind: 'task',
      priority: 20,
      activePolicy: 'skip',
      matchJson: { assignedTo: 'bot' },
      defaultPipelineName: 'fd-agent-dispatch-task-response',
      title: 'Task Dispatch',
      description: 'When a concrete ready task targets the bot, Wingmen reuses or creates the delivery session, queues the task prompt, and Night Watch keeps the worker moving.',
      promptKey: 'taskPromptTemplate',
      onEdit: options.onEditTaskTemplate,
    },
    {
      capability: 'comment_dispatch',
      triggerKind: 'comment',
      priority: 60,
      activePolicy: 'queue',
      defaultPipelineName: 'fd-agent-dispatch-comment-response',
      title: 'Comment Dispatch',
      description: 'When a task or document comment arrives, Wingmen routes the update through the comment dispatch pipeline.',
      promptKey: 'commentDispatchPromptTemplate',
      onEdit: null,
    },
    {
      capability: 'flow_dispatch',
      triggerKind: 'flow',
      priority: 30,
      activePolicy: 'skip',
      defaultPipelineName: 'fd-agent-dispatch-task-response',
      title: 'Flow Dispatch',
      description: 'When a kickoff task is new, assigned to the bot, and has a flow without a flow run, Wingmen routes it through the configured pipeline.',
      promptKey: 'flowDispatchPromptTemplate',
      onEdit: options.onEditFlowDispatchTemplate,
    },
    {
      capability: 'task_review',
      triggerKind: 'task_review',
      priority: 40,
      activePolicy: 'skip',
      defaultPipelineName: '',
      title: 'Task Review',
      description: 'When a flow-run task moves to review, Wingmen routes it through the configured review pipeline.',
      promptKey: 'taskReviewPromptTemplate',
      onEdit: options.onEditTaskReviewTemplate,
    },
    {
      capability: 'approval_dispatch',
      triggerKind: 'approval',
      priority: 50,
      activePolicy: 'queue',
      defaultPipelineName: 'fd-agent-dispatch-task-response',
      title: 'Approval Dispatch',
      description: 'When an approval record transitions to approved for a live flow run, Wingmen routes it through the configured approval pipeline.',
      promptKey: 'approvalDispatchPromptTemplate',
      onEdit: options.onEditApprovalDispatchTemplate,
    },
  ];

  const selectedCapabilities = new Set(normaliseAgentCapabilities(primaryAgent));
  grid.append(...dispatchCards.map((cardConfig) => {
    const promptOverride = typeof primaryAgent?.[cardConfig.promptKey] === 'string'
      ? primaryAgent[cardConfig.promptKey]
      : '';
    const defaultPrompt = typeof defaults?.[cardConfig.promptKey] === 'string'
      ? defaults[cardConfig.promptKey]
      : '';
    const preview = promptOverride || defaultPrompt || `No ${cardConfig.title.toLowerCase()} prompt is configured yet.`;
    const promptSource = promptOverride
      ? 'Agent override'
      : defaultPrompt
        ? 'Workspace default'
        : 'Missing';
    const enabled = primaryAgent.enabled !== false && selectedCapabilities.has(cardConfig.capability);
    const lastEnabledCapability = selectedCapabilities.size === 1 && selectedCapabilities.has(cardConfig.capability);
    const route = findDispatchRoute(options.dispatchRoutes, cardConfig.triggerKind, cardConfig.capability);

    return createCapabilityCard({
      title: cardConfig.title,
      description: cardConfig.description,
      enabled,
      subscription: options.subscription,
      routeConfig: cardConfig,
      route,
      pipelineDefinitions: Array.isArray(options.pipelineDefinitions) ? options.pipelineDefinitions : [],
      promptSource,
      promptPreview: preview,
      onEdit: typeof cardConfig.onEdit === 'function' ? () => cardConfig.onEdit(primaryAgent) : null,
      onToggle: typeof options.onToggleCapability === 'function'
        ? () => options.onToggleCapability(primaryAgent, cardConfig.capability, enabled)
        : null,
      onSaveRoute: options.onSaveRoute,
      toggleLabel: enabled ? 'Turn Off' : 'Turn On',
      toggleDisabled: primaryAgent.enabled === false || (lastEnabledCapability && enabled),
      toggleDisabledReason: primaryAgent.enabled === false
        ? 'Enable the agent first.'
        : lastEnabledCapability && enabled
          ? 'At least one dispatch capability must remain enabled on the agent.'
          : '',
    });
  }));
  wrapper.append(grid);

  return wrapper;
}

export { createTonePill, formatCapability };
