import {
  createButton,
  createCard,
  createCheckbox,
  createInput,
  createInlineActions,
  createTextarea,
} from './agent-chat-shared-ui.js';

const EVENT_LABELS = {
  direct_message: 'Direct message',
  chat_mention: 'Chat mention',
  chat_observe: 'Chat observe',
  document_created: 'Document created',
  document_comment_tagged: 'Document comment tagged',
  document_comment_observe: 'Document comment observe',
  task_assigned: 'Task assigned',
  task_comment: 'Task comment',
  approval_assigned: 'Approval assigned',
  flow_step_assigned: 'Flow step assigned',
};

const POLICY_ACTIONS = [
  'respond',
  'ignore',
  'observe',
  'index',
  'work',
  'acknowledge',
  'notify',
  'process',
  'run_flow_handler',
];

function formatLabel(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
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

function createPipelineSelect({ label, definitions, selectedId, testId }) {
  const wrapper = document.createElement('label');
  wrapper.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  wrapper.textContent = label;

  const select = document.createElement('select');
  select.className = 'wm-input';
  select.setAttribute('aria-label', label);
  select.setAttribute('data-testid', testId);

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = 'Built-in default';
  select.append(empty);

  definitions.forEach((definition) => {
    const option = document.createElement('option');
    option.value = stableBuiltInDispatchPipelineValue(definition);
    option.textContent = definition.name || definition.slug || definition.id || 'Pipeline';
    select.append(option);
  });
  select.value = normaliseBuiltInDispatchPipelineSelection(selectedId);
  wrapper.append(select);
  return { wrapper, select };
}

function createActionSelect(policy) {
  const select = document.createElement('select');
  select.className = 'wm-input';
  select.setAttribute('aria-label', `${EVENT_LABELS[policy.eventType] || policy.eventType} action`);
  select.setAttribute('data-testid', `agent-chat-profile-policy-action-${policy.eventType}`);
  POLICY_ACTIONS.forEach((action) => {
    const option = document.createElement('option');
    option.value = action;
    option.textContent = formatLabel(action);
    select.append(option);
  });
  select.value = POLICY_ACTIONS.includes(policy.defaultAction) ? policy.defaultAction : 'ignore';
  return select;
}

function createMetaGrid(workspace) {
  const grid = document.createElement('dl');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 14px;margin:12px 0 0;';
  const rows = [
    ['Workspace', workspace.workspaceTitle || workspace.workspaceOwnerNpub],
    ['Tower', workspace.towerUrl || workspace.backendBaseUrl],
    ['Owner', workspace.workspaceOwnerNpub],
    ['App', workspace.appPubkey || workspace.sourceAppNpub],
    ['Connection', workspace.connectionHealth],
    ['Yoke sync', workspace.yokeSyncStatus],
    ['Onboarding', workspace.relayOnboardingStatus],
  ];
  rows.forEach(([label, value]) => {
    const item = document.createElement('div');
    const term = document.createElement('dt');
    term.className = 'wm-settings__port-note';
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.style.cssText = 'margin:2px 0 0;overflow-wrap:anywhere;';
    detail.textContent = value || 'Not set';
    item.append(term, detail);
    grid.append(item);
  });
  return grid;
}

function getWorkspaceContext(appendedContexts, contextKind, targetId = null, eventType = null) {
  return (Array.isArray(appendedContexts) ? appendedContexts : []).find((context) => (
    context.contextKind === contextKind
    && (context.targetId || null) === targetId
    && (context.eventType || null) === eventType
  ))?.contextText || '';
}

function createPolicyRows({ policies, definitions, controlsDisabled }) {
  const rows = [];
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:12px;';

  policies.forEach((policy) => {
    const row = document.createElement('section');
    row.style.cssText = 'display:grid;grid-template-columns:minmax(140px,1fr) minmax(110px,0.7fr) minmax(180px,1fr);gap:8px;align-items:end;padding:10px;border:1px solid var(--wm-border-muted, rgba(255,255,255,0.12));border-radius:8px;';
    row.setAttribute('data-testid', `agent-chat-profile-policy-${policy.eventType}`);

    const toggles = document.createElement('div');
    const event = document.createElement('strong');
    event.textContent = EVENT_LABELS[policy.eventType] || formatLabel(policy.eventType);
    const enabled = createCheckbox('Enabled', `agent-chat-profile-policy-enabled-${policy.eventType}`, policy.enabled !== false);
    const quiet = createCheckbox('Quiet', `agent-chat-profile-policy-quiet-${policy.eventType}`, policy.quietMode === true);
    toggles.append(event, enabled.row, quiet.row);

    const actionWrap = document.createElement('label');
    actionWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    actionWrap.textContent = 'Action';
    const action = createActionSelect(policy);
    actionWrap.append(action);

    const pipeline = createPipelineSelect({
      label: 'Pipeline',
      definitions,
      selectedId: policy.pipelineDefinitionId || '',
      testId: `agent-chat-profile-policy-pipeline-${policy.eventType}`,
    });
    const prompt = createTextarea('Prompt context', '', `agent-chat-profile-policy-context-${policy.eventType}`, 3);
    prompt.input.value = policy.promptContext || '';
    const right = document.createElement('div');
    right.append(pipeline.wrapper, prompt.row);

    [enabled.input, quiet.input, action, pipeline.select, prompt.input].forEach((input) => {
      input.disabled = controlsDisabled;
    });
    row.append(toggles, actionWrap, right);
    wrapper.append(row);
    rows.push({ policy, enabled, quiet, action, pipeline, prompt });
  });

  return { wrapper, rows };
}

function createTargetKindSelect(value, testId) {
  const select = document.createElement('select');
  select.className = 'wm-input';
  select.setAttribute('aria-label', 'Scope or channel');
  select.setAttribute('data-testid', testId);
  ['scope', 'channel'].forEach((kind) => {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = formatLabel(kind);
    select.append(option);
  });
  select.value = value === 'channel' ? 'channel' : 'scope';
  return select;
}

function getVisibleTargets(bundle, kind) {
  const visible = bundle?.visibleContext || {};
  const rows = kind === 'channel' ? visible.channels : visible.scopes;
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      id: String(row?.id || '').trim(),
      label: String(row?.label || row?.id || '').trim(),
      scopeId: String(row?.scopeId || '').trim(),
    }))
    .filter((row) => row.id);
}

