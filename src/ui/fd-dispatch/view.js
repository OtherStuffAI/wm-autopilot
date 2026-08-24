import { listFlightDeckDispatchOutcomes } from '../services/agent-chat.js';

export const FLIGHT_DECK_DISPATCH_PAGE_SIZE = 25;

const DISPATCH_COLUMNS = Object.freeze([
  { className: 'target', label: 'Session / pipeline' },
  { className: 'received', label: 'Date/time received' },
  { className: 'workspace', label: 'Workspace' },
  { className: 'agent', label: 'Agent profile' },
  { className: 'source', label: 'Source' },
  { className: 'trigger', label: 'Trigger' },
  { className: 'outcome', label: 'Outcome' },
  { className: 'reason', label: 'Reason / diagnostic' },
  { className: 'action', label: 'Action' },
]);

export function flightDeckDispatchActionHref(row) {
  if (!row?.actionId) return null;
  if (row.action === 'session') return `/live/${encodeURIComponent(row.actionId)}`;
  if (row.action === 'pipeline') return `/pipelines/runs/${encodeURIComponent(row.actionId)}`;
  return null;
}

export function formatFlightDeckDispatchTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function formatFlightDeckDispatchReason(row) {
  if (row?.reasonLabel) return row.reasonLabel;
  return row?.outcome === 'suppressed' ? 'Reason not recorded' : '—';
}

export function formatFlightDeckDispatchSource(row) {
  return row?.sourceLabel?.trim() || 'Source label not recorded';
}

export function formatFlightDeckDispatchSourceDisplay(row) {
  return formatFlightDeckDispatchSource(row).replace(/@\[([^\]]+)\]\(mention:[^)]+\)/g, '$1');
}

function createTextCell(text, className, { title = null } = {}) {
  const cell = document.createElement('td');
  cell.className = `wm-flightdeck-dispatch__${className}`;
  cell.textContent = text ?? '—';
  if (title) cell.title = title;
  return cell;
}

function createClampedCell(text, className, { title = null } = {}) {
  const cell = document.createElement('td');
  cell.className = `wm-flightdeck-dispatch__${className}`;
  const value = document.createElement('span');
  value.className = 'wm-flightdeck-dispatch__clamped-value';
  value.textContent = text ?? '—';
  if (title) value.title = title;
  cell.append(value);
  return cell;
}

function createBadgeCell(value, className) {
  const cell = document.createElement('td');
  cell.className = `wm-flightdeck-dispatch__${className}`;
  if (!value) {
    cell.textContent = '—';
    return cell;
  }
  const badge = document.createElement('span');
  badge.className = 'wm-flightdeck-dispatch__badge';
  badge.dataset.state = String(value).toLowerCase();
  badge.textContent = value;
  cell.append(badge);
  return cell;
}

export function createDispatchTable(rows) {
  const wrapper = document.createElement('div');
  wrapper.className = 'wm-table-container wm-flightdeck-dispatch__table-wrap';
  wrapper.dataset.testid = 'flightdeck-dispatch-table-region';
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', 'Flight Deck dispatch outcomes table');

  const table = document.createElement('table');
  table.className = 'wm-flightdeck-dispatch__table';
  table.dataset.testid = 'flightdeck-dispatch-table';
  const caption = document.createElement('caption');
  caption.className = 'wm-sr-only';
  caption.textContent = 'Flight Deck dispatch outcomes';
  const columns = document.createElement('colgroup');
  for (const column of DISPATCH_COLUMNS) {
    const element = document.createElement('col');
    element.className = `wm-flightdeck-dispatch__col--${column.className}`;
    columns.append(element);
  }
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  DISPATCH_COLUMNS.forEach(({ label }) => {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    headRow.append(cell);
  });
  head.append(headRow);

  const body = document.createElement('tbody');
  for (const row of rows) {
    const tableRow = document.createElement('tr');
    const source = formatFlightDeckDispatchSource(row);
    const reason = formatFlightDeckDispatchReason(row);
    const linkCell = document.createElement('td');
    linkCell.className = 'wm-flightdeck-dispatch__target';
    const href = flightDeckDispatchActionHref(row);
    if (href) {
      const link = document.createElement('a');
      link.href = href;
      link.textContent = row.actionId;
      link.title = row.actionId;
      link.setAttribute('aria-label', `Open ${row.action} ${row.actionId}`);
      linkCell.append(link);
    } else {
      linkCell.textContent = '—';
    }
    tableRow.append(
      linkCell,
      createTextCell(formatFlightDeckDispatchTime(row.receivedAt), 'received'),
      createTextCell(row.workspaceName, 'workspace', { title: row.workspaceName }),
      createTextCell(row.agentId, 'agent', { title: row.agentId }),
      createClampedCell(formatFlightDeckDispatchSourceDisplay(row), 'source', { title: source }),
      createTextCell(row.trigger, 'trigger'),
      createBadgeCell(row.outcome, 'outcome'),
      createClampedCell(reason, 'reason', { title: reason === '—' ? null : reason }),
      createBadgeCell(row.action, 'action'),
    );
    body.append(tableRow);
  }
  table.append(caption, columns, head, body);
  wrapper.append(table);
  return wrapper;
}

