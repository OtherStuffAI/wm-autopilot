import { isAgentChatSession } from '../../sessions/session-classification.js';
import { createEventStreamPager, resolveWorkspaceName } from './agent-chat-event-stream.js';
import { createTonePill } from './agent-chat-shared-ui.js';

function isAgentDispatchSession(session) {
  return isAgentChatSession(session) || session?.metadata?.role === 'agent-work' || session?.origin?.type === 'agent-work';
}

function isFlightDeckOnboardedSubscription(subscription) {
  return subscription?.onboardingSource === 'nostr_33357';
}

function createSection(title, description = '') {
  const wrapper = document.createElement('section');
  wrapper.style.cssText = 'margin-top:18px;';

  const heading = document.createElement('h5');
  heading.style.marginBottom = '6px';
  heading.textContent = title;
  wrapper.append(heading);

  if (description) {
    const note = document.createElement('p');
    note.className = 'wm-settings__port-note';
    note.textContent = description;
    wrapper.append(note);
  }

  return wrapper;
}

function createSubheading(text) {
  const heading = document.createElement('h6');
  heading.style.cssText = 'margin:14px 0 8px;font-size:0.92rem;letter-spacing:0.01em;';
  heading.textContent = text;
  return heading;
}

function formatDiagnostic(diagnostic) {
  if (!diagnostic) return 'None';
  const status = diagnostic.ok ? 'ok' : (diagnostic.code || 'failed');
  return `${status} at ${diagnostic.at}`;
}

function formatAdvisory(advisory) {
  if (!advisory || !advisory.at) {
    return 'None';
  }
  const parts = [
    advisory.eventType || 'unknown',
    advisory.eventId ? `event_id=${advisory.eventId}` : null,
    advisory.recordId ? `record_id=${advisory.recordId}` : null,
    advisory.familyHash ? `family_hash=${advisory.familyHash}` : null,
    `at ${advisory.at}`,
  ].filter(Boolean);
  return parts.join(', ');
}

function formatTrail(subscription) {
  const trail = subscription.diagnostics?.trail;
  if (!trail) {
    return 'No advisory trail yet.';
  }

  const advisoryStep = trail.advisory?.seen
    ? `advisory seen${trail.advisory.recordId ? ` for ${trail.advisory.recordId}` : ''}${trail.advisory.eventId ? ` (${trail.advisory.eventId})` : ''}`
    : 'advisory pending';
  const pullStep = trail.recordPull?.at
    ? `pull ${trail.recordPull.ok ? 'ok' : (trail.recordPull.code || 'failed')}`
    : 'pull pending';
  const decryptStep = trail.decrypt?.at
    ? `decrypt ${trail.decrypt.ok ? 'ok' : (trail.decrypt.code || 'failed')}`
    : 'decrypt pending';
  const routingStep = trail.routing?.at
    ? `routing ${trail.routing.ok ? 'ok' : (trail.routing.code || 'failed')}`
    : 'routing pending';

  return `${advisoryStep} -> ${pullStep} -> ${decryptStep} -> ${routingStep}`;
}

