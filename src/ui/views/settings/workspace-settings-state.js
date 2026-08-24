export function isRevokedWorkspaceSubscription(subscription) {
  const status = subscription?.profileWorkspace?.workspace?.relayOnboardingStatus;
  return status === 'revoked'
    || status === 'deleted'
    || subscription?.wsKeyStatus === 'revoked'
    || subscription?.lastErrorCode === 'workspace_access_revoked';
}

export function getWorkspaceHealthLabel(subscription) {
  if (isRevokedWorkspaceSubscription(subscription)) return 'Revoked';
  if (subscription?.sseStatus === 'disabled') return 'Disabled';
  if (subscription?.sseStatus === 'disconnected') return 'Disconnected';
  if (subscription?.healthStatus === 'healthy') return 'Connected';
  if (subscription?.lastErrorCode) return 'Needs attention';
  return subscription?.healthStatus || 'Status unavailable';
}

export function getWorkspaceCollectionState({ loading = false, error = null, subscriptions = [], partialErrors = [] } = {}) {
  if (loading) return 'loading';
  if (error) return 'error';
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return 'empty';
  if (Array.isArray(partialErrors) && partialErrors.length > 0) return 'partial-error';
  return 'ready';
}
