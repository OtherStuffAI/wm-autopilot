import { createConnectionDiagnosticsTables } from './flight-deck-section.js';

function isRevoked(subscription) {
  const status = subscription?.profileWorkspace?.workspace?.relayOnboardingStatus;
  return status === 'revoked'
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
  remove.textContent = 'Remove local subscription';
  remove.disabled = subscription?.onboardingSource === 'nostr_33357' || canManage === false;
  remove.title = subscription?.onboardingSource === 'nostr_33357'
    ? 'Flight Deck-onboarded subscriptions are removed through Flight Deck membership events; the current Autopilot API rejects local deletion.'
    : '';
  remove.addEventListener('click', onRemove);

  controls.append(reconnect, toggle, remove);
  actions.append(heading, explanation, controls);
  if (reconnect.disabled && revoked) actions.append(createStatus('Reconnect unavailable: Tower verification revoked this grant. Import a new AgentConnect grant.'));
  if (remove.disabled && subscription?.onboardingSource === 'nostr_33357') actions.append(createStatus('Remove is managed by Flight Deck membership events for this subscription; local deletion is not exposed by the current API.'));
  wrapper.append(actions, createConnectionDiagnosticsTables(subscription));
  return wrapper;
}
