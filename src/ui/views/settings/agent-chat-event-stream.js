import { fetchPipelineRun } from '../../pipelines/api.js';
import {
  getEventRecordId,
  getRecentEventRows,
  resolveEventFamily,
  resolveEventState,
} from './agent-chat-event-stream-state.js';

export {
  getEventRecordId,
  getRecentEventRows,
  resolveEventFamily,
  resolveEventState,
} from './agent-chat-event-stream-state.js';

function formatTimestamp(value) {
  if (typeof value !== 'string' || !value) {
    return 'None';
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
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

function createSection(title) {
  const wrapper = document.createElement('section');
  wrapper.style.cssText = 'margin-top:18px;';

  const heading = document.createElement('h5');
  heading.style.marginBottom = '6px';
  heading.textContent = title;
  wrapper.append(heading);

  return wrapper;
}

function createPillRow(items) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;';
  row.append(...items);
  return row;
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
    value.textContent = valueText.length > 96 ? `${valueText.slice(0, 92)}...` : valueText;
    value.title = valueText;

    wrapper.append(term, value);
    grid.append(wrapper);
  });

  return grid;
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

export function resolveWorkspaceName(subscription) {
  const candidates = [
    subscription?.profileWorkspace?.workspace?.workspaceTitle,
    subscription?.workspaceName,
    subscription?.backend?.workspaceName,
    subscription?.profileWorkspace?.workspace?.workspaceId,
    subscription?.workspaceId,
  ];
  for (const candidate of candidates) {
    const name = typeof candidate === 'string' ? candidate.trim() : '';
    if (name) {
      return name;
    }
  }
  return shortenIdentifier(subscription.workspaceOwnerNpub, { head: 18, tail: 10 });
}

function getEventNumber(event, fallbackIndex) {
  const eventId = event?.eventId ?? event?.payload?.event_id ?? event?.payload?.id ?? null;
  return eventId ? String(eventId) : String(fallbackIndex + 1);
}

function findRouteForDispatch(dispatch, routes) {
  if (!dispatch?.routeId || !Array.isArray(routes)) {
    return null;
  }
  return routes.find((route) => route.routeId === dispatch.routeId) ?? null;
}

function findPipelineDefinition(route, definitions) {
  if (!route?.pipelineDefinitionId || !Array.isArray(definitions)) {
    return null;
  }
  return definitions.find((definition) => (
    definition.id === route.pipelineDefinitionId
    || definition.definitionId === route.pipelineDefinitionId
    || definition.path === route.pipelineDefinitionId
  )) ?? null;
}

function buildPipelineInputPreview(subscription, event, dispatch, route) {
  const recordId = getEventRecordId(event);
  return {
    ...(route?.inputTemplateJson ?? {}),
    dispatch: {
      routeId: route?.routeId ?? dispatch?.routeId ?? null,
      triggerKind: route?.triggerKind ?? dispatch?.details?.trigger_kind ?? null,
      receivedAt: event?.at ?? null,
      pipelineRunId: dispatch?.pipelineRunId ?? null,
    },
    workspace: {
      workspaceName: resolveWorkspaceName(subscription),
      workspaceOwnerNpub: subscription.workspaceOwnerNpub,
      sourceAppNpub: subscription.sourceAppNpub,
      backendBaseUrl: subscription.backendBaseUrl,
      subscriptionId: subscription.subscriptionId,
    },
    record: {
      recordId,
      recordFamily: resolveEventFamily(event),
      eventType: event?.eventType ?? null,
      eventPayload: event?.payload ?? null,
    },
  };
}