function createTargetDatalist(id, targets) {
  const datalist = document.createElement('datalist');
  datalist.id = id;
  targets.forEach((target) => {
    const option = document.createElement('option');
    option.value = target.id;
    option.label = target.scopeId ? `${target.label} (${target.scopeId})` : target.label;
    datalist.append(option);
  });
  return datalist;
}

function createScopeChannelRows({ bundle, definitions, controlsDisabled }) {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:12px;';
  wrapper.setAttribute('data-testid', 'agent-chat-profile-scope-channel-manager');
  const byKey = new Map();
  for (const target of getVisibleTargets(bundle, 'scope')) {
    byKey.set(`scope:${target.id}`, {
      targetKind: 'scope',
      targetId: target.id,
      pipelineDefinitionId: '',
      contextText: '',
    });
  }
  for (const target of getVisibleTargets(bundle, 'channel')) {
    byKey.set(`channel:${target.id}`, {
      targetKind: 'channel',
      targetId: target.id,
      pipelineDefinitionId: '',
      contextText: '',
    });
  }
  (Array.isArray(bundle.pipelineOverrides) ? bundle.pipelineOverrides : []).forEach((override) => {
    if (override.targetKind !== 'scope' && override.targetKind !== 'channel') {
      return;
    }
    const key = `${override.targetKind}:${override.targetId || ''}`;
    byKey.set(key, {
      targetKind: override.targetKind,
      targetId: override.targetId || '',
      pipelineDefinitionId: override.pipelineDefinitionId || '',
      pipelineVersionPolicy: override.pipelineVersionPolicy || 'latest',
      contextText: '',
    });
  });
  (Array.isArray(bundle.appendedContexts) ? bundle.appendedContexts : []).forEach((context) => {
    if (context.contextKind !== 'scope' && context.contextKind !== 'channel') {
      return;
    }
    const key = `${context.contextKind}:${context.targetId || ''}`;
    const row = byKey.get(key) || {
      targetKind: context.contextKind,
      targetId: context.targetId || '',
      pipelineDefinitionId: '',
      contextText: '',
    };
    row.contextText = context.contextText || '';
    byKey.set(key, row);
  });

  const rows = [...byKey.values(), { targetKind: 'scope', targetId: '', pipelineDefinitionId: '', pipelineVersionPolicy: 'latest', contextText: '' }];
  const controls = rows.map((rowData, index) => {
    const row = document.createElement('section');
    row.style.cssText = 'display:grid;grid-template-columns:minmax(110px,0.45fr) minmax(160px,0.8fr) minmax(180px,1fr);gap:8px;align-items:start;padding:10px;border:1px solid var(--wm-border-muted, rgba(255,255,255,0.12));border-radius:8px;';
    row.setAttribute('data-testid', `agent-chat-profile-scope-channel-row-${index}`);

    const kindWrap = document.createElement('label');
    kindWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    kindWrap.textContent = 'Target';
    const kind = createTargetKindSelect(rowData.targetKind, `agent-chat-profile-target-kind-${index}`);
    kindWrap.append(kind);

    const target = createInput('Target id', 'scope-or-channel-id', `agent-chat-profile-target-id-${index}`);
    target.input.value = rowData.targetId || '';
    const scopeListId = `agent-chat-visible-scopes-${index}`;
    const channelListId = `agent-chat-visible-channels-${index}`;
    target.row.append(
      createTargetDatalist(scopeListId, getVisibleTargets(bundle, 'scope')),
      createTargetDatalist(channelListId, getVisibleTargets(bundle, 'channel')),
    );
    const updateTargetList = () => {
      target.input.setAttribute('list', kind.value === 'channel' ? channelListId : scopeListId);
    };
    kind.addEventListener('change', updateTargetList);
    updateTargetList();

    const pipeline = createPipelineSelect({
      label: 'Pipeline override',
      definitions,
      selectedId: rowData.pipelineDefinitionId || '',
      testId: `agent-chat-profile-target-pipeline-${index}`,
    });
    const context = createTextarea('Appended context', '', `agent-chat-profile-target-context-${index}`, 3);
    context.input.value = rowData.contextText || '';
    const right = document.createElement('div');
    right.append(pipeline.wrapper, context.row);

    [kind, target.input, pipeline.select, context.input].forEach((input) => {
      input.disabled = controlsDisabled;
    });
    row.append(kindWrap, target.row, right);
    wrapper.append(row);
    return { kind, target, pipeline, context };
  });

  return {
    wrapper,
    getPipelineOverrides() {
      return controls
        .map(({ kind, target, pipeline }) => ({
          targetKind: kind.value,
          targetId: target.input.value.trim(),
          pipelineDefinitionId: pipeline.select.value.trim(),
          pipelineVersionPolicy: 'latest',
        }))
        .filter((row) => row.targetId && row.pipelineDefinitionId);
    },
    getAppendedContexts() {
      return controls
        .map(({ kind, target, context }) => ({
          contextKind: kind.value,
          targetId: target.input.value.trim(),
          eventType: null,
          contextText: context.input.value,
        }))
        .filter((row) => row.targetId && row.contextText.trim());
    },
  };
}

