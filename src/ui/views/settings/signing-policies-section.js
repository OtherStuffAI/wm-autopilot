import {
  loadSigningPolicies,
  loadSigningPolicy,
  reissueSigningCapability,
  saveSigningPolicy,
  setSigningPolicyEnabled,
} from '../../services/signing-policies.js';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function draftFromPolicy(policy) {
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    enabled: policy.enabled,
    operations: policy.operations,
    eventKinds: policy.eventKinds,
    nostrKindRules: policy.nostrKindRules,
    nip98Targets: policy.nip98Targets,
    assignments: policy.assignments,
  };
}

export function describeNostrKindRule(rule) {
  const required = rule.requiredTags?.length
    ? rule.requiredTags.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(', ')
    : 'none';
  return `Kind ${rule.kind}: content ≤ ${rule.maxContentBytes} bytes; tags ≤ ${rule.maxTags} / ${rule.maxTagBytes} bytes; names ${rule.allowedTagNames.join(', ') || 'none'}; required ${required}`;
}

function summaryList(policy) {
  const list = element('dl', undefined, 'wm-signing-policy-summary');
  const rows = [
    ['Operations', (policy.operations || []).join(', ') || 'None'],
    ['Nostr kinds', (policy.eventKinds || []).join(', ') || 'None'],
    ['Profiles', policy.assignments?.profileIds?.join(', ') || (policy.assignments?.allSessions ? 'All sessions' : 'Unassigned')],
    ['Workspaces', policy.assignments?.workspaceIds?.join(', ') || (policy.assignments?.allSessions ? 'All sessions' : 'Unassigned')],
    ['Revision', String(policy.revision)],
  ];
  for (const [label, value] of rows) list.append(element('dt', label), element('dd', value));
  for (const rule of policy.nostrKindRules || []) {
    list.append(element('dt', 'Custom kind constraint'), element('dd', describeNostrKindRule(rule)));
  }
  for (const target of policy.nip98Targets || []) {
    const challenge = target.challenge;
    list.append(
      element('dt', 'NIP-98 target'),
      element('dd', `${target.origin} · ${target.methods.join('/')} · exact ${target.exactPaths.join(', ') || 'none'} · prefixes ${target.pathPrefixes.join(', ') || 'none'} · payload hash ${target.requireBodyHash ? 'required' : 'optional'}`),
      element('dt', 'Challenge tags'),
      element('dd', challenge
        ? `required ${challenge.requiredTags.join(', ')}; expiry ≤ ${challenge.allowedTags.find((rule) => rule.name === 'expiration')?.maxFutureSeconds || '?'} seconds`
        : 'No caller-supplied tags'),
    );
  }
  return list;
}