function createEventDetailsModal({ subscription, event, eventIndex, dispatch, diagnostic, routes, definitions }) {
  const route = findRouteForDispatch(dispatch, routes);
  const definition = findPipelineDefinition(route, definitions);
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(0,0,0,0.58);';
  overlay.setAttribute('role', 'presentation');

  const modal = document.createElement('section');
  modal.className = 'wm-card';
  modal.style.cssText = 'width:min(920px,100%);max-height:min(86vh,820px);overflow:auto;padding:18px;';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', `Event ${getEventNumber(event, eventIndex)} details`);
  modal.setAttribute('data-testid', 'agent-chat-event-details-modal');

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:12px;';
  const title = document.createElement('div');
  const heading = document.createElement('h4');
  heading.textContent = `Event ${getEventNumber(event, eventIndex)}`;
  const meta = document.createElement('p');
  meta.className = 'wm-settings__port-note';
  meta.textContent = `${resolveEventFamily(event)} · ${formatTimestamp(event?.at)} · record ${shortenIdentifier(getEventRecordId(event) || 'None', { head: 14, tail: 8 })}`;
  title.append(heading, meta);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'wm-button secondary';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close event details');
  close.addEventListener('click', () => overlay.remove());
  header.append(title, close);

  const pipelineDetails = {
    routeId: dispatch?.routeId ?? null,
    pipelineRunId: dispatch?.pipelineRunId ?? null,
    pipelineDefinitionId: route?.pipelineDefinitionId ?? dispatch?.details?.pipeline_definition_id ?? null,
    pipelineName: definition?.name ?? null,
    status: dispatch?.status ?? null,
    action: dispatch?.action ?? null,
    diagnostic: diagnostic?.message ?? dispatch?.details?.diagnostic_summary ?? null,
  };

  const pipelineLink = document.createElement('a');
  pipelineLink.className = 'wm-button secondary';
  pipelineLink.textContent = 'Open Pipelines';
  pipelineLink.href = dispatch?.pipelineRunId
    ? `/pipelines?run=${encodeURIComponent(dispatch.pipelineRunId)}`
    : '/pipelines';
  pipelineLink.setAttribute('aria-label', 'Open Pipelines view for this dispatch');

  const dispatchSection = createSection('Pipeline Dispatch');
  dispatchSection.append(
    createDefinitionGrid([
      ['State', resolveEventState(subscription, event).label],
      ['Pipeline', pipelineDetails.pipelineName || pipelineDetails.pipelineDefinitionId || 'None'],
      ['Run', pipelineDetails.pipelineRunId || 'None'],
      ['Route', pipelineDetails.routeId || 'None'],
      ['Action', pipelineDetails.action || 'None'],
      ['Diagnostic', pipelineDetails.diagnostic || 'None'],
    ]),
    createPillRow([pipelineLink]),
  );

  const promptSection = createSection('Pipeline Input');
  const previewHost = document.createElement('div');
  previewHost.append(createDisclosure(
    'Show first-step input object',
    JSON.stringify(buildPipelineInputPreview(subscription, event, dispatch, route), null, 2),
  ));
  promptSection.append(previewHost);
  if (dispatch?.pipelineRunId) {
    previewHost.replaceChildren();
    const loading = document.createElement('p');
    loading.className = 'wm-settings__port-note';
    loading.textContent = 'Loading actual pipeline run input...';
    previewHost.append(loading);
    void fetchPipelineRun(dispatch.pipelineRunId, {
      includeRunPayload: true,
      includeStepPayload: true,
      forceFresh: true,
    }).then((payload) => {
      const firstStep = Array.isArray(payload.steps) ? payload.steps[0] : null;
      previewHost.replaceChildren(
        createDisclosure('Show run input object', JSON.stringify(payload.run?.input ?? null, null, 2)),
        createDisclosure('Show first-step input object', JSON.stringify(firstStep?.input ?? null, null, 2)),
      );
    }).catch((error) => {
      previewHost.replaceChildren();
      const failed = document.createElement('p');
      failed.className = 'wm-settings__port-note';
      failed.textContent = error instanceof Error ? error.message : 'Failed to load actual pipeline input.';
      previewHost.append(
        failed,
        createDisclosure(
          'Show reconstructed input object',
          JSON.stringify(buildPipelineInputPreview(subscription, event, dispatch, route), null, 2),
        ),
      );
    });
  }

  const rawSection = createSection('Raw Event');
  rawSection.append(createDisclosure('Show event payload', JSON.stringify(event ?? null, null, 2)));

  modal.append(header, dispatchSection, promptSection, rawSection);
  overlay.append(modal);
  overlay.addEventListener('click', (clickEvent) => {
    if (clickEvent.target === overlay) {
      overlay.remove();
    }
  });
  document.body.append(overlay);
  close.focus();
}

