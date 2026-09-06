import { SETTING_GROUPS, settingGroup, settingValueState } from './settings-purpose.js';

export function createStatus() {
  const status = document.createElement('p');
  status.className = 'wm-instance-settings__status';
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('data-testid', 'instance-settings-status');
  return status;
}

export function createButton(label, className = 'wm-button secondary', type = 'button') {
  const button = document.createElement('button');
  button.type = type;
  button.className = className;
  button.textContent = label;
  return button;
}

function createBadge(text, tone = 'muted') {
  const badge = document.createElement('span');
  badge.className = `wm-instance-settings__badge is-${tone}`;
  badge.textContent = text;
  return badge;
}

function createCode(text) {
  const code = document.createElement('code');
  code.className = 'wm-instance-settings__code';
  code.textContent = text;
  return code;
}

function formatCleanupStatus(status) {
  if (status === 'cleanupSupported') return 'Env cleanup supported';
  if (status === 'cleanupReadOnly') return 'Env file is read-only';
  return 'Env cleanup unavailable';
}

function formatSource(source) {
  if (source === 'env_auto_import') return 'Imported automatically';
  if (source === 'env_manual_import') return 'Imported from env';
  if (source === 'app') return 'App managed';
  return 'Runtime env';
}

function formatCandidateSource(source) {
  if (source === 'process+file') return 'Runtime + file';
  if (source === 'file') return 'Env file';
  return 'Runtime';
}

function groupByCategory(items) {
  return items.reduce((groups, item) => {
    const key = settingGroup(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
    return groups;
  }, new Map());
}

function resolveSettingValue(setting) {
  if (setting.configured) return setting.maskedValue || 'Configured';
  if (setting.maskedValue) return setting.maskedValue;
  if (setting.defaultValue) return setting.defaultValue;
  return 'No override set';
}

function resolveSettingTone(setting) {
  return setting.configured ? 'success' : 'muted';
}

function resolveSettingState(setting) {
  return settingValueState(setting);
}

function resolveCandidateState(candidate) {
  if (candidate.conflict) return { label: 'Conflict', tone: 'danger' };
  if (candidate.validationError) return { label: 'Invalid', tone: 'danger' };
  if (candidate.configured) return { label: 'App value exists', tone: 'muted' };
  if (candidate.bootstrapOnly) return { label: 'Bootstrap env', tone: 'warning' };
  if (candidate.canAutoImport) return { label: 'Ready', tone: 'success' };
  return { label: candidate.blockedReason || 'Blocked', tone: 'warning' };
}

function shouldPreselectCandidate(candidate) {
  return Boolean(
    candidate.canAutoImport ||
      (!candidate.configured && !candidate.bootstrapOnly && !candidate.validationError),
  );
}

function createMetaList(items) {
  const meta = document.createElement('div');
  meta.className = 'wm-instance-settings__meta-list';
  items.filter(Boolean).forEach((item) => {
    const span = document.createElement('span');
    span.textContent = item;
    meta.append(span);
  });
  return meta;
}

export function createHeader(actions, status) {
  const header = document.createElement('div');
  header.className = 'wm-instance-settings__header';

  const copy = document.createElement('div');
  copy.className = 'wm-instance-settings__header-copy';
  const heading = document.createElement('h2');
  heading.textContent = 'Server configuration';
  const description = document.createElement('p');
  description.className = 'wm-settings__port-note';
  description.textContent = 'Saved values override environment values. A setting with no override can use a runtime default or remain unused until its feature is enabled. Restart labels show when a change takes effect.';
  copy.append(heading, description, status);

  header.append(copy, actions);
  return header;
}

export function createCleanupNotice(payload) {
  const notice = document.createElement('div');
  notice.className = 'wm-instance-settings__notice';
  notice.setAttribute('data-testid', 'instance-settings-cleanup-status');

  const tone = payload.cleanupStatus === 'cleanupSupported' ? 'success' : 'warning';
  notice.append(createBadge(formatCleanupStatus(payload.cleanupStatus), tone));
  if (payload.envFile?.path) {
    notice.append(createCode(payload.envFile.path));
  }
  return notice;
}

export function createImportPanel(candidates, selectedKeys, initializeSelection) {
  const panel = document.createElement('section');
  panel.className = 'wm-instance-settings__panel';
  panel.setAttribute('data-testid', 'instance-settings-import-panel');

  const header = document.createElement('div');
  header.className = 'wm-instance-settings__panel-header';
  const heading = document.createElement('h3');
  heading.textContent = 'Environment values available for review';
  const count = createBadge(`${candidates.length} found`, 'muted');
  header.append(heading, count);

  const list = document.createElement('div');
  list.className = 'wm-instance-settings__candidate-list';
  list.setAttribute('role', 'list');
  list.setAttribute('data-testid', 'instance-settings-import-list');

  candidates.forEach((candidate) => {
    list.append(createImportCandidate(candidate, selectedKeys, initializeSelection));
  });

  panel.append(header, list);
  return panel;
}

function createImportCandidate(candidate, selectedKeys, initializeSelection) {
  const item = document.createElement('label');
  item.className = 'wm-instance-settings__candidate';
  item.setAttribute('role', 'listitem');
  item.setAttribute('data-testid', `instance-settings-import-${candidate.key}`);

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.disabled = candidate.bootstrapOnly;
  checkbox.checked = initializeSelection ? shouldPreselectCandidate(candidate) : selectedKeys.has(candidate.key);
  checkbox.setAttribute('aria-label', `Select ${candidate.label} for import or cleanup`);
  if (checkbox.checked) selectedKeys.add(candidate.key);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selectedKeys.add(candidate.key);
    else selectedKeys.delete(candidate.key);
  });

  const main = document.createElement('span');
  main.className = 'wm-instance-settings__candidate-main';

  const title = document.createElement('span');
  title.className = 'wm-instance-settings__candidate-title';
  title.textContent = candidate.label;

  const env = document.createElement('span');
  env.className = 'wm-instance-settings__candidate-env';
  env.append(createCode([...new Set(candidate.envKeys)].join(', ')));
  if (candidate.maskedEnvValue) {
    env.append(document.createTextNode(' = '));
    env.append(createCode(candidate.maskedEnvValue));
  }

  const meta = createMetaList([
    formatCandidateSource(candidate.source),
    candidate.requiresRestart ? 'Restart required' : null,
    candidate.cleanupAllowed ? 'Cleanup allowed' : null,
  ]);
  main.append(title, env, meta);

  const state = resolveCandidateState(candidate);
  const aside = document.createElement('span');
  aside.className = 'wm-instance-settings__candidate-state';
  aside.append(createBadge(state.label, state.tone));
  if (candidate.conflict || candidate.blockedReason || candidate.validationError) {
    const reason = document.createElement('span');
    reason.className = 'wm-instance-settings__reason';
    reason.textContent = candidate.validationError || candidate.blockedReason || 'Env aliases disagree';
    aside.append(reason);
  }

  item.append(checkbox, main, aside);
  return item;
}

