import { saveAgentSigningMode } from '../../services/signing-policies.js';
import { element, identifier } from './signing-policy-presentation.js';
export { describeNip98Target, describeNostrKindRule } from './signing-policy-presentation.js';

function modeLabel(modeId) {
  return String(modeId || '').replace(/-/g, ' ');
}

function activeModeFromInventory(inventory) {
  return inventory?.activeMode || inventory?.mode?.mode || 'standard-agent';
}

function modeStatusText(session) {
  if (session.status === 'replacement-issued') {
    return `Session ${identifier(session.sessionId)} received a replacement capability.`;
  }
  if (session.status === 'restart-required') {
    return `Session ${identifier(session.sessionId)} needs restart: ${session.error || 'replacement was not issued'}.`;
  }
  return `Session ${identifier(session.sessionId)} is ${session.policyState || 'active'}.`;
}

export function createSigningPoliciesSection({ createState } = {}) {
  const root = element('section', undefined, 'wm-card wm-signing-policies');
  root.dataset.testid = 'signing-policies-settings-section';
  root.setAttribute('aria-label', 'Agent signing mode settings');

  const header = element('header', undefined, 'wm-signing-policies__toolbar');
  header.append(
    element('h2', 'Agent Signing Mode'),
    element('p', 'Choose what brokered agent capabilities may sign. Tower, Flight Deck, and Forgejo still authorize every signed request.'),
  );

  const status = element('p', 'Loading signing mode...', 'wm-signing-policies__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.dataset.testid = 'signing-policies-status';

  const content = element('div', undefined, 'wm-signing-policies__content');
  root.append(header, status, content);

  let inventory = { modes: [], sessions: [], activeMode: 'standard-agent' };
  let applyResults = [];

  function reportError(error) {
    status.textContent = error instanceof Error ? error.message : 'Signing mode could not be loaded.';
    status.dataset.state = 'error';
    content.replaceChildren();
  }

  function receiveSnapshot(snapshot) {
    inventory = snapshot.inventory || inventory;
    status.textContent = snapshot.notice || `Active mode: ${modeLabel(activeModeFromInventory(inventory))}.`;
    status.dataset.state = 'ready';
    renderContent();
  }

  const state = (async () => {
    const factory = createState || (await import('./signing-policy-state.js')).createSigningPolicyState;
    return factory(receiveSnapshot, reportError);
  })();

  async function refresh(notice) {
    status.textContent = 'Loading signing mode...';
    status.dataset.state = 'loading';
    try {
      await (await state).refresh(null, notice);
    } catch (error) {
      reportError(error);
    }
  }

  if (!createState) {
    const observer = new MutationObserver(() => {
      if (root.isConnected) return;
      observer.disconnect();
      void state.then((store) => store.destroy()).catch(reportError);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function applyMode(modeId, button) {
    button.disabled = true;
    status.textContent = `Applying ${modeLabel(modeId)}...`;
    status.dataset.state = 'loading';
    try {
      const result = await saveAgentSigningMode(modeId);
      inventory = {
        ...inventory,
        activeMode: result.activeMode || result.mode?.mode || modeId,
        mode: result.mode || inventory.mode,
      };
      applyResults = Array.isArray(result.sessions) ? result.sessions : [];
      const restartCount = applyResults.filter((session) => session.restartRequired).length;
      status.textContent = result.consequence || (
        restartCount
          ? `${restartCount} active session${restartCount === 1 ? '' : 's'} need restart.`
          : 'Signing mode applied. Active sessions received replacement capabilities.'
      );
      status.dataset.state = restartCount ? 'warning' : 'ready';
      renderContent();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Signing mode update failed.';
      status.dataset.state = 'error';
      button.disabled = false;
    }
  }

  function renderModeCard(mode, activeMode) {
    const button = element('button', undefined, 'wm-signing-mode-card');
    button.type = 'button';
    button.dataset.testid = `signing-mode-option-${mode.id}`;
    button.setAttribute('aria-label', `Set agent signing mode to ${mode.name}`);
    button.setAttribute('aria-pressed', String(mode.id === activeMode));
    button.dataset.active = String(mode.id === activeMode);
    button.append(
      element('strong', `${mode.name}${mode.id === activeMode ? ' · active' : ''}`),
      element('span', mode.trust),
      element('p', mode.description),
    );
    button.addEventListener('click', () => applyMode(mode.id, button));
    return button;
  }

  function renderSessionSummary() {
    const section = element('section', undefined, 'wm-signing-mode-sessions');
    section.dataset.testid = 'signing-mode-session-summary';
    section.setAttribute('aria-label', 'Signing mode session application results');
    section.append(element('h3', applyResults.length ? 'Apply Results' : 'Active Sessions'));
    const sessions = applyResults.length ? applyResults : inventory.sessions || [];
    const list = element('ul');
    for (const session of sessions) {
      const item = element('li', modeStatusText(session));
      item.dataset.testid = session.restartRequired ? 'signing-mode-session-restart-required' : 'signing-mode-session-updated';
      list.append(item);
    }
    if (!list.children.length) list.append(element('li', 'No active sessions currently hold brokered signing capabilities.'));
    section.append(list);
    return section;
  }

  function renderContent() {
    const activeMode = activeModeFromInventory(inventory);
    const current = element('p', `Current mode: ${modeLabel(activeMode)}`, 'wm-signing-mode-current');
    current.dataset.testid = 'signing-mode-current';
    const cards = element('div', undefined, 'wm-signing-mode-grid');
    cards.dataset.testid = 'signing-mode-options';
    for (const mode of inventory.modes || []) cards.append(renderModeCard(mode, activeMode));
    content.replaceChildren(current, cards, renderSessionSummary());
  }

  void refresh();
  return root;
}
