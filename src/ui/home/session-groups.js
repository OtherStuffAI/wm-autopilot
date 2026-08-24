const LEGACY_AGENT_ORIGIN_TYPES = new Set([
  'scheduler',
  'nostr',
  'mg-task',
  'file-watcher',
  'agent-session',
]);

const PROGRAMMATIC_ORIGIN_TYPES = new Set([
  'cli',
  'delegate-bot',
]);

export const HOME_SESSION_GROUPS = Object.freeze([
  { id: 'my', label: 'My Sessions', emptyLabel: 'No UI-started sessions.' },
  { id: 'auto', label: 'Auto Sessions', emptyLabel: 'No dispatch or agent-started sessions.' },
]);

function normaliseOriginType(session) {
  return typeof session?.origin?.type === 'string' ? session.origin.type.trim().toLowerCase() : '';
}

function normaliseMetadata(session) {
  return session?.metadata && typeof session.metadata === 'object' ? session.metadata : {};
}

function normaliseNpub(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function resolveSessionOwnerNpub(session, metadata) {
  return normaliseNpub(session?.ownerNpub) || normaliseNpub(metadata.ownerNpub) || normaliseNpub(session?.npub);
}

function wasCreatedByDifferentNpub(session, metadata) {
  const ownerNpub = resolveSessionOwnerNpub(session, metadata);
  const createdByNpub = normaliseNpub(metadata.createdByNpub);
  return Boolean(ownerNpub && createdByNpub && ownerNpub !== createdByNpub);
}

export function isTaskDispatchSession(session) {
  const metadata = normaliseMetadata(session);
  const originType = normaliseOriginType(session);
  return (
    originType === 'mg-task' ||
    originType === 'agent-work' ||
    originType === 'session-dispatch' ||
    metadata.role === 'agent-work' ||
    metadata.role === 'dispatched-worker' ||
    metadata.bindingType === 'task' ||
    metadata.bindingType === 'flow_run'
  );
}

export function isChatDispatchSession(session) {
  const metadata = normaliseMetadata(session);
  const originType = normaliseOriginType(session);
  return (
    originType === 'agent-chat' ||
    metadata.role === 'agent-chat' ||
    metadata.routedBy === 'agent-chat'
  );
}

export function isAgentSession(session) {
  const metadata = normaliseMetadata(session);
  const originType = normaliseOriginType(session);
  return (
    metadata.AGENT === true ||
    wasCreatedByDifferentNpub(session, metadata) ||
    PROGRAMMATIC_ORIGIN_TYPES.has(originType) ||
    LEGACY_AGENT_ORIGIN_TYPES.has(originType)
  );
}

export function getHomeSessionGroup(session) {
  return isTaskDispatchSession(session) || isChatDispatchSession(session) || isAgentSession(session)
    ? 'auto'
    : 'my';
}

export function filterSessionsForHomeGroup(sessions, groupId) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return [];
  }
  return sessions.filter((session) => getHomeSessionGroup(session) === groupId);
}

export function countSessionsByHomeGroup(sessions) {
  const counts = {
    my: 0,
    auto: 0,
  };

  if (!Array.isArray(sessions)) {
    return counts;
  }

  sessions.forEach((session) => {
    const groupId = getHomeSessionGroup(session);
    if (Object.prototype.hasOwnProperty.call(counts, groupId)) {
      counts[groupId] += 1;
    }
  });

  return counts;
}