export function createFlightDeckDispatchView({ loadPage = listFlightDeckDispatchOutcomes } = {}) {
  const view = document.createElement('div');
  view.className = 'wm-flightdeck-dispatch';
  view.dataset.testid = 'flightdeck-dispatch-view';

  const header = document.createElement('header');
  header.className = 'wm-flightdeck-dispatch__header';
  const heading = document.createElement('div');
  const title = document.createElement('h2');
  title.id = 'flightdeck-dispatch-title';
  title.textContent = 'FD Dispatch';
  const description = document.createElement('p');
  description.textContent = 'Review how Flight Deck events were routed into sessions and pipelines.';
  heading.append(title, description);
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'wm-button secondary';
  refresh.textContent = 'Refresh';
  refresh.dataset.testid = 'flightdeck-dispatch-refresh';
  refresh.setAttribute('aria-label', 'Refresh Flight Deck dispatch outcomes');
  header.append(heading, refresh);

  const section = document.createElement('section');
  section.className = 'wm-card wm-flightdeck-dispatch__panel';
  section.dataset.testid = 'flightdeck-dispatch-panel';
  section.setAttribute('aria-labelledby', 'flightdeck-dispatch-title');
  const controls = document.createElement('div');
  controls.className = 'wm-flightdeck-dispatch__controls';
  const filterLabel = document.createElement('label');
  filterLabel.className = 'wm-flightdeck-dispatch__filter';
  const includeFiltered = document.createElement('input');
  includeFiltered.type = 'checkbox';
  includeFiltered.checked = false;
  includeFiltered.dataset.testid = 'flightdeck-dispatch-include-filtered';
  includeFiltered.setAttribute('aria-label', 'Show ignored and suppressed dispatch outcomes');
  const filterText = document.createElement('span');
  filterText.textContent = 'Show ignored and suppressed';
  filterLabel.append(includeFiltered, filterText);
  controls.append(filterLabel);
  const content = document.createElement('div');
  content.className = 'wm-flightdeck-dispatch__content';
  const status = document.createElement('p');
  status.className = 'wm-flightdeck-dispatch__status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Loading dispatch outcomes…';
  content.append(status);

  const pagination = document.createElement('nav');
  pagination.className = 'wm-flightdeck-dispatch__pagination';
  pagination.setAttribute('aria-label', 'Flight Deck Dispatch pages');
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'wm-button secondary';
  previous.textContent = 'Previous';
  previous.dataset.testid = 'flightdeck-dispatch-previous';
  previous.setAttribute('aria-label', 'Previous Flight Deck Dispatch page');
  const pageLabel = document.createElement('span');
  pageLabel.dataset.testid = 'flightdeck-dispatch-page';
  pageLabel.textContent = 'Page 1';
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'wm-button secondary';
  next.textContent = 'Next';
  next.dataset.testid = 'flightdeck-dispatch-next';
  next.setAttribute('aria-label', 'Next Flight Deck Dispatch page');
  pagination.append(previous, pageLabel, next);

  let offset = 0;
  let loading = false;

  async function renderPage() {
    if (loading) return;
    loading = true;
    refresh.disabled = true;
    previous.disabled = true;
    next.disabled = true;
    status.dataset.state = 'loading';
    status.textContent = 'Loading dispatch outcomes…';
    try {
      const page = await loadPage({
        limit: FLIGHT_DECK_DISPATCH_PAGE_SIZE,
        offset,
        includeIgnoredAndSuppressed: includeFiltered.checked,
      });
      content.replaceChildren();
      status.dataset.state = page.rows.length === 0 ? 'empty' : 'ready';
      if (page.rows.length === 0) {
        status.textContent = offset > 0 ? 'No dispatch outcomes on this page.' : 'No Flight Deck dispatch outcomes recorded yet.';
        content.append(status);
      } else {
        status.textContent = `Showing ${offset + 1}–${offset + page.rows.length} of ${page.total} dispatch outcomes.`;
        content.append(status, createDispatchTable(page.rows));
      }
      const pageNumber = Math.floor(offset / FLIGHT_DECK_DISPATCH_PAGE_SIZE) + 1;
      const pageCount = Math.max(1, Math.ceil(page.total / FLIGHT_DECK_DISPATCH_PAGE_SIZE));
      pageLabel.textContent = `Page ${pageNumber} of ${pageCount}`;
      previous.disabled = offset === 0;
      next.disabled = offset + page.rows.length >= page.total;
    } catch (error) {
      content.replaceChildren(status);
      status.dataset.state = 'error';
      status.textContent = error instanceof Error ? error.message : 'Failed to load Flight Deck dispatch outcomes.';
      previous.disabled = offset === 0;
    } finally {
      loading = false;
      refresh.disabled = false;
    }
  }

  refresh.addEventListener('click', () => void renderPage());
  includeFiltered.addEventListener('change', () => {
    offset = 0;
    void renderPage();
  });
  previous.addEventListener('click', () => {
    offset = Math.max(0, offset - FLIGHT_DECK_DISPATCH_PAGE_SIZE);
    void renderPage();
  });
  next.addEventListener('click', () => {
    offset += FLIGHT_DECK_DISPATCH_PAGE_SIZE;
    void renderPage();
  });

  section.append(controls, content, pagination);
  view.append(header, section);
  void renderPage();
  return view;
}
