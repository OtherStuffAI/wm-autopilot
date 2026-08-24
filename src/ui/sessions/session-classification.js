export const LIVE_SESSION_TAB_GROUPS = Object.freeze([
  { id: 'all', label: 'All Sessions' },
  { id: 'standard', label: 'Standard' },
  { id: 'wingman', label: 'Wingman Chats' },
]);

export function isAgentChatSession(session) {
  return session?.metadata?.role === 'agent-chat' || session?.origin?.type === 'agent-chat';
}

export function isTaskDispatchSession(session) {
  const role = session?.metadata?.role;
  const originType = session?.origin?.type;
  return role === 'agent-work'
    || role === 'pipeline-step'
    || originType === 'agent-work';
}

export function filterTaskDispatchSessionsForTabs(sessions, showTaskDispatchSessions) {
  if (!Array.isArray(sessions) || showTaskDispatchSessions) {
    return Array.isArray(sessions) ? sessions : [];
  }
  return sessions.filter((session) => !isTaskDispatchSession(session));
}

export function getLiveSessionTabGroup(session) {
  return isAgentChatSession(session) ? 'wingman' : 'standard';
}

export function filterSessionsForLiveTabGroup(sessions, groupId) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return [];
  }
  if (groupId === 'all') {
    return sessions;
  }
  return sessions.filter((session) => getLiveSessionTabGroup(session) === groupId);
}

export function countSessionsByLiveTabGroup(sessions) {
  const counts = {
    all: Array.isArray(sessions) ? sessions.length : 0,
    standard: 0,
    wingman: 0,
  };

  if (!Array.isArray(sessions) || sessions.length === 0) {
    return counts;
  }

  sessions.forEach((session) => {
    const groupId = getLiveSessionTabGroup(session);
    counts[groupId] += 1;
  });

  return counts;
}

export function resolveLiveTabGroup(groupId, sessions, activeSession = null) {
  const validGroups = new Set(LIVE_SESSION_TAB_GROUPS.map((group) => group.id));
  if (groupId && validGroups.has(groupId)) {
    return groupId;
  }

  if (activeSession) {
    return getLiveSessionTabGroup(activeSession);
  }

  if (Array.isArray(sessions) && sessions.length > 0) {
    return getLiveSessionTabGroup(sessions[0]);
  }

  return 'standard';
}
