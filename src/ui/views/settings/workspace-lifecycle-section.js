import { createConnectionDiagnosticsTables } from './flight-deck-section.js';

function isRevoked(subscription) {
  const status = subscription?.profileWorkspace?.workspace?.relayOnboardingStatus;
  return subscription?.lifecycleStatus === 'revoked'
    || subscription?.lifecycleStatus === 'deleted'
    || status === 'revoked'
    || status === 'deleted'
    || subscription?.wsKeyStatus === 'revoked'
    || subscription?.lastErrorCode === 'workspace_access_revoked';
}

function createStatus(message) {
  const status = document.createElement('p');
  status.className = 'wm-settings-workspaces__status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = message;
  return status;
}

export function createWorkspaceLifecycleSection({
  subscription,
  canManage,
  actionMessage,
  onAction,
  onRemove,
}) {
  const wrapper = document.createElement('div');
  if (actionMessage) wrapper.append(createStatus(actionMessage));
  const actions = document.createElement('section');
  actions.className = 'wm-card wm-settings-workspaces__lifecycle';
  const heading = document.createElement('h3');
  heading.textContent = 'Subscription lifecycle';
  const explanation = document.createElement('p');
  explanation.textContent = 'These actions affect this local subscription and its event transport only. They do not delete the Tower workspace or the local agent.';
  const controls = document.createElement('div');
  controls.className = 'wm-settings-page__actions';
  const revoked = isRevoked(subscription);
  const disabled = subscription?.sseStatus === 'disabled';

  const reconnect = document.createElement('button');
  reconnect.type = 'button';
  reconnect.className = 'wm-button secondary';
  reconnect.textContent = 'Reconnect events';
  reconnect.disabled = revoked || disabled || canManage === false;
  reconnect.title = revoked
    ? 'Tower verification revoked this grant; import a new AgentConnect grant instead.'
    : disabled ? 'Enable the subscription before reconnecting.' : '';
  reconnect.addEventListener('click', () => onAction('reconnect'));

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'wm-button secondary';
  toggle.textContent = disabled ? 'Enable subscription' : 'Disable subscription';
  toggle.disabled = revoked || canManage === false;
  toggle.addEventListener('click', () => onAction(disabled ? 'enable' : 'disable'));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'wm-button danger';
  remove.textContent = subscription?.onboardingSource === 'nostr_33357'
    ? 'Disconnect locally'
    : 'Remove local subscription';
  remove.disabled = canManage === false;
  remove.title = subscription?.onboardingSource === 'nostr_33357'
    ? 'Stops and hides this local connection without changing Tower membership. Replayed older discovery events remain ignored.'
    : '';
  remove.addEventListener('click', onRemove);

  controls.append(reconnect, toggle, remove);
  actions.append(heading, explanation, controls);
  if (reconnect.disabled && revoked) actions.append(createStatus('Reconnect unavailable: Tower verification revoked this grant. Import a new AgentConnect grant.'));
  if (subscription?.onboardingSource === 'nostr_33357') actions.append(createStatus('Disconnecting is local only. Tower membership remains authoritative, and a genuinely newer verified grant can make the workspace discoverable again.'));
  wrapper.append(actions, createConnectionDiagnosticsTables(subscription));
  return wrapper;
}
