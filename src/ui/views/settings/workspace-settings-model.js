import { getWorkspaceHealthLabel } from './workspace-settings-state.js';

function serverAddress(raw, id) {
  try {
    const url = new URL(raw);
    return { key: url.href.replace(/\/+$/, ''), label: url.host };
  } catch {
    return { key: `missing-${id}`, label: 'Server address unavailable' };
  }
}

// Persist only presentation data. AgentConnect tokens and workspace keys never enter the cache.
export function buildWorkspaceSettingsModel(subscriptions, agentPayload, connections) {
  const servers = new Map();
  for (const subscription of subscriptions) {
    const backend = connections.find((item) => item.backendConnectionId === subscription.backendConnectionId);
    const address = serverAddress(subscription.backendBaseUrl || backend?.backendBaseUrl, subscription.subscriptionId);
    if (!servers.has(address.key)) servers.set(address.key, { ...address, workspaces: [] });
    const server = servers.get(address.key);
    const workspaceId = subscription.workspaceId || subscription.profileWorkspace?.workspace?.workspaceId;
    const key = workspaceId || `unresolved-${subscription.subscriptionId}`;
    let workspace = server.workspaces.find((item) => item.key === key);
    const name = subscription.profileWorkspace?.workspace?.workspaceTitle
      || agentPayload.workspaceBotConnections?.find((item) => item.subscriptionId === subscription.subscriptionId && item.workspaceTitle)?.workspaceTitle
      || subscription.workspaceName;
    if (!workspace) {
      workspace = { key, name: name || 'Workspace name unavailable', subscriptions: [], bots: [], activity: [] };
      if (backend) workspace.towerConnection = {
        backendConnectionId: backend.backendConnectionId, backendBaseUrl: backend.backendBaseUrl,
        serviceNpub: backend.serviceNpub, transport: backend.transport, transportDiagnostics: backend.transportDiagnostics,
        canManageTransport: backend.operator?.canManageAvailability === true,
      };
      server.workspaces.push(workspace);
    } else if (name && workspace.name === 'Workspace name unavailable') workspace.name = name;
    const health = getWorkspaceHealthLabel(subscription);
    workspace.subscriptions.push({
      subscriptionId: subscription.subscriptionId, workspaceId, health,
      source: subscription.onboardingSource === 'nostr_33357' ? 'Discovered via Nostr'
        : subscription.onboardingSource === 'agent_connect_import' ? 'Added via AgentConnect' : 'Manual connection',
      error: subscription.lastErrorCode ? subscription.lastAuthResult?.message || subscription.lastErrorCode : null,
      profileBound: Boolean(subscription.agentProfileId),
      lastActivity: subscription.lastEventPollOkAt || subscription.lastAuthOkAt || null,
    });
    const recorded = (agentPayload.workspaceBotConnections || []).filter((item) => item.subscriptionId === subscription.subscriptionId);
    const known = new Map(recorded.map((item) => [item.agentId, item]));
    for (const agent of subscription.candidateAgents || []) {
      if (!known.has(agent.agentId)) known.set(agent.agentId, { agentId: agent.agentId, status: 'configured' });
    }
    for (const connection of known.values()) {
      const agent = agentPayload.agents.find((item) => item.agentId === connection.agentId)
        || subscription.candidateAgents?.find((item) => item.agentId === connection.agentId);
      if (!agent || workspace.bots.some((item) => item.agentId === agent.agentId)) continue;
      workspace.bots.push({ agentId: agent.agentId, label: agent.publicProfile?.name || agent.label,
        status: agent.enabled === false || agent.archived ? 'Disabled'
          : agent.directChat?.enabled === false ? 'Agent Direct off'
          : ['revoked', 'deleted'].includes(connection.status) ? 'Access revoked' : 'Configured',
        connectionStatus: connection.status,
      });
    }
    for (const entry of subscription.recentDispatches || []) {
      workspace.activity.push({ at: entry.at, action: entry.action, status: entry.status,
        agentId: entry.agentId, reason: entry.suppressionReason, recordId: entry.recordId });
    }
  }
  return [...servers.values()].sort((a, b) => a.label.localeCompare(b.label)).map((server) => ({
    ...server, workspaces: server.workspaces.sort((a, b) => a.name.localeCompare(b.name)).map((workspace) => ({
      ...workspace, activity: workspace.activity.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 5),
    })),
  }));
}