export function createEventStreamPager(subscription, { routes = [], definitions = [] } = {}) {
  const wrapper = document.createElement('section');
  wrapper.style.cssText = 'margin-top:16px;';

  const heading = document.createElement('h5');
  heading.textContent = 'Event Stream';
  wrapper.append(heading);

  const events = getRecentEventRows(subscription);
  if (events.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'wm-settings__port-note';
    empty.textContent = 'No workspace events have arrived yet.';
    wrapper.append(empty);
    return wrapper;
  }

  const pageSize = 10;
  let pageIndex = 0;
  const tableHost = document.createElement('div');
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;';

  const render = () => {
    tableHost.replaceChildren();
    controls.replaceChildren();
    const start = pageIndex * pageSize;
    const page = events.slice(start, start + pageSize);
    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;margin-top:10px;font-size:0.94em;';
    table.setAttribute('data-testid', `agent-chat-event-stream-${subscription.subscriptionId}`);

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    ['Event #', 'Family', 'State'].forEach((label) => {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.style.cssText = 'text-align:left;padding:10px;border-bottom:1px solid var(--border-primary);';
      cell.textContent = label;
      headerRow.append(cell);
    });
    thead.append(headerRow);

    const tbody = document.createElement('tbody');
    page.forEach((event, index) => {
      const absoluteIndex = start + index;
      const state = resolveEventState(subscription, event);
      const row = document.createElement('tr');
      row.tabIndex = 0;
      row.style.cursor = 'pointer';
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Open event ${getEventNumber(event, absoluteIndex)} details`);
      row.setAttribute('data-testid', `agent-chat-event-row-${absoluteIndex}`);
      row.addEventListener('click', () => createEventDetailsModal({
        subscription,
        event,
        eventIndex: absoluteIndex,
        dispatch: state.dispatch,
        diagnostic: state.diagnostic,
        routes,
        definitions,
      }));
      row.addEventListener('keydown', (keyboardEvent) => {
        if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
          keyboardEvent.preventDefault();
          row.click();
        }
      });

      const eventCell = document.createElement('td');
      eventCell.style.cssText = 'padding:10px;border-bottom:1px solid rgba(255,255,255,0.06);';
      eventCell.textContent = getEventNumber(event, absoluteIndex);

      const familyCell = document.createElement('td');
      familyCell.style.cssText = 'padding:10px;border-bottom:1px solid rgba(255,255,255,0.06);';
      familyCell.textContent = resolveEventFamily(event);

      const stateCell = document.createElement('td');
      stateCell.style.cssText = 'padding:10px;border-bottom:1px solid rgba(255,255,255,0.06);';
      stateCell.append(createPill(state.label, state.tone));

      row.append(eventCell, familyCell, stateCell);
      tbody.append(row);
    });
    table.append(thead, tbody);
    tableHost.append(table);

    const pageLabel = document.createElement('span');
    pageLabel.className = 'wm-settings__port-note';
    pageLabel.textContent = `Showing ${start + 1}-${start + page.length} of ${events.length}`;

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;gap:8px;';
    const previous = createActionButton('Previous', 'Show previous workspace events', `agent-chat-events-prev-${subscription.subscriptionId}`, () => {
      pageIndex = Math.max(0, pageIndex - 1);
      render();
    });
    previous.disabled = pageIndex === 0;
    const next = createActionButton('Next', 'Show next workspace events', `agent-chat-events-next-${subscription.subscriptionId}`, () => {
      pageIndex = Math.min(Math.ceil(events.length / pageSize) - 1, pageIndex + 1);
      render();
    });
    next.disabled = start + pageSize >= events.length;
    buttons.append(previous, next);
    controls.append(pageLabel, buttons);
  };

  render();
  wrapper.append(tableHost, controls);
  return wrapper;
}
