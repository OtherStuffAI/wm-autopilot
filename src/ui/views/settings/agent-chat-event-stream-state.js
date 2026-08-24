export function resolveEventFamily(event) {
  const familyHash = typeof event?.payload?.family_hash === 'string' ? event.payload.family_hash : '';
  if (familyHash) {
    const parts = familyHash.split(':').filter(Boolean);
    return parts[parts.length - 1] || familyHash;
  }
  const entityType = typeof event?.payload?.entity_type === 'string' ? event.payload.entity_type : '';
  if (entityType) {
    if (entityType === 'message' || entityType === 'thread') {
      return 'chat';
    }
    if (entityType === 'task_comment' || entityType === 'document_comment') {
      return 'comment';
    }
    return entityType;
  }
  const eventType = typeof event?.eventType === 'string' ? event.eventType : '';
  const match = eventType.match(/^flightdeck_pg\.([a-z_]+)\./);
  return match?.[1] || 'unknown-family';
}

function buildEventFingerprint(event) {
  return JSON.stringify({
    eventType: event?.eventType || 'unknown',
    family: resolveEventFamily(event),
    recordId: typeof event?.payload?.record_id === 'string' ? event.payload.record_id : null,
    version: typeof event?.payload?.version === 'number' ? event.payload.version : null,
    eventId: event?.eventId || null,
  });
}

function dedupeEvents(events) {
  const seen = new Map();
  const deduped = [];

  events.forEach((event) => {
    const key = buildEventFingerprint(event);
    const existing = seen.get(key);
    if (existing) {
      existing.repeatCount += 1;
      return;
    }
    const entry = { ...event, repeatCount: 1 };
    seen.set(key, entry);
    deduped.push(entry);
  });

  return deduped;
}

export function getEventRecordId(event) {
  if (typeof event?.payload?.record_id === 'string') {
    return event.payload.record_id;
  }
  if (typeof event?.payload?.entity_id === 'string') {
    return event.payload.entity_id;
  }
  if (typeof event?.payload?.payload?.message_id === 'string') {
    return event.payload.payload.message_id;
  }
  if (typeof event?.payload?.payload?.task_id === 'string') {
    return event.payload.payload.task_id;
  }
  return null;
}

function getEventSortTime(event) {
  const timestamp = Date.parse(event?.at || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isTransportEvent(event) {
  return event?.eventType === 'connected' || event?.eventType === 'heartbeat';
}

export function getRecentEventRows(subscription) {
  const events = Array.isArray(subscription.recentSseEvents) ? subscription.recentSseEvents : [];
  return dedupeEvents(events)
    .sort((left, right) => getEventSortTime(right) - getEventSortTime(left))
    .filter((event) => !isTransportEvent(event));
}

function findDispatchForEvent(subscription, event) {
  const recordId = getEventRecordId(event);
  if (!recordId || !Array.isArray(subscription.recentDispatches)) {
    return null;
  }
  return [...subscription.recentDispatches]
    .reverse()
    .find((entry) => (
      entry.recordId === recordId
      || entry.bindingId === recordId
      || entry.details?.message_id === recordId
      || entry.details?.entity_id === recordId
      || entry.details?.targetMessageId === recordId
      || entry.details?.chat_acknowledgement?.targetMessageId === recordId
    )) ?? null;
}

function diagnosticMatchesEvent(diagnostic, recordId) {
  if (!diagnostic || !recordId) {
    return false;
  }
  return diagnostic.details?.record_id === recordId;
}

function findErrorDiagnosticForEvent(subscription, event) {
  const recordId = getEventRecordId(event);
  const diagnostics = [
    subscription.lastRoutingResult,
    subscription.lastDecryptResult,
    subscription.lastRecordPullResult,
  ];
  return diagnostics.find((diagnostic) => diagnosticMatchesEvent(diagnostic, recordId) && diagnostic.ok === false) ?? null;
}

function resolveSuppressedDispatchState(dispatch) {
  const reason = dispatch?.suppressionReason;
  if (reason === 'route_disabled') {
    return { label: 'Route Disabled', tone: 'warning' };
  }
  if (reason === 'route_match_failed') {
    return { label: 'No Route Match', tone: 'warning' };
  }
  if (reason === 'self_authored') {
    return { label: 'Skipped Self', tone: 'muted' };
  }
  return { label: 'Suppressed', tone: 'warning' };
}

export function resolveEventState(subscription, event) {
  const dispatch = findDispatchForEvent(subscription, event);
  if (dispatch?.pipelineRunId && String(dispatch.action || '').includes('pipeline_dispatch')) {
    return { label: 'Pipeline Dispatched', tone: 'success', dispatch, diagnostic: null };
  }
  const diagnostic = findErrorDiagnosticForEvent(subscription, event);
  if (diagnostic || dispatch?.status === 'failed') {
    return { label: 'Error', tone: 'danger', dispatch, diagnostic };
  }
  if (dispatch?.status === 'suppressed') {
    return { ...resolveSuppressedDispatchState(dispatch), dispatch, diagnostic: null };
  }
  return { label: 'New', tone: 'muted', dispatch, diagnostic: null };
}
