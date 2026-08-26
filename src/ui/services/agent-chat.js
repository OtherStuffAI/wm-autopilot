export async function listAgentChatSubscriptions() {
  const response = await fetch('/api/agent-chat/subscriptions', { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load Agent Chat subscriptions');
  }
  const subscriptions = Array.isArray(payload.subscriptions) ? payload.subscriptions : [];
  subscriptions.permissions = payload.permissions && typeof payload.permissions === 'object'
    ? payload.permissions
    : { shared: false, canManage: true };
  return subscriptions;
}

export async function listFlightDeckDispatchOutcomes({ limit = 25, offset = 0, includeIgnoredAndSuppressed = false } = {}) {
  const query = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    includeIgnoredAndSuppressed: String(includeIgnoredAndSuppressed),
  });
  const response = await fetch(`/api/agent-chat/dispatch-outcomes?${query.toString()}`, { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load Flight Deck dispatch outcomes');
  }
  return {
    rows: Array.isArray(payload.rows) ? payload.rows : [],
    total: Number.isFinite(payload.total) ? payload.total : 0,
    limit: Number.isFinite(payload.limit) ? payload.limit : limit,
    offset: Number.isFinite(payload.offset) ? payload.offset : offset,
  };
}

export async function listAgentChatAgents() {
  const response = await fetch('/api/agent-chat/agents', { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load Agent Chat agents');
  }
  return {
    agents: Array.isArray(payload.agents) ? payload.agents : [],
    permissions: payload.permissions && typeof payload.permissions === 'object'
      ? payload.permissions
      : { shared: false, canManage: true },
    defaults: payload.defaults && typeof payload.defaults === 'object' ? payload.defaults : {},
  };
}

export async function listAgentChatBackendConnections() {
  const response = await fetch('/api/agent-chat/backend-connections', { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load Agent Chat backend connections');
  }
  return Array.isArray(payload.backendConnections) ? payload.backendConnections : [];
}

export async function saveAgentChatBackendConnectionAvailability(backendConnectionId, input) {
  const response = await fetch(`/api/agent-chat/backend-connections/${encodeURIComponent(backendConnectionId)}/availability`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to update backend connection availability');
  }
  return payload.backendConnection;
}

export async function saveAgentChatSubscription(input) {
  const response = await fetch('/api/agent-chat/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to save Agent Chat subscription');
  }
  return payload.subscription;
}

export async function importAgentConnectPackage(input) {
  const response = await fetch('/api/agent-chat/agent-connect/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to import Agent Connect package');
  }
  return payload;
}

export async function saveAgentChatAgent(input) {
  if (!input?.agentId) throw new Error('Agent ID is required');
  const payload = await updateAgentChatProfile(input.agentId, input);
  return payload.agent;
}

export async function createAgentChatProfile(input) {
  const mediaFile = input?.mediaFile;
  const profile = { ...input };
  delete profile.mediaFile;
  const form = mediaFile ? new FormData() : null;
  if (form) {
    form.set('profile', JSON.stringify(profile));
    form.set('file', mediaFile);
  }
  const response = await fetch('/api/agent-chat/profiles', {
    method: 'POST',
    ...(form ? {} : { headers: { 'Content-Type': 'application/json' } }),
    credentials: 'include',
    body: form || JSON.stringify(profile),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Failed to create agent profile');
    error.details = payload;
    throw error;
  }
  return payload;
}

export async function uploadAgentChatProfileMedia(profileId, mediaFile, input = {}) {
  if (!mediaFile) throw new Error('A profile image file is required');
  const form = new FormData();
  form.set('profile', JSON.stringify(input));
  form.set('file', mediaFile);
  const response = await fetch(`/api/agent-chat/profiles/${encodeURIComponent(profileId)}/media`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const localStatus = payload.media?.savedLocally && payload.media?.publishedToRelays
      ? 'Image saved locally and published to relays, but the local profile update failed. '
      : payload.media?.savedLocally
        ? 'Image saved locally, but relay publication failed and the profile URL was not changed. '
        : '';
    const error = new Error(`${localStatus}${payload.error || 'Failed to import agent profile media'}`);
    error.details = payload;
    throw error;
  }
  return payload;
}

export async function republishAgentChatProfile(profileId) {
  const response = await fetch(`/api/agent-chat/profiles/${encodeURIComponent(profileId)}/publish`, {
    method: 'POST',
    credentials: 'include',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Failed to republish agent profile');
  return payload;
}

export async function setDefaultAgentChatProfile(profileId) {
  const response = await fetch(`/api/agent-chat/profiles/${encodeURIComponent(profileId)}/default`, {
    method: 'POST',
    credentials: 'include',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Failed to set default agent profile');
  return payload;
}

export async function rotateAgentChatProfileKey(profileId, currentNpub, requestId) {
  const response = await fetch(`/api/agent-chat/profiles/${encodeURIComponent(profileId)}/rotate-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      requestId,
      expectedCurrentNpub: currentNpub,
      confirmation: { profileId, currentNpub },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && !payload.rotation) {
    const error = new Error(payload.error || 'Failed to rotate agent key');
    error.code = payload.code;
    throw error;
  }
  return payload.rotation;
}

export async function updateAgentChatProfile(profileId, input) {
  const response = await fetch(`/api/agent-chat/profiles/${encodeURIComponent(profileId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Failed to update agent profile');
    error.code = payload.code;
    throw error;
  }
  return payload;
}

export async function deleteAgentChatSubscription(subscriptionId) {
  const response = await fetch(`/api/agent-chat/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok && response.status !== 204) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to delete Agent Chat subscription');
  }
}

export async function deleteAgentChatAgent(agentId) {
  const response = await fetch(`/api/agent-chat/agents/${encodeURIComponent(agentId)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok && response.status !== 204) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to delete Agent Chat agent');
  }
}

export async function runAgentChatSubscriptionAction(subscriptionId, action) {
  const response = await fetch(
    `/api/agent-chat/subscriptions/${encodeURIComponent(subscriptionId)}/actions/${encodeURIComponent(action)}`,
    {
      method: 'POST',
      credentials: 'include',
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to run Agent Chat action');
  }
  return payload.subscription ?? null;
}

export async function listAgentChatDispatchRoutes(subscriptionId = '') {
  const suffix = subscriptionId ? `?subscriptionId=${encodeURIComponent(subscriptionId)}` : '';
  const response = await fetch(`/api/agent-chat/dispatch-routes${suffix}`, { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load Agent Dispatch routes');
  }
  return Array.isArray(payload.dispatchRoutes) ? payload.dispatchRoutes : [];
}

export async function saveAgentChatDispatchRoute(input) {
  const response = await fetch('/api/agent-chat/dispatch-routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to save Agent Dispatch route');
  }
  return payload.dispatchRoute;
}

export async function saveAgentChatProfileWorkspace(subscriptionId, input) {
  const response = await fetch(`/api/agent-chat/subscriptions/${encodeURIComponent(subscriptionId)}/profile-workspace`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to save profile workspace settings');
  }
  return payload.profileWorkspace ?? null;
}