export function createSigningPoliciesSection({ confirmAction = (message) => window.confirm(message) } = {}) {
  const root = element('section', undefined, 'wm-card wm-signing-policies');
  root.dataset.testid = 'signing-policies-settings-section';
  root.setAttribute('aria-labelledby', 'signing-policies-title');
  const title = element('h2', 'Signing Policies');
  title.id = 'signing-policies-title';
  const intro = element('p', 'Review narrowly scoped signing authority. Saved revisions affect only new or deliberately reissued session capabilities.');
  const status = element('p', 'Loading signing policies…', 'wm-signing-policies__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.dataset.testid = 'signing-policies-status';
  const content = element('div', undefined, 'wm-signing-policies__content');
  root.append(title, intro, status, content);

  let inventory = { policies: [], sessions: [] };
  let selectedId = null;
  let detail = null;

  async function refresh(preferredId = selectedId) {
    status.textContent = 'Loading signing policies…';
    status.dataset.state = 'loading';
    try {
      inventory = await loadSigningPolicies();
      selectedId = inventory.policies.some((policy) => policy.id === preferredId)
        ? preferredId
        : inventory.policies[0]?.id || null;
      detail = selectedId ? await loadSigningPolicy(selectedId) : null;
      status.textContent = 'Signing policies loaded.';
      status.dataset.state = 'ready';
      renderContent();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Signing policies could not be loaded.';
      status.dataset.state = 'error';
      content.replaceChildren();
    }
  }

  function renderHistory(history) {
    const section = element('section');
    section.dataset.testid = 'signing-policy-history';
    section.append(element('h3', 'Revision history'));
    const list = element('ol');
    for (const entry of history || []) {
      list.append(element('li', `Revision ${entry.revision} · ${entry.action} · ${entry.actorNpub} · ${entry.at}`));
    }
    if (!list.children.length) list.append(element('li', 'Built-in baseline; no editable history.'));
    section.append(list);
    return section;
  }

  function renderSessions(sessions) {
    const section = element('section');
    section.dataset.testid = 'signing-policy-sessions';
    section.append(element('h3', 'Active session capabilities'));
    const note = element('p', 'Stale means the issued snapshot differs from current assignment revisions. Reissue immediately revokes the old bearer.');
    section.append(note);
    const list = element('ul', undefined, 'wm-signing-policy-sessions');
    for (const session of sessions || []) {
      const item = element('li');
      const state = element('strong', `${session.sessionId} · ${session.policyState}`);
      state.dataset.testid = `signing-policy-session-${session.policyState}`;
      const scope = element('span', `Profile ${session.profileId || 'none'} · workspace ${session.workspaceId || 'none'}`);
      const button = element('button', 'Revoke and reissue', 'wm-button danger');
      button.type = 'button';
      button.dataset.testid = 'signing-policy-reissue';
      button.setAttribute('aria-label', `Revoke and reissue signing capability for session ${session.sessionId}`);
      button.addEventListener('click', async () => {
        if (!confirmAction(`Revoke the current capability for ${session.sessionId} and issue current policy revisions? A failed reissue leaves it revoked.`)) return;
        button.disabled = true;
        status.textContent = `Reissuing ${session.sessionId}…`;
        try {
          await reissueSigningCapability(session.sessionId);
          status.textContent = `Capability for ${session.sessionId} was revoked and reissued. The live broker client will explicitly adopt it on its next call.`;
          await refresh(selectedId);
        } catch (error) {
          status.textContent = `${error instanceof Error ? error.message : 'Reissue failed'} The old capability remains revoked; restart that session to recover.`;
          status.dataset.state = 'error';
          button.disabled = false;
        }
      });
      item.append(state, scope, button);
      list.append(item);
    }
    if (!list.children.length) list.append(element('li', 'No active capabilities are affected.'));
    section.append(list);
    return section;
  }

  function renderEditor(policy) {
    const section = element('section');
    section.dataset.testid = 'signing-policy-editor';
    section.append(element('h3', 'Policy definition'), summaryList(policy));
    if (policy.editable === false || policy.builtIn === 'baseline') return section;
    const label = element('label');
    label.append(element('span', 'Advanced structured policy JSON'));
    const textarea = element('textarea');
    textarea.rows = 22;
    textarea.value = JSON.stringify(draftFromPolicy(policy), null, 2);
    textarea.dataset.testid = 'signing-policy-json';
    textarea.setAttribute('aria-label', `Structured JSON for ${policy.name}`);
    label.append(textarea);
    const save = element('button', 'Save new revision', 'wm-button primary');
    save.type = 'button';
    save.dataset.testid = 'signing-policy-save';
    save.addEventListener('click', async () => {
      save.disabled = true;
      status.textContent = `Saving ${policy.name}…`;
      try {
        const draft = JSON.parse(textarea.value);
        await saveSigningPolicy(policy.id, draft);
        status.textContent = `${policy.name} saved as a new revision. Existing capabilities were not changed.`;
        await refresh(policy.id);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Policy save failed.';
        status.dataset.state = 'error';
        save.disabled = false;
      }
    });
    const enabled = element('button', policy.enabled ? 'Disable policy' : 'Enable policy', 'wm-button secondary');
    enabled.type = 'button';
    enabled.dataset.testid = 'signing-policy-enable-toggle';
    enabled.setAttribute('aria-pressed', String(policy.enabled));
    enabled.addEventListener('click', async () => {
      enabled.disabled = true;
      try {
        await setSigningPolicyEnabled(policy.id, !policy.enabled);
        await refresh(policy.id);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Policy state update failed.';
        status.dataset.state = 'error';
        enabled.disabled = false;
      }
    });
    const actions = element('div', undefined, 'wm-settings-page__actions');
    actions.append(save, enabled);
    section.append(label, actions);
    return section;
  }

  function renderContent() {
    const nav = element('nav', undefined, 'wm-signing-policies__list');
    nav.setAttribute('aria-label', 'Signing policy inventory');
    nav.dataset.testid = 'signing-policy-inventory';
    for (const policy of inventory.policies) {
      const button = element('button', `${policy.name} · r${policy.revision}${policy.enabled ? '' : ' · disabled'}`);
      button.type = 'button';
      button.dataset.testid = 'signing-policy-select';
      button.setAttribute('aria-current', String(policy.id === selectedId));
      button.addEventListener('click', async () => {
        selectedId = policy.id;
        detail = await loadSigningPolicy(policy.id);
        renderContent();
      });
      nav.append(button);
    }
    const policy = detail?.policy || inventory.policies.find((item) => item.id === selectedId);
    const body = element('div', undefined, 'wm-signing-policies__detail');
    if (policy) {
      body.append(
        element('h2', policy.name),
        element('p', policy.description),
        renderEditor(policy),
        renderHistory(detail?.history),
        renderSessions(detail?.sessions || inventory.sessions),
      );
    }
    content.replaceChildren(nav, body);
  }

  void refresh();
  return root;
}