export function createProfileWorkspaceSettingsCard({
  subscription,
  pipelineDefinitions,
  canManage,
  onSave,
}) {
  const bundle = subscription?.profileWorkspace;
  if (!bundle?.profile || !bundle?.workspace) {
    return null;
  }
  const definitions = Array.isArray(pipelineDefinitions) ? pipelineDefinitions : [];
  const controlsDisabled = canManage === false;
  const card = createCard('Profile Workspace Settings');
  card.setAttribute('data-testid', 'agent-chat-profile-workspace-settings');
  card.append(createMetaGrid(bundle.workspace));

  const defaultsGrid = document.createElement('div');
  defaultsGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:14px;';
  const profilePipeline = createPipelineSelect({
    label: 'Profile default pipeline',
    definitions,
    selectedId: bundle.profile.defaultPipelineDefinitionId || '',
    testId: 'agent-chat-profile-default-pipeline',
  });
  const workspacePipeline = createPipelineSelect({
    label: 'Workspace default pipeline',
    definitions,
    selectedId: bundle.workspace.defaultPipelineDefinitionId || '',
    testId: 'agent-chat-workspace-default-pipeline',
  });
  defaultsGrid.append(profilePipeline.wrapper, workspacePipeline.wrapper);

  const profileContext = createTextarea('Profile prompt context', '', 'agent-chat-profile-prompt-context', 4);
  profileContext.input.value = bundle.profile.promptContext || '';
  const workspaceContext = createTextarea('Workspace context', '', 'agent-chat-workspace-context', 4);
  workspaceContext.input.value = bundle.workspace.workspaceContext || getWorkspaceContext(bundle.appendedContexts, 'workspace');
  card.append(defaultsGrid, profileContext.row, workspaceContext.row);

  const policyHeading = document.createElement('h5');
  policyHeading.textContent = 'Event Policies';
  policyHeading.style.margin = '16px 0 0';
  const { wrapper: policiesWrapper, rows: policyRows } = createPolicyRows({
    policies: Array.isArray(bundle.policies) ? bundle.policies : [],
    definitions,
    controlsDisabled,
  });
  card.append(policyHeading, policiesWrapper);

  const scopeHeading = document.createElement('h5');
  scopeHeading.textContent = 'Scope And Channel Context';
  scopeHeading.style.margin = '16px 0 0';
  const scopedRows = createScopeChannelRows({
    bundle,
    definitions,
    controlsDisabled,
  });
  card.append(scopeHeading, scopedRows.wrapper);

  [profilePipeline.select, workspacePipeline.select, profileContext.input, workspaceContext.input].forEach((input) => {
    input.disabled = controlsDisabled;
  });

  if (!controlsDisabled && typeof onSave === 'function') {
    const saveButton = createButton('Save Workspace Settings', 'agent-chat-profile-workspace-save', 'Save profile workspace settings');
    const status = document.createElement('p');
    status.className = 'wm-settings__port-note';
    status.setAttribute('aria-live', 'polite');
    saveButton.addEventListener('click', async () => {
      saveButton.disabled = true;
      status.textContent = 'Saving workspace settings...';
      try {
        await onSave({
          profileDefaultPipelineDefinitionId: profilePipeline.select.value,
          profilePromptContext: profileContext.input.value,
          workspaceDefaultPipelineDefinitionId: workspacePipeline.select.value,
          workspaceContext: workspaceContext.input.value,
          policies: policyRows.map(({ policy, enabled, quiet, action, pipeline, prompt }) => ({
            eventType: policy.eventType,
            enabled: enabled.input.checked,
            defaultAction: action.value,
            pipelineDefinitionId: pipeline.select.value,
            pipelineVersionPolicy: 'latest',
            promptContext: prompt.input.value,
            quietMode: quiet.input.checked,
          })),
          pipelineOverrides: scopedRows.getPipelineOverrides(),
          appendedContexts: [
            ...(Array.isArray(bundle.appendedContexts) ? bundle.appendedContexts : [])
              .filter((context) => context.contextKind !== 'scope' && context.contextKind !== 'channel'),
            ...scopedRows.getAppendedContexts(),
          ],
        });
        status.textContent = 'Workspace settings saved.';
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Failed to save workspace settings.';
      } finally {
        saveButton.disabled = false;
      }
    });
    card.append(createInlineActions(saveButton), status);
  }

  return card;
}

export function createProfileWorkspaceSettingsPanel(options) {
  return createProfileWorkspaceSettingsCard(options) || document.createDocumentFragment();
}