function createSettingMeta(setting) {
  const meta = document.createElement('details');
  meta.className = 'wm-instance-settings__setting-meta';
  const summary = document.createElement('summary');
  summary.textContent = setting.requiresRestart ? 'Technical details · restart after changes' : 'Technical details';
  summary.setAttribute('aria-label', `Technical details for ${setting.label}`);
  meta.append(summary, createCode([...new Set(setting.envAliases)].join(', ')));
  return meta;
}

function createSettingEditor(setting, onSave, onCancel) {
  const form = document.createElement('form');
  form.className = 'wm-instance-settings__editor';
  form.setAttribute('data-testid', `instance-setting-editor-${setting.key}`);

  const options = Array.isArray(setting.options) ? setting.options : [];
  const input = options.length > 0
    ? document.createElement('select')
    : document.createElement('input');
  input.className = 'wm-input';
  if (options.length > 0) {
    options.forEach((option) => {
      const choice = document.createElement('option');
      choice.value = option;
      choice.textContent = option
        .split('_')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
      input.append(choice);
    });
    input.value = setting.value || setting.maskedValue || setting.defaultValue || options[0];
  } else {
    input.type = setting.secret ? 'password' : 'text';
    input.placeholder = setting.secret ? 'Replace secret' : 'Set value';
  }
  input.setAttribute('aria-label', `Value for ${setting.label}`);
  input.setAttribute('data-testid', `instance-setting-input-${setting.key}`);

  const save = createButton('Save', 'wm-button', 'submit');
  save.setAttribute('aria-label', `Save ${setting.label}`);
  save.setAttribute('data-testid', `instance-setting-save-${setting.key}`);

  const cancel = createButton('Cancel');
  cancel.setAttribute('aria-label', `Cancel editing ${setting.label}`);
  cancel.addEventListener('click', onCancel);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const nextValue = input.value.trim();
    if (!nextValue) return;
    if (
      setting.requiresRestart
      && typeof window !== 'undefined'
      && typeof window.confirm === 'function'
      && !window.confirm(`Save ${setting.label}? The new value will not take effect until an operator restarts Autopilot from outside this managed session.`)
    ) {
      return;
    }
    save.disabled = true;
    try {
      await onSave(nextValue);
    } finally {
      save.disabled = false;
    }
  });

  form.append(input, save, cancel);
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => input.focus());
  }
  return form;
}

