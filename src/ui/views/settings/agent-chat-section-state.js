export function resolveSelectedSubscriptionId(subscriptions, selectedSubscriptionId = null) {
  const list = Array.isArray(subscriptions) ? subscriptions : [];
  if (selectedSubscriptionId && list.some((subscription) => subscription?.subscriptionId === selectedSubscriptionId)) {
    return selectedSubscriptionId;
  }
  return list[0]?.subscriptionId ?? null;
}

export function getSubscriptionById(subscriptions, subscriptionId) {
  return Array.isArray(subscriptions)
    ? subscriptions.find((subscription) => subscription?.subscriptionId === subscriptionId) ?? null
    : null;
}

export function filterDispatchRoutesForSubscription(routes, subscriptionId) {
  return Array.isArray(routes) && subscriptionId
    ? routes.filter((route) => route?.subscriptionId === subscriptionId)
    : [];
}

export function getAgentForSubscription(agents, subscription) {
  if (!Array.isArray(agents) || agents.length === 0) {
    return null;
  }
  if (!subscription) {
    return null;
  }
  const workspaceNpub = subscription.workspaceServiceNpub || subscription.workspaceOwnerNpub;
  return agents.find((agent) => (
    agent?.workspaceOwnerNpub === workspaceNpub
    && agent?.botNpub === subscription.botNpub
  )) ?? null;
}

export function getAdditionalAgents(agents, selectedAgent) {
  return Array.isArray(agents)
    ? agents.filter((agent) => agent?.agentId !== selectedAgent?.agentId)
    : [];
}

export function resolveAgentEditorDirectory(agent) {
  const directChatDirectory = typeof agent?.directChat?.directory === 'string'
    ? agent.directChat.directory.trim()
    : '';
  return directChatDirectory || agent?.workingDirectory || '';
}

export function getRoutesForSubscription(routes, subscriptionId) {
  return Array.isArray(routes)
    ? routes.filter((route) => route?.subscriptionId === subscriptionId)
    : [];
}

export function hasDuplicateWorkspaceAppOnAnotherTower(subscriptions, subscription) {
  if (!subscription || !Array.isArray(subscriptions)) {
    return false;
  }
  const workspaceOwnerNpub = subscription.workspaceOwnerNpub || '';
  const sourceAppNpub = subscription.sourceAppNpub || '';
  const backendBaseUrl = subscription.backendBaseUrl || '';
  if (!workspaceOwnerNpub || !sourceAppNpub || !backendBaseUrl) {
    return false;
  }
  return subscriptions.some((candidate) => (
    candidate
    && candidate.subscriptionId !== subscription.subscriptionId
    && candidate.workspaceOwnerNpub === workspaceOwnerNpub
    && candidate.sourceAppNpub === sourceAppNpub
    && candidate.backendBaseUrl
    && candidate.backendBaseUrl !== backendBaseUrl
  ));
}

function getEffectiveWorkspaceNpub(subscription) {
  return subscription?.workspaceServiceNpub || subscription?.workspaceOwnerNpub || '';
}

export function buildAgentBindingInput(subscription, defaults) {
  return {
    agentId: defaults.agentId,
    label: defaults.label,
    botNpub: subscription?.botNpub || '',
    workspaceOwnerNpub: getEffectiveWorkspaceNpub(subscription),
    workingDirectory: defaults.workingDirectory,
    capabilities: Array.isArray(defaults.capabilities) ? defaults.capabilities : ['chat_intercept'],
    enabled: true,
    directChat: {
      enabled: true,
      sessionAgent: null,
      directory: defaults.workingDirectory,
      model: null,
      idleRetentionMinutes: 60,
    },
  };
}

export function buildBackendSubscriptionInput(backendConnection) {
  return {
    backendConnectionId: backendConnection.backendConnectionId,
    backendBaseUrl: backendConnection.backendBaseUrl,
    workspaceOwnerNpub: backendConnection.setupWorkspaceOwnerNpub || '',
    workspaceServiceNpub: backendConnection.setupWorkspaceServiceNpub || null,
    workspaceId: backendConnection.setupWorkspaceId || null,
    sourceAppNpub: backendConnection.setupSourceAppNpub || '',
    towerServiceNpub: backendConnection.serviceNpub || null,
    backendConnectionGrantKind: backendConnection.operator?.shared ? 'shared_service' : null,
  };
}
