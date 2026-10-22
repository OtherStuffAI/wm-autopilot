import { createButton } from './agent-chat-shared-ui.js';

// Private keys are deliberately transient: never write this response to Dexie,
// telemetry, shared application state, clipboard, or a generic API error object.
export function createAgentProfileKeyExport({ fetchKey = globalThis.fetch.bind(globalThis) } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'wm-card';
  dialog.style.cssText = 'width:min(640px,90vw);max-height:85vh;overflow:auto;padding:24px;';
  dialog.dataset.testid = 'agent-profile-export-dialog';
  dialog.setAttribute('aria-label', 'Export selected bot private key');
  const title = document.createElement('h2');
  title.textContent = 'Export nsec';
  const identity = document.createElement('p');
  identity.style.overflowWrap = 'anywhere';
  identity.dataset.testid = 'agent-profile-export-identity';
  const warning = document.createElement('p');
  warning.textContent = 'Anyone possessing this private key can control this bot and act as its identity. Store it securely and never share it in chat, logs, or task records. Export keeps the current identity unchanged.';
  const confirm = createButton('I understand — export this bot’s nsec', 'agent-profile-export-confirm', 'Confirm export of the selected bot private key');
  const cancel = createButton('Cancel', 'agent-profile-export-cancel', 'Cancel or dismiss private key export');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const key = document.createElement('textarea');
  key.readOnly = true;
  key.hidden = true;
  key.autocomplete = 'off';
  key.spellcheck = false;
  key.dataset.testid = 'agent-profile-export-key';
  key.setAttribute('aria-label', 'Exported private key — store securely');
  key.style.cssText = 'width:100%;min-height:100px;';
  dialog.append(title, identity, warning, status, key, confirm, cancel);
  let selected = null;
  let controller = null;
  let trigger = null;

  function clear() {
    controller?.abort();
    controller = null;
    selected = null;
    key.value = '';
    key.hidden = true;
    identity.textContent = '';
    status.textContent = '';
    confirm.disabled = false;
    confirm.hidden = false;
    cancel.textContent = 'Cancel';
  }
  function dismiss() {
    clear();
    if (dialog.open) dialog.close();
    trigger?.focus();
    trigger = null;
  }
  cancel.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('close', clear);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dismiss(); });
  globalThis.addEventListener?.('pagehide', dismiss);
  globalThis.document.addEventListener?.('visibilitychange', () => { if (document.hidden) dismiss(); });
  confirm.addEventListener('click', async () => {
    if (!selected || controller) return;
    const target = selected;
    const pending = new AbortController();
    controller = pending;
    confirm.disabled = true;
    status.textContent = 'Exporting selected bot…';
    try {
      const response = await fetchKey(`/api/agent-chat/profiles/${encodeURIComponent(target.profileId)}/export-nsec`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, signal: pending.signal,
        body: JSON.stringify({ confirmation: { ...target, acknowledged: true } }),
      });
      let payload = await response.json();
      if (controller !== pending || pending.signal.aborted) { payload = null; return; }
      if (!response.ok || payload.profileId !== target.profileId || payload.botNpub !== target.currentNpub
        || typeof payload.nsec !== 'string' || !/^nsec1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(payload.nsec)) {
        payload = null;
        throw new Error('export_failed');
      }
      key.value = payload.nsec;
      payload = null;
      key.hidden = false;
      confirm.hidden = true;
      cancel.textContent = 'Done — clear key';
      status.textContent = 'Store the key securely now. Dismissing clears it from this dialog.';
      key.focus();
    } catch {
      if (controller === pending && !pending.signal.aborted) {
        status.textContent = 'Export unavailable. The bot identity may have changed, or its key may be external, missing, or unavailable. Refresh before trying again.';
      }
    } finally {
      if (controller === pending) controller = null;
      // A new explicit confirmation is required for another request.
      if (selected === target) confirm.hidden = true;
    }
  });
  return {
    element: dialog,
    open(agent, button) {
      dismiss();
      selected = Object.freeze({ profileId: agent.agentId, currentNpub: agent.botNpub });
      trigger = button;
      identity.textContent = `Selected bot: ${agent.label || agent.agentId} (${agent.agentId}) — ${agent.botNpub}`;
      dialog.showModal();
      cancel.focus();
    },
  };
}