function formatTimestamp(value) {
  if (typeof value !== 'string' || !value) {
    return 'None';
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

function createEventPollPill(subscription) {
  if (!subscription || subscription.onboardingSource !== 'nostr_33357') {
    return createTonePill('Poll N/A', 'muted');
  }
  const okAt = Date.parse(subscription.lastEventPollOkAt || '');
  const errorAt = Date.parse(subscription.lastEventPollErrorAt || '');
  if (Number.isFinite(errorAt) && (!Number.isFinite(okAt) || errorAt > okAt)) {
    return createTonePill('Poll Error', 'danger');
  }
  if (!Number.isFinite(okAt)) {
    return createTonePill('Poll Pending', 'warning');
  }
  const ageSeconds = Math.max(0, Math.round((Date.now() - okAt) / 1000));
  if (ageSeconds > 45) {
    return createTonePill(`Poll Stale ${ageSeconds}s`, 'danger');
  }
  return createTonePill(`Poll OK ${ageSeconds}s`, 'success');
}

function shortenIdentifier(value, { head = 10, tail = 6 } = {}) {
  if (typeof value !== 'string' || !value) {
    return 'None';
  }
  if (value.length <= head + tail + 1) {
    return value;
  }
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function shortenPath(value) {
  if (typeof value !== 'string' || !value) {
    return 'None';
  }
  if (value.length <= 54) {
    return value;
  }
  const parts = value.split('/').filter(Boolean);
  if (parts.length < 3) {
    return shortenIdentifier(value, { head: 22, tail: 14 });
  }
  return `.../${parts.slice(-3).join('/')}`;
}

function isProbablyIdentifier(value) {
  return typeof value === 'string'
    && (
      value.startsWith('npub1')
      || /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(value)
      || /^[0-9a-f]{32,}$/i.test(value)
    );
}

function formatDisplayValue(value) {
  if (typeof value !== 'string' || !value) {
    return 'None';
  }
  if (value.startsWith('/')) {
    return shortenPath(value);
  }
  if (isProbablyIdentifier(value)) {
    return shortenIdentifier(value, { head: 14, tail: 8 });
  }
  if (value.length > 96) {
    return `${value.slice(0, 92)}...`;
  }
  return value;
}

function resolveEventFamily(event) {
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

function isTransportEvent(event) {
  return event?.eventType === 'connected' || event?.eventType === 'heartbeat';
}

function isWorkSignalEvent(event) {
  const family = resolveEventFamily(event);
  return family === 'task' || family === 'approval';
}

function countWhere(items, predicate) {
  return items.reduce((count, item) => (predicate(item) ? count + 1 : count), 0);
}

function buildEventFingerprint(event) {
  const recordId = typeof event?.payload?.record_id === 'string'
    ? event.payload.record_id
    : typeof event?.payload?.entity_id === 'string'
      ? event.payload.entity_id
      : null;
  return JSON.stringify({
    eventType: event?.eventType || 'unknown',
    family: resolveEventFamily(event),
    recordId,
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

function createPill(text, tone = 'default') {
  const pill = document.createElement('span');
  const styles = {
    default: 'background:var(--wm-pill-muted-bg);border:1px solid var(--wm-pill-muted-border);color:var(--wm-pill-muted-fg);',
    success: 'background:var(--wm-pill-success-bg);border:1px solid var(--wm-pill-success-border);color:var(--wm-pill-success-fg);',
    warning: 'background:var(--wm-pill-warning-bg);border:1px solid var(--wm-pill-warning-border);color:var(--wm-pill-warning-fg);',
    danger: 'background:var(--wm-pill-danger-bg);border:1px solid var(--wm-pill-danger-border);color:var(--wm-pill-danger-fg);',
    muted: 'background:var(--wm-pill-muted-bg);border:1px solid var(--wm-pill-muted-border);color:var(--wm-pill-muted-fg);',
  };
  pill.textContent = text;
  pill.style.cssText = `display:inline-flex;align-items:center;padding:5px 10px;border-radius:999px;font-size:0.84em;${styles[tone] || styles.default}`;
  return pill;
}

function createPillRow(pills) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;';
  row.append(...pills);
  return row;
}

function createMetricGrid(items) {
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:14px;';
  items.forEach(({ label, value }) => {
    const tile = document.createElement('div');
    tile.style.cssText = 'padding:12px;border-radius:14px;border:1px solid rgba(255,255,255,0.08);background:linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02));';

    const labelEl = document.createElement('div');
    labelEl.className = 'wm-settings__port-note';
    labelEl.textContent = label;

    const valueEl = document.createElement('div');
    valueEl.style.cssText = 'font-size:1.15rem;font-weight:700;margin-top:4px;word-break:break-word;';
    valueEl.textContent = value;
    valueEl.title = value;

    tile.append(labelEl, valueEl);
    grid.append(tile);
  });
  return grid;
}

function createDefinitionGrid(rows) {
  const grid = document.createElement('dl');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 16px;margin:12px 0 0;';

  rows.forEach(([termText, rawValue]) => {
    const valueText = typeof rawValue === 'string' ? rawValue : String(rawValue ?? 'None');

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'padding:12px;border-radius:14px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.02);';

    const term = document.createElement('dt');
    term.className = 'wm-settings__port-note';
    term.textContent = termText;

    const value = document.createElement('dd');
    value.style.cssText = 'margin:6px 0 0;font-size:0.95em;word-break:break-word;';
    value.textContent = formatDisplayValue(valueText);
    value.title = valueText;

    wrapper.append(term, value);
    grid.append(wrapper);
  });

  return grid;
}

function createEntryList(items, renderItem, testId) {
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:10px;';
  if (testId) {
    list.setAttribute('data-testid', testId);
  }
  items.forEach((item) => {
    list.append(renderItem(item));
  });
  return list;
}

function formatEventSummary(event) {
  const family = resolveEventFamily(event);
  const recordId = typeof event?.payload?.record_id === 'string'
    ? shortenIdentifier(event.payload.record_id)
    : 'no-record';
  return `${event.eventType || 'unknown'} · ${family} · ${recordId}`;
}

function formatEventMeta(event) {
  const repeatSuffix = Number(event?.repeatCount ?? 1) > 1 ? ` · repeated ${event.repeatCount}x` : '';
  return `${formatTimestamp(event?.at)}${repeatSuffix}`;
}

function createTimelineEntry(titleText, detailText, metaText, tone = 'default') {
  const palettes = {
    default: {
      border: 'rgba(255,255,255,0.08)',
      background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))',
    },
    success: {
      border: 'rgba(34, 197, 94, 0.24)',
      background: 'linear-gradient(180deg, rgba(34, 197, 94, 0.08), rgba(255,255,255,0.02))',
    },
    warning: {
      border: 'rgba(245, 158, 11, 0.26)',
      background: 'linear-gradient(180deg, rgba(245, 158, 11, 0.08), rgba(255,255,255,0.02))',
    },
    muted: {
      border: 'rgba(148, 163, 184, 0.22)',
      background: 'linear-gradient(180deg, rgba(148, 163, 184, 0.08), rgba(255,255,255,0.02))',
    },
  };
  const palette = palettes[tone] || palettes.default;

  const card = document.createElement('article');
  card.style.cssText = `padding:12px 14px;border-radius:14px;border:1px solid ${palette.border};background:${palette.background};`;

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:650;';
  title.textContent = titleText;

  const detail = document.createElement('div');
  detail.style.cssText = 'margin-top:4px;font-size:0.93em;word-break:break-word;';
  detail.textContent = detailText;

  const meta = document.createElement('div');
  meta.className = 'wm-settings__port-note';
  meta.style.marginTop = '6px';
  meta.textContent = metaText;

  card.append(title, detail, meta);
  return card;
}

function formatDispatchDetails(details) {
  if (!details || typeof details !== 'object') {
    return '';
  }
  const orderedKeys = [
    'reason',
    'task_id',
    'approval_id',
    'approval_state',
    'flow_run_id',
    'flow_id',
    'updater_npub',
    'sender_npub',
    'assigned_to',
    'state',
    'predecessor_task_ids',
  ];
  const entries = [];
  for (const key of orderedKeys) {
    const value = details[key];
    if (Array.isArray(value)) {
      if (value.length > 0) {
        entries.push(`${key}=${value.join('|')}`);
      }
      continue;
    }
    if (value != null && value !== '') {
      entries.push(`${key}=${String(value)}`);
    }
  }
  return entries.join(' · ');
}

function dispatchTone(entry) {
  return String(entry?.action || '').includes('skip') ? 'warning' : 'success';
}

function createTimelineList({ title, description, items, emptyText, renderItem, testId }) {
  const section = createSection(title, description);
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = emptyText;
    section.append(empty);
    return section;
  }

  section.append(createEntryList(items, renderItem, testId));
  return section;
}

function createNotice(message, tone = 'warning') {
  const tones = {
    warning: {
      border: 'rgba(245, 158, 11, 0.28)',
      background: 'rgba(245, 158, 11, 0.08)',
    },
    muted: {
      border: 'rgba(148, 163, 184, 0.26)',
      background: 'rgba(148, 163, 184, 0.08)',
    },
  };
  const palette = tones[tone] || tones.warning;

  const note = document.createElement('div');
  note.style.cssText = `margin-top:12px;padding:12px 14px;border-radius:14px;border:1px solid ${palette.border};background:${palette.background};font-size:0.93em;line-height:1.45;`;
  note.textContent = message;
  return note;
}

function createDisclosure(label, value) {
  const details = document.createElement('details');
  details.style.marginTop = '12px';

  const summary = document.createElement('summary');
  summary.style.cssText = 'cursor:pointer;font-size:0.92em;';
  summary.textContent = label;

  const pre = document.createElement('pre');
  pre.className = 'wm-agent-dispatch-preview';
  pre.textContent = value;

  details.append(summary, pre);
  return details;
}

function createDisclosureSection(title, description, content, { open = false } = {}) {
  const details = document.createElement('details');
  details.style.cssText = 'margin-top:14px;padding:12px 14px;border-radius:14px;border:1px solid var(--border-primary);background:rgba(127,127,127,0.04);';
  details.open = open;

  const summary = document.createElement('summary');
  summary.style.cssText = 'cursor:pointer;list-style:none;';

  const heading = document.createElement('div');
  heading.style.cssText = 'font-weight:650;';
  heading.textContent = title;
  summary.append(heading);

  if (description) {
    const note = document.createElement('div');
    note.className = 'wm-settings__port-note';
    note.style.marginTop = '4px';
    note.textContent = description;
    summary.append(note);
  }

  details.append(summary, content);
  return details;
}

function createActionButton(label, ariaLabel, testId, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wm-button secondary';
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  button.setAttribute('data-testid', testId);
  button.addEventListener('click', onClick);
  return button;
}

function createRecommendedList(subscription) {
  const recommendations = Array.isArray(subscription.operator?.recommendations)
    ? subscription.operator.recommendations
    : [];
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'margin-top:10px;';

  const heading = document.createElement('h5');
  heading.textContent = 'Recommended Repair Flows';
  wrapper.append(heading);

  if (recommendations.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No repair action is currently recommended.';
    wrapper.append(empty);
    return wrapper;
  }

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:10px;';

  recommendations.forEach((entry) => {
    list.append(createTimelineEntry(
      entry.label,
      entry.reason,
      'Suggested operator action',
      'warning',
    ));
  });

  wrapper.append(list);
  return wrapper;
}

function describeLatestEvent(latest) {
  if (isTransportEvent(latest)) {
    return 'This is stream transport activity. It confirms connection state, not a routed record.';
  }

  const family = resolveEventFamily(latest);
  if (latest?.eventType === 'record-changed') {
    return `Latest record change belongs to the ${family} family. Record changes are inputs; dispatch history only updates after the runtime accepts the record.`;
  }

  return 'This is the newest event captured from the workspace stream.';
}

function createLatestSsePanel(subscription) {
  const latest = subscription.lastSseEvent;
  const section = createSection(
    'Latest Workspace Event',
    'Newest event captured from the workspace stream.',
  );

  if (!latest) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No SSE message has been captured yet.';
    section.append(empty);
    return section;
  }

  const recordId = typeof latest.payload?.record_id === 'string' ? latest.payload.record_id : 'None';
  const family = resolveEventFamily(latest);
  section.append(createMetricGrid([
    { label: 'Type', value: latest.eventType || 'unknown' },
    { label: 'Family', value: family },
    { label: 'Record', value: shortenIdentifier(recordId) },
    { label: 'At', value: formatTimestamp(latest.at) },
  ]));
  section.append(createNotice(describeLatestEvent(latest), isTransportEvent(latest) ? 'muted' : 'warning'));
  section.append(createDisclosure('Show raw payload', JSON.stringify(latest.payload ?? null, null, 2)));
  return section;
}

function createInterceptTable(subscription) {
  const intercepts = Array.isArray(subscription.intercepts) ? subscription.intercepts : [];
  const wrapper = createSection(
    'Chat Intercepts',
    'Thread bindings and pending-turn state for routed chat conversations.',
  );

  if (intercepts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No routed intercepts yet.';
    wrapper.append(empty);
    return wrapper;
  }

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:10px;';
  list.setAttribute('data-testid', `agent-chat-intercepts-${subscription.subscriptionId}`);

  intercepts.forEach((intercept) => {
    const item = document.createElement('article');
    item.style.cssText = 'padding:12px;border-radius:14px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.02);';

    const title = document.createElement('div');
    title.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;';
    const heading = document.createElement('strong');
    heading.textContent = intercept.agentId || 'unknown';
    title.append(
      heading,
      createPill(intercept.lastDecision || 'pending', intercept.lastDecision === 'respond' ? 'success' : intercept.lastDecision === 'failed' ? 'danger' : 'muted'),
      createPill(intercept.state || 'pending', intercept.state?.startsWith('blocked') ? 'warning' : 'default'),
      createPill(`pending ${String(intercept.pendingMessageCount ?? 0)}`, 'muted'),
    );

    const threadLine = document.createElement('div');
    threadLine.style.cssText = 'margin-top:8px;font-size:0.93em;word-break:break-word;';
    threadLine.textContent = `channel ${shortenIdentifier(intercept.channelId)} · thread ${shortenIdentifier(intercept.threadId)} · session ${shortenIdentifier(intercept.sessionId || 'None')}`;

    const meta = document.createElement('div');
    meta.className = 'wm-settings__port-note';
    meta.style.marginTop = '6px';
    meta.textContent = `Last activity ${formatTimestamp(intercept.lastActivityAt)}`;

    item.append(title, threadLine, meta);
    list.append(item);
  });

  wrapper.append(list);
  return wrapper;
}

function createCandidateAgentTable(subscription) {
  const candidateAgents = Array.isArray(subscription.candidateAgents) ? subscription.candidateAgents : [];
  const wrapper = createSection('Candidate Agents', 'Local agents currently eligible for this bot/workspace subscription.');

  if (candidateAgents.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No local agents currently target this subscription bot/workspace pair.';
    wrapper.append(empty);
    return wrapper;
  }

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:10px;';
  list.setAttribute('data-testid', `agent-chat-candidates-${subscription.subscriptionId}`);

  candidateAgents.forEach((agent) => {
    const item = document.createElement('article');
    item.style.cssText = 'padding:12px;border-radius:14px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.02);';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:650;';
    title.textContent = agent.label || agent.agentId || 'unknown';

    const meta = document.createElement('div');
    meta.className = 'wm-settings__port-note';
    meta.style.marginTop = '4px';
    const capabilities = Array.isArray(agent.capabilities) && agent.capabilities.length > 0
      ? agent.capabilities.join(', ')
      : 'no capabilities';
    meta.textContent = `${agent.agentId || 'unknown'} · ${agent.enabled ? 'enabled' : 'disabled'} · ${capabilities}`;

    const directory = document.createElement('div');
    directory.style.cssText = 'margin-top:6px;font-size:0.92em;word-break:break-word;';
    directory.textContent = shortenPath(agent.workingDirectory || 'No working directory');
    directory.title = agent.workingDirectory || '';

    item.append(title, meta, directory);
    list.append(item);
  });

  wrapper.append(list);
  return wrapper;
}

function createSseHistoryTable(subscription) {
  const recentEvents = Array.isArray(subscription.recentSseEvents) ? subscription.recentSseEvents.slice().reverse() : [];
  const recordEvents = dedupeEvents(recentEvents.filter((event) => !isTransportEvent(event)));
  const transportEvents = dedupeEvents(recentEvents.filter(isTransportEvent));
  const workSignals = recentEvents.filter(isWorkSignalEvent);

  const section = createSection(
    'Workspace Event Stream',
    'Record changes are the useful signals. Connected and heartbeat entries only describe stream health.',
  );

  section.append(createMetricGrid([
    { label: 'Recent Events', value: String(recentEvents.length) },
    { label: 'Record Changes', value: String(recordEvents.length) },
    { label: 'Work Signals', value: String(workSignals.length) },
    { label: 'Transport', value: String(transportEvents.length) },
  ]));

  if (!recentEvents.length) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No SSE activity captured yet.';
    section.append(empty);
    return section;
  }

  section.append(createSubheading('Recent Record Changes'));
  if (recordEvents.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No record changes in the recent event window.';
    section.append(empty);
  } else {
    section.append(createEntryList(
      recordEvents.slice(0, 6),
      (event) => createTimelineEntry(
        event.eventId ? `Event ${event.eventId}` : 'Record change',
        formatEventSummary(event),
        formatEventMeta(event),
        isWorkSignalEvent(event) ? 'warning' : 'default',
      ),
      `agent-chat-sse-history-${subscription.subscriptionId}`,
    ));
  }

  section.append(createSubheading('Transport'));
  if (transportEvents.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No recent transport-only events.';
    section.append(empty);
  } else {
    section.append(createEntryList(
      transportEvents.slice(0, 4),
      (event) => createTimelineEntry(
        event.eventId ? `Event ${event.eventId}` : 'Transport event',
        formatEventSummary(event),
        formatEventMeta(event),
        'muted',
      ),
    ));
  }

  return section;
}

function createDispatchHistoryTable(subscription) {
  const dispatches = Array.isArray(subscription.recentDispatches) ? subscription.recentDispatches.slice().reverse() : [];
  const recentEvents = Array.isArray(subscription.recentSseEvents) ? subscription.recentSseEvents.slice().reverse() : [];
  const chatDispatches = dispatches.filter((entry) => entry.kind === 'chat');
  const workDispatches = dispatches.filter((entry) => (
    entry.kind === 'task'
    || entry.kind === 'flow'
    || entry.kind === 'review'
    || entry.kind === 'approval'
  ));
  const workSignals = dedupeEvents(recentEvents.filter(isWorkSignalEvent));
  const taskSignals = countWhere(workSignals, (event) => resolveEventFamily(event) === 'task');
  const approvalSignals = countWhere(workSignals, (event) => resolveEventFamily(event) === 'approval');

  const wrapper = document.createElement('div');
  wrapper.style.marginTop = '12px';

  const summary = createSection(
    'Dispatch Activity',
    'Workspace stream activity and runtime dispatches are different stages. Seeing task records in SSE does not guarantee routed work.',
  );
  summary.append(createMetricGrid([
    { label: 'Chat Routes', value: String(chatDispatches.length) },
    { label: 'Work Outcomes', value: String(workDispatches.length) },
    { label: 'Task Signals', value: String(taskSignals) },
    { label: 'Approval Signals', value: String(approvalSignals) },
  ]));

  if (workSignals.length > 0 && workDispatches.length === 0) {
    summary.append(createNotice(
      'Task or approval record changes were seen on the stream, but none were routed into the agent-work runtime. That usually means the record was not actionable yet: no matching task-dispatch agent, not assigned to the agent bot, blocked by predecessors, already terminal, or the record payload did not normalise cleanly.',
    ));
  }

  wrapper.append(summary);

  wrapper.append(createTimelineList({
    title: 'Chat Dispatches',
    description: 'Recent chat-triggered routing decisions.',
    testId: `agent-chat-dispatch-history-chat-${subscription.subscriptionId}`,
    items: chatDispatches.slice(0, 6),
    emptyText: 'No chat dispatches recorded yet.',
    renderItem: (entry) => createTimelineEntry(
      `${entry.action || 'unknown'} · ${entry.agentId || 'unknown'}`,
      [
        `thread ${shortenIdentifier(entry.bindingId || entry.recordId || 'None')}`,
        `session ${shortenIdentifier(entry.sessionId || 'None')}`,
        formatDispatchDetails(entry.details),
      ].filter(Boolean).join(' · '),
      formatTimestamp(entry.at),
      dispatchTone(entry),
    ),
  }));

  wrapper.append(createTimelineList({
    title: 'Work Signals Seen',
    description: 'Recent task and approval record changes observed on the workspace stream.',
    items: workSignals.slice(0, 6),
    emptyText: 'No task or approval record changes seen yet.',
    renderItem: (event) => createTimelineEntry(
      `${resolveEventFamily(event)} · ${event.eventType || 'unknown'}`,
      `record ${shortenIdentifier(typeof event.payload?.record_id === 'string' ? event.payload.record_id : 'None')}`,
      formatEventMeta(event),
      'warning',
    ),
  }));

  wrapper.append(createTimelineList({
    title: 'Task And Approval Outcomes',
    description: 'Both routed work and explicit skip reasons appear here so task gating is debuggable.',
    testId: `agent-chat-dispatch-history-work-${subscription.subscriptionId}`,
    items: workDispatches.slice(0, 6),
    emptyText: 'No task or approval decisions recorded yet.',
    renderItem: (entry) => createTimelineEntry(
      `${entry.kind || 'unknown'} · ${entry.action || 'unknown'}`,
      [
        `${entry.agentId || 'unknown'}`,
        `binding ${shortenIdentifier(entry.bindingId || entry.recordId || 'None')}`,
        `session ${shortenIdentifier(entry.sessionId || 'None')}`,
        formatDispatchDetails(entry.details),
      ].filter(Boolean).join(' · '),
      formatTimestamp(entry.at),
      dispatchTone(entry),
    ),
  }));

  return wrapper;
}

function findLinkedSessions(subscription, chatSessions) {
  const intercepts = Array.isArray(subscription.intercepts) ? subscription.intercepts : [];
  const sessionIds = new Set(intercepts.map((intercept) => intercept.sessionId).filter(Boolean));
  const dispatchSessionIds = Array.isArray(subscription.recentDispatches)
    ? subscription.recentDispatches.map((entry) => entry.sessionId).filter(Boolean)
    : [];
  dispatchSessionIds.forEach((sessionId) => sessionIds.add(sessionId));
  const routingKeys = new Set(intercepts.map((intercept) => intercept.routingKey).filter(Boolean));
  return chatSessions.filter((session) => sessionIds.has(session.id) || routingKeys.has(session.origin?.id));
}

function createSessionTable(title, sessions, testId) {
  const wrapper = createSection(title);

  if (!Array.isArray(sessions) || sessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No agent dispatch sessions are currently active.';
    wrapper.append(empty);
    return wrapper;
  }

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:10px;';
  list.setAttribute('data-testid', testId);

  sessions.forEach((session) => {
    const item = document.createElement('article');
    item.style.cssText = 'padding:12px;border-radius:14px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.02);';

    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-weight:650;';
    titleEl.textContent = session.name || session.id;

    const meta = document.createElement('div');
    meta.className = 'wm-settings__port-note';
    meta.style.marginTop = '4px';
    meta.textContent = `${session.status || 'unknown'} · ${session.agentRuntimeStatus || 'unknown'} · ${formatTimestamp(session.startedAt)}`;

    const detail = document.createElement('div');
    detail.style.cssText = 'margin-top:6px;font-size:0.92em;word-break:break-word;';
    detail.textContent = `${session.metadata?.agentChatAgentId || session.agent || 'unknown'} · ${shortenIdentifier(session.origin?.id || 'No routing key', { head: 14, tail: 10 })}`;
    detail.title = session.origin?.id || '';

    item.append(titleEl, meta, detail);
    list.append(item);
  });

  wrapper.append(list);
  return wrapper;
}

export function filterAgentChatSessions(sessions) {
  return Array.isArray(sessions) ? sessions.filter(isAgentDispatchSession) : [];
}

export function createAgentChatOverview(subscriptions, chatSessions) {
  const card = document.createElement('article');
  card.className = 'wm-card';
  card.style.cssText = 'margin-top:12px;padding:14px;';
  card.setAttribute('data-testid', 'agent-chat-operator-overview');

  const heading = document.createElement('h4');
  heading.textContent = 'Workspace Live Overview';
  card.append(heading);

  const blockedIntercepts = subscriptions.reduce((count, subscription) => (
    count + (subscription.operator?.blockedInterceptCount ?? 0)
  ), 0);
  const agentCount = subscriptions.reduce((count, subscription) => (
    count + (subscription.operator?.candidateAgentCount ?? 0)
  ), 0);
  const workSignalCount = subscriptions.reduce((count, subscription) => (
    count + countWhere(Array.isArray(subscription.recentSseEvents) ? subscription.recentSseEvents : [], isWorkSignalEvent)
  ), 0);
  const workDispatchCount = subscriptions.reduce((count, subscription) => (
    count + countWhere(Array.isArray(subscription.recentDispatches) ? subscription.recentDispatches : [], (entry) => (
      entry.kind === 'task'
      || entry.kind === 'flow'
      || entry.kind === 'review'
      || entry.kind === 'approval'
    ))
  ), 0);

  const summary = document.createElement('p');
  summary.className = 'wm-settings__port-note';
  summary.textContent = `${subscriptions.length} workspace subscription${subscriptions.length === 1 ? '' : 's'}, ${agentCount} candidate agent${agentCount === 1 ? '' : 's'}, ${chatSessions.length} active dispatch session${chatSessions.length === 1 ? '' : 's'}, ${workSignalCount} recent work signal${workSignalCount === 1 ? '' : 's'}, ${workDispatchCount} recorded work outcome${workDispatchCount === 1 ? '' : 's'}, ${blockedIntercepts} blocked chat intercept${blockedIntercepts === 1 ? '' : 's'}.`;
  card.append(summary);

  card.append(createMetricGrid([
    { label: 'Subscriptions', value: String(subscriptions.length) },
    { label: 'Candidates', value: String(agentCount) },
    { label: 'Active Sessions', value: String(chatSessions.length) },
    { label: 'Work Signals', value: String(workSignalCount) },
    { label: 'Work Outcomes', value: String(workDispatchCount) },
    { label: 'Blocked', value: String(blockedIntercepts) },
  ]));

  return card;
}

export function createSubscriptionCard(subscription, chatSessions, handlers) {
  const routes = typeof handlers.getDispatchRoutes === 'function'
    ? handlers.getDispatchRoutes(subscription)
    : handlers.dispatchRoutes;
  const routeCount = Array.isArray(routes) ? routes.length : 0;
  const enabledRouteCount = Array.isArray(routes) ? routes.filter((route) => route.enabled !== false).length : 0;
  const isSelected = handlers.selectedSubscriptionId === subscription.subscriptionId;
  const card = document.createElement('article');
  card.className = 'wm-card';
  card.style.cssText = `margin-top:12px;padding:14px;${isSelected ? 'border-color:var(--accent-primary);' : ''}`;
  card.setAttribute('data-testid', `agent-chat-subscription-${subscription.subscriptionId}`);

  const heading = document.createElement('h4');
  heading.textContent = `${isSelected ? 'Selected workspace = ' : 'Workspace = '}${resolveWorkspaceName(subscription)}`;
  card.append(heading);

  const identity = document.createElement('p');
  identity.className = 'wm-settings__port-note';
  identity.textContent = `workspace ${shortenIdentifier(subscription.workspaceServiceNpub || subscription.workspaceOwnerNpub, { head: 18, tail: 10 })} · owner ${shortenIdentifier(subscription.workspaceOwnerNpub, { head: 18, tail: 10 })} · tower ${subscription.backendBaseUrl || 'unknown'} · bot ${shortenIdentifier(subscription.botNpub, { head: 18, tail: 10 })} · source ${shortenIdentifier(subscription.sourceAppNpub, { head: 18, tail: 10 })}`;
  identity.title = [
    `workspace: ${subscription.workspaceServiceNpub || subscription.workspaceOwnerNpub || ''}`,
    `owner: ${subscription.workspaceOwnerNpub || ''}`,
    `tower: ${subscription.backendBaseUrl || ''}`,
    `bot: ${subscription.botNpub || ''}`,
    `source: ${subscription.sourceAppNpub || ''}`,
  ].join('\n');
  card.append(identity);
  card.append(createPillRow([
    createTonePill(subscription.sseStatus === 'connected' ? 'SSE Connected' : `SSE ${subscription.sseStatus || 'unknown'}`, subscription.sseStatus === 'connected' ? 'success' : 'warning'),
    createEventPollPill(subscription),
    createTonePill(subscription.healthStatus === 'healthy' ? 'Healthy' : subscription.healthStatus || 'Unknown', subscription.healthStatus === 'healthy' ? 'success' : 'warning'),
    createTonePill(`${subscription.operator?.candidateAgentCount ?? 0} Agents`, subscription.operator?.candidateAgentCount > 0 ? 'success' : 'warning'),
    createTonePill(`${enabledRouteCount}/${routeCount} Routes`, enabledRouteCount > 0 ? 'success' : 'warning'),
  ]));
  if (handlers.hasDuplicateWorkspaceApp?.(subscription)) {
    card.append(createNotice('Same workspace/app on another Tower. Requires subscription-safe routing.', 'warning'));
  }

  card.append(createEventStreamPager(subscription, {
    routes,
    definitions: handlers.pipelineDefinitions,
  }));

  if (subscription.operator?.canManage !== false) {
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;';
    const actionButtons = [
      createActionButton(
        isSelected ? 'Selected' : 'Select',
        `Select Agent Dispatch subscription for ${subscription.workspaceOwnerNpub}`,
        `agent-chat-select-${subscription.subscriptionId}`,
        () => handlers.select?.(subscription),
      ),
      createActionButton(
        'Reconnect',
        `Reconnect Agent Chat subscription for ${subscription.workspaceOwnerNpub}`,
        `agent-chat-reconnect-${subscription.subscriptionId}`,
        () => handlers.runAction(subscription, 'reconnect'),
      ),
      createActionButton(
        'Refresh Keys',
        `Refresh Agent Chat keys for ${subscription.workspaceOwnerNpub}`,
        `agent-chat-refresh-keys-${subscription.subscriptionId}`,
        () => handlers.runAction(subscription, 'refresh-keys'),
      ),
      createActionButton(
        subscription.operator?.enabled ? 'Disable' : 'Enable',
        `${subscription.operator?.enabled ? 'Disable' : 'Enable'} Agent Chat subscription for ${subscription.workspaceOwnerNpub}`,
        `agent-chat-toggle-enabled-${subscription.subscriptionId}`,
        () => handlers.runAction(subscription, subscription.operator?.enabled ? 'disable' : 'enable'),
      ),
    ];
    if (handlers.allowConnectionManagement !== false) {
      actionButtons.splice(1, 0, createActionButton(
        'Edit Connection',
        `Edit Agent Dispatch subscription for ${subscription.workspaceOwnerNpub}`,
        `agent-chat-edit-${subscription.subscriptionId}`,
        () => handlers.edit?.(subscription),
      ));
      if (!isFlightDeckOnboardedSubscription(subscription)) {
        actionButtons.push(createActionButton(
          'Remove',
          `Remove Agent Chat subscription for ${subscription.workspaceOwnerNpub}`,
          `agent-chat-remove-${subscription.subscriptionId}`,
          () => handlers.remove?.(subscription),
        ));
      }
    }
    actions.append(...actionButtons);
    card.append(actions);
  }

  return card;
}

export function createAgentChatSessionPanel(chatSessions) {
  return createSessionTable('Dispatch Sessions', chatSessions, 'agent-chat-session-panel');
}
