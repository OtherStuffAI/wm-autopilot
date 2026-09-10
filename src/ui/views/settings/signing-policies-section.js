import {
  reissueSigningCapability,
  saveSigningPolicy,
  setSigningPolicyEnabled,
} from '../../services/signing-policies.js';
import { element, overview, disclosure, policyStatus, identifier } from './signing-policy-presentation.js';
import { towerForgejoSetup, summaryList } from './signing-policy-details.js';
export { describeNip98Target, describeNostrKindRule } from './signing-policy-presentation.js';
import { createSigningPolicyImport } from './signing-policy-import.js';

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

export function createSigningPoliciesSection({ confirmAction = (message) => window.confirm(message), createState } = {}) {
  const root = element('section', undefined, 'wm-card wm-signing-policies');
  root.dataset.testid = 'signing-policies-settings-section';
  root.setAttribute('aria-label', 'Manage signing policies');
  const intro = element('p', 'Choose which signing permissions matching sessions receive. New sessions receive enabled policies; existing sessions keep their issued permissions until you apply updates.');
  const add = element('button', 'Add policy', 'wm-button primary');
  add.type = 'button';
  add.disabled = true;
  add.dataset.testid = 'signing-policy-add';
  add.setAttribute('aria-label', 'Add signing policy');
  add.setAttribute('aria-expanded', 'false');
  add.setAttribute('aria-controls', 'signing-policy-import-panel');
  const toolbar = element('div', undefined, 'wm-signing-policies__toolbar');
  toolbar.append(intro, add);
  const status = element('p', 'Loading signing policies…', 'wm-signing-policies__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.dataset.testid = 'signing-policies-status';
  const content = element('div', undefined, 'wm-signing-policies__content');
  root.append(toolbar, status);

  let inventory = { policies: [], sessions: [] };
  let selectedId = null;
  let detail = null;
  const importer = createSigningPolicyImport({
    getExistingIds: () => inventory.policies.map((policy) => policy.id),
    onCreated: (id) => refresh(id),
  });
  importer.hidden = true;
  importer.id = 'signing-policy-import-panel';
  add.addEventListener('click', () => {
    importer.hidden = !importer.hidden;
    add.setAttribute('aria-expanded', String(!importer.hidden));
    if (!importer.hidden) importer.querySelector('textarea')?.focus();
  });
  root.append(importer, content);

  function reportError(error) {
    status.textContent = error instanceof Error ? error.message : "Signing policies could not be loaded.";
    status.dataset.state = 'error';
    add.disabled = true;
    content.replaceChildren();
  }

  function receiveSnapshot(snapshot) {
    ({ inventory, selectedId, detail } = snapshot);
    add.disabled = false;
    status.textContent = snapshot.notice || "Signing policies loaded.";
    status.dataset.state = "ready";
    renderContent();
  }

  const state = (async () => {
    const factory = createState || (await import("./signing-policy-state.js")).createSigningPolicyState;
    return factory(receiveSnapshot, reportError);
  })();

  async function refresh(preferredId = selectedId, notice) {
    status.textContent = 'Loading signing policies…';
    status.dataset.state = 'loading';
    try {
      await (await state).refresh(preferredId, notice);
    } catch (error) {
      reportError(error);
    }
  }

  // Settings replaces the section when navigating away; release the liveQuery.
  if (!createState) {
    const observer = new MutationObserver(() => {
      if (root.isConnected) return;
      observer.disconnect();
      void state.then((store) => store.destroy()).catch(reportError);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function renderHistory(history) {
    const section = disclosure('Revision history', 'signing-policy-history');
    const list = element('ol');
    for (const entry of history || []) {
      list.append(element('li', `Revision ${entry.revision} · ${entry.action} · ${entry.actorNpub} · ${entry.at}`));
    }
    if (!list.children.length) list.append(element('li', 'No recorded revisions.'));
    section.append(list);
    return section;
  }

  function renderSessions(sessions) {
    const section = disclosure(`Affected sessions (${sessions.length})`, 'signing-policy-sessions');
    const note = element('p', 'These sessions have this policy in their issued or currently assigned permissions. Current means the complete issued policy set matches current assignments and revisions; stale means it differs. Applying updated permissions replaces the entire session permission snapshot, including other policies, and revokes the old capability immediately.');
    if (sessions.length) section.append(note);
    const list = element('ul', undefined, 'wm-signing-policy-sessions');
    for (const session of sessions || []) {
      const item = element('li');
      const state = element('strong', `Session ${identifier(session.sessionId)} · ${session.policyState}`);
      state.dataset.testid = `signing-policy-session-${session.policyState}`;
      const scope = disclosure('Session identifiers', 'signing-policy-session-identifiers');
      scope.append(element('p', `Session ID: ${session.sessionId}`), element('p', `Profile ID: ${session.profileId || 'none'}`), element('p', `Workspace ID: ${session.workspaceId || 'none'}`));
      const button = element('button', 'Apply updated permissions', 'wm-button secondary');
      button.type = 'button';
      button.dataset.testid = 'signing-policy-reissue';
      button.setAttribute('aria-label', `Apply updated permissions to session ${session.sessionId}`);
      button.addEventListener('click', async () => {
        if (!confirmAction(`Revoke the current capability for ${session.sessionId} and replace its entire permission snapshot with current assignments and policy revisions? A failed reissue leaves it revoked.`)) return;
        button.disabled = true;
        status.textContent = `Applying updated permissions…`;
        status.dataset.state = 'loading';
        try {
          await reissueSigningCapability(session.sessionId);
          await refresh(selectedId, 'Updated permissions issued. The old capability was revoked; the live broker client adopts the replacement on its next call.');
        } catch (error) {
          status.textContent = `${error instanceof Error ? error.message : 'Reissue failed'} The old capability remains revoked; restart that session to recover.`;
          status.dataset.state = 'error';
          button.disabled = false;
        }
      });
      item.append(state, scope, button);
      list.append(item);
    }
    if (!list.children.length) list.append(element('li', 'No active sessions are affected by this policy.'));
    section.append(list);
    return section;
  }

  function renderEditor(policy) {
    const section = disclosure('Advanced: restrictions and policy JSON', 'signing-policy-editor');
    section.append(element('p', policy.builtIn === 'baseline' ? 'This is the starting permission set for every session. Enabled assigned policies can add permissions.' : 'This policy adds permissions to the built-in baseline and other assigned policies. Event tags constrain signed content; they do not control where it is published.'));
    if (!policy.nip98Targets?.length) section.append(element('p', 'No HTTP destinations granted by this policy.'));
    section.append(summaryList(policy));
    if (policy.editable === false || policy.builtIn === 'baseline') {
      section.append(element('pre', JSON.stringify(policy, null, 2)));
      return section;
    }
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
    save.setAttribute('aria-label', 'Save new policy revision');
    save.dataset.testid = 'signing-policy-save';
    save.addEventListener('click', async () => {
      save.disabled = true;
      status.textContent = `Saving ${policy.name}…`;
      status.dataset.state = 'loading';
      try {
        const draft = JSON.parse(textarea.value);
        if (draft.enabled !== policy.enabled) throw new Error('Use the Enable / Disable button to change policy status.');
        await saveSigningPolicy(policy.id, draft);
        await refresh(policy.id, `${policy.name} saved as a new revision. Existing session permissions were not changed.`);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Policy save failed.';
        status.dataset.state = 'error';
        save.disabled = false;
      }
    });
    const actions = element('div', undefined, 'wm-settings-page__actions');
    actions.append(save);
    section.append(label, actions);
    return section;
  }

  function renderPolicyHeader(policy) {
    const header = element('header', undefined, 'wm-signing-policies__policy-header');
    header.append(element('h2', policy.name));
    const actions = element('div', undefined, 'wm-signing-policies__actions');
    const badge = element('strong', policyStatus(policy), 'wm-signing-policy-badge');
    badge.dataset.testid = 'signing-policy-status';
    actions.append(badge);
    header.append(actions);
    if (policy.editable === false || policy.builtIn === 'baseline') return header;
    const enabled = element('button', policy.enabled ? 'Disable policy' : 'Enable policy', 'wm-button secondary');
    enabled.type = 'button';
    enabled.dataset.testid = 'signing-policy-enable-toggle';
    enabled.setAttribute('aria-pressed', String(policy.enabled));
    enabled.addEventListener('click', async () => {
      enabled.disabled = true;
      status.dataset.state = 'loading';
      status.textContent = 'Updating policy status…';
      try {
        await setSigningPolicyEnabled(policy.id, !policy.enabled);
        await refresh(policy.id, `${policy.name} ${policy.enabled ? 'disabled' : 'enabled'}. Existing sessions keep their issued permissions until you apply updates.`);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Policy state update failed.';
        status.dataset.state = 'error';
        enabled.disabled = false;
      }
    });
    enabled.setAttribute('aria-label', enabled.textContent);
    actions.append(enabled);
    return header;
  }

  function renderContent() {
    const nav = element('nav', undefined, 'wm-signing-policies__list');
    nav.setAttribute('aria-label', 'Signing policy inventory');
    nav.dataset.testid = 'signing-policy-inventory';
    for (const policy of inventory.policies) {
      const button = element('button', policy.name);
      button.append(element('small', policyStatus(policy)));
      button.type = 'button';
      button.setAttribute('aria-label', `${policy.name}: ${policyStatus(policy)}`);
      button.dataset.testid = 'signing-policy-select';
      button.setAttribute('aria-current', String(policy.id === selectedId));
      button.addEventListener('click', async () => {
        await refresh(policy.id);
      });
      nav.append(button);
    }
    const policy = detail?.policy;
    const body = element('div', undefined, 'wm-signing-policies__detail');
    if (policy) {
      const setup = towerForgejoSetup(policy);
      body.append(
        renderPolicyHeader(policy),
        element('p', policy.description),
        overview(policy),
        ...(setup ? [setup] : []),
        renderEditor(policy),
        renderHistory(detail?.history),
        renderSessions(detail.sessions),
      );
    }
    content.replaceChildren(nav, body);
  }

  void refresh();
  return root;
}
