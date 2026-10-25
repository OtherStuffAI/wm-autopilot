import Alpine from '/vendor/alpinejs/module.esm.js';
import { randomId } from '../../core/random-id.js';
import { workspaceSettingsDb, Dexie } from './workspace-settings-db.js';
import { createNStackConnectController, nstackConnectionKey } from './nstack-connect-controller.js';
import { createButton } from './agent-chat-shared-ui.js';
import { element } from './workspace-settings-details.js';

Alpine.data('nstackConnectView', () => ({
  init() {
    const host = this.$el;
    this.query = Dexie.liveQuery(() => workspaceSettingsDb.nstackFlows.get(host.dataset.flowId)).subscribe({
      next: (snapshot) => host.renderFlow(snapshot),
      error: (error) => host.showFlowError(error),
    });
  },
  destroy() { this.query?.unsubscribe(); void this.$el.controller.destroy(); },
}));

export function createNStackConnectModal({ onConnected }) {
  const overlay = element('div', '', 'wm-modal-overlay');
  overlay.hidden = true;
  overlay.style.display = 'none';
  overlay.dataset.flowId = randomId();
  overlay.dataset.testid = 'nstack-connect-modal';
  overlay.setAttribute('x-data', 'nstackConnectView');
  const panel = element('section', '', 'wm-card wm-nstack-connect');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Connect Autopilot to NStack');
  overlay.append(panel);
  let returnFocus;
  const controller = createNStackConnectController({
    id: overlay.dataset.flowId, table: workspaceSettingsDb.nstackFlows,
    discoverAddress: async (address) => {
      const response = await fetch('/api/agent-chat/nstack-connect/discover', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'NStack discovery failed.');
      return result;
    },
    setup: async (workspaces) => {
      const response = await fetch('/api/agent-chat/nstack-connect', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaces }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'NStack setup failed.');
      await onConnected();
      return result;
    },
  });
  overlay.controller = controller;
  function action(label, id, callback, disabled = false) {
    const button = createButton(label, id, label);
    button.disabled = disabled;
    button.addEventListener('click', () => void callback());
    return button;
  }
  function render(value) {
    const wasOpen = !overlay.hidden;
    overlay.hidden = !value?.open;
    overlay.style.display = value?.open ? 'flex' : 'none';
    if (!value?.open) { if (wasOpen) returnFocus?.focus(); return; }
    const focused = panel.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.dataset.testid;
    const selection = focusedId === 'nstack-address' ? [focused.selectionStart, focused.selectionEnd] : null;
    const title = element('h2', value.stage === 'review' ? `Connect ${value.selected.length} workspace${value.selected.length === 1 ? '' : 's'}`
      : value.stage === 'results' ? 'Connection results' : 'Choose workspaces');
    const status = element('p', value.message, 'wm-workspace-note');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    status.dataset.testid = 'nstack-connect-status';
    panel.setAttribute('aria-busy', String(value.busy));
    panel.replaceChildren(title, status);
    if (value.stage === 'select') {
      const entries = element('section', '', 'wm-nstack-entries');
      entries.setAttribute('aria-label', 'NStack connection choices');
      const label = element('label', 'NStack HTTPS address');
      const address = element('input', '', 'wm-input'); address.type = 'text'; address.inputMode = 'url'; address.autocomplete = 'url'; address.placeholder = 'https://nstack.example';
      address.value = value.address; address.disabled = value.busy;
      address.dataset.testid = 'nstack-address'; address.setAttribute('aria-label', 'NStack HTTPS address');
      address.addEventListener('input', () => void controller.setAddress(address.value));
      address.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void controller.discoverHttps(); } });
      label.append(address);
      entries.append(action('Saved NStack via NBrowser', 'nstack-discover', controller.discover, value.busy), label,
        action('Enter NStack HTTPS address', 'nstack-discover-https', controller.discoverHttps, value.busy),
        action('Browse NStack directory — coming soon', 'nstack-directory', () => {}, true),
        element('p', 'Coming soon: browse Nostr announcements of NStack FIPS and HTTP connection endpoints.', 'wm-workspace-note'));
      panel.append(entries);
    }
    if (value.stage === 'results') {
      for (const result of value.results) {
        const row = element('section', '', 'wm-workspace-connection');
        row.dataset.testid = `nstack-result-${encodeURIComponent(result.key)}`;
        row.dataset.workspaceId = result.workspaceId;
        const choice = value.choices.find((item) => item.connection && nstackConnectionKey(item.connection) === result.key);
        row.setAttribute('aria-label', `${result.name} on ${choice?.stackName || 'NStack'}`);
        if (choice) row.append(element('p', `${choice.stackName} · ${choice.connection.directHttpsUrl}`, 'wm-workspace-note'));
        row.append(element('h3', result.name), element('strong', result.status.replaceAll('_', ' ')), element('p', result.message));
        if (result.errors?.length) {
          const details = element('details');
          details.append(element('summary', 'Agent access diagnostics'), element('p', result.errors.join('; ')));
          row.append(details);
        }
        panel.append(row);
      }
    } else {
      for (const choice of value.choices.filter((row) => value.stage !== 'review' || value.selected.includes(row.key))) {
        const row = element('label', '', 'wm-nstack-choice');
        if (value.stage === 'select') {
          const checkbox = element('input'); checkbox.type = 'checkbox';
          checkbox.checked = value.selected.includes(choice.key); checkbox.disabled = value.busy;
          checkbox.dataset.testid = `nstack-choice-${choice.key}`;
          checkbox.setAttribute('aria-label', `Select ${choice.name} on ${choice.stackName}`);
          checkbox.addEventListener('change', () => void controller.select(choice.key, checkbox.checked));
          row.append(checkbox);
        }
        row.append(element('strong', choice.name), element('span', choice.stackName));
        if (choice.connection) row.append(element('small', choice.connection.directHttpsUrl));
        panel.append(row);
      }
    }
    const actions = element('div', '', 'wm-settings-page__actions');
    if (value.stage === 'select') {
      actions.append(action('Review connection', 'nstack-review', controller.review, value.busy || !value.selected.length));
    } else if (value.stage === 'review') {
      actions.append(action('Back', 'nstack-back', controller.back, value.busy),
        action('Connect workspaces', 'nstack-confirm', () => controller.connect(), value.busy));
    } else if (value.results.some((row) => ['failed', 'needs_attention'].includes(row.status))) {
      actions.append(action('Retry failed workspaces', 'nstack-retry', () => controller.connect(true), value.busy));
    }
    actions.append(action(value.stage === 'results' ? 'Done' : 'Cancel', 'nstack-cancel', controller.close));
    panel.append(actions);
    if (focusedId) {
      const replacement = [...panel.querySelectorAll('[data-testid]')].find((node) => node.dataset.testid === focusedId);
      replacement?.focus();
      if (selection && replacement) replacement.setSelectionRange(...selection);
    }
    if (!panel.contains(document.activeElement)) panel.querySelector('button:not(:disabled), input:not(:disabled)')?.focus();
  }
  overlay.renderFlow = render;
  overlay.showFlowError = (error) => { panel.textContent = error.message; };
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); void controller.close(); }
    if (event.key === 'Tab') {
      const controls = [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  return { element: overlay, open: () => { returnFocus = document.activeElement; void controller.open(); }, destroy: controller.destroy };
}