function createSettingRow(setting, options) {
  const row = document.createElement('article');
  row.className = 'wm-instance-settings__setting-row';
  row.setAttribute('data-testid', `instance-setting-${setting.key}`);

  const main = document.createElement('div');
  main.className = 'wm-instance-settings__setting-main';

  const title = document.createElement('h4');
  title.textContent = setting.label;
  const description = document.createElement('p');
  description.textContent = setting.description;
  main.append(title, description, createSettingMeta(setting));

  const summary = document.createElement('div');
  summary.className = 'wm-instance-settings__setting-summary';
  const value = document.createElement('div');
  value.className = 'wm-instance-settings__setting-value';
  value.textContent = resolveSettingValue(setting);
  summary.append(value, createBadge(resolveSettingState(setting), resolveSettingTone(setting)));

  const controls = document.createElement('div');
  controls.className = 'wm-instance-settings__setting-actions';
  if (!setting.bootstrapOnly) {
    controls.append(createEditButton(setting, options));

    if (setting.configured) {
      controls.append(createDeleteButton(setting, options));
    }
  }

  row.append(main, summary, controls);

  if (options.isEditing) {
    row.append(createSettingEditor(
      setting,
      (nextValue) => options.onSave(setting, nextValue),
      () => options.onEdit(null),
    ));
  }

  return row;
}

function createEditButton(setting, options) {
  const edit = createButton(setting.configured ? 'Replace' : 'Set');
  edit.setAttribute('aria-label', `${setting.configured ? 'Replace' : 'Set'} ${setting.label}`);
  edit.setAttribute('data-testid', `instance-setting-edit-${setting.key}`);
  edit.addEventListener('click', () => options.onEdit(setting.key));
  return edit;
}

function createDeleteButton(setting, options) {
  const clear = createButton('Reset to inherited', 'wm-button secondary danger');
  clear.setAttribute('aria-label', `Reset ${setting.label} to its inherited or default value`);
  clear.setAttribute('data-testid', `instance-setting-delete-${setting.key}`);
  clear.addEventListener('click', async () => {
    clear.disabled = true;
    try {
      await options.onDelete(setting);
    } finally {
      clear.disabled = false;
    }
  });
  return clear;
}

export function createSettingsPanel(settings, options) {
  const wrapper = document.createElement('div');
  wrapper.className = 'wm-instance-settings__settings';

  const order = Object.keys(SETTING_GROUPS);
  const groups = [...groupByCategory(settings)].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  for (const [category, items] of groups) {
    wrapper.append(createSettingCategory(category, items, options));
  }

  return wrapper;
}

function createSettingCategory(category, items, options) {
  const section = document.createElement('details');
  section.className = 'wm-instance-settings__category';
  section.open = items.some((item) => item.key === options.editingKey);
  const heading = document.createElement('summary');
  heading.textContent = `${SETTING_GROUPS[category]?.[0] || category} · ${items.length}`;
  heading.setAttribute('aria-label', `Open ${SETTING_GROUPS[category]?.[0] || category} settings`);
  heading.dataset.testid = `instance-settings-category-${category}`;
  const purpose = document.createElement('p');
  purpose.className = 'wm-settings__port-note';
  purpose.textContent = SETTING_GROUPS[category]?.[1] || '';
  section.append(heading, purpose);

  const list = document.createElement('div');
  list.className = 'wm-instance-settings__setting-list';
  items.forEach((setting) => {
    list.append(createSettingRow(setting, {
      ...options,
      isEditing: options.editingKey === setting.key,
    }));
  });

  section.append(list);
  return section;
}
