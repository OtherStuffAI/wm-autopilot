import {
  botSubscriptionBotLabel, botSubscriptionClassificationLabel, botSubscriptionError, botSubscriptionInboxSummary,
  botSubscriptionStatus, botSubscriptionWorkspaceLabel, formatBotSubscriptionTime,
} from './bot-subscription-model.js';

const COLUMNS = Object.freeze([
  { key: 'bot', label: 'Bot' },
  { key: 'workspace', label: 'Workspace' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'classification', label: 'Tower classification' },
  { key: 'polling', label: 'Polling' },
  { key: 'issue', label: 'Last issue' },
  { key: 'activity', label: 'Activity', selectable: true },
]);

function node(tag, text, className = '') {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function cell(key, ...children) {
  const td = node('td', '', `wm-bot-subs__${key}`);
  td.append(...children);
  return td;
}

function botCell(row) {
  const name = node('strong', botSubscriptionBotLabel(row));
  const npub = node('code', row.botNpub || 'Public identity unavailable', 'wm-bot-subs__npub');
  npub.title = row.botNpub || '';
  const parts = [name, npub];
  if (row.kind === 'shared') {
    const served = row.servedAgentIds?.length || 0;
    parts.push(node('small', `Serves ${served} bot${served === 1 ? '' : 's'} · identity shown is the feed's connection identity`));
  }
  return cell('bot', ...parts);
}

function deliveryCell(row) {
  const status = botSubscriptionStatus(row);
  const badge = node('span', status.label, 'wm-bot-subs__badge');
  badge.dataset.tone = status.tone;
  badge.dataset.status = row.status;
  const detail = node('small', row.statusDetail || status.summary);
  return cell('delivery', badge, detail);
}

function classificationCell(row, record, { onCheckClassification, checking }) {
  const label = node('span', botSubscriptionClassificationLabel(row, record));
  label.dataset.testid = `bot-subs-classification-${row.rowId}`;
  if (record?.state) label.dataset.state = record.state;
  const parts = [label];
  if (row.kind === 'profile' && onCheckClassification) {
    const button = node('button', checking ? 'Checking…' : 'Check with Tower', 'wm-button secondary wm-bot-subs__check');
    button.type = 'button';
    button.disabled = Boolean(checking);
    button.dataset.testid = `bot-subs-check-${row.rowId}`;
    button.setAttribute('aria-label', `Check Tower classification for ${botSubscriptionBotLabel(row)} in ${botSubscriptionWorkspaceLabel(row)}`);
    button.addEventListener('click', () => onCheckClassification(row));
    parts.push(button);
  }
  return cell('classification', ...parts);
}

function pollingCell(row) {
  const inbox = botSubscriptionInboxSummary(row);
  const lines = inbox
    ? [inbox.established, inbox.lastOk, inbox.floor, inbox.lastGap].filter(Boolean)
    : [`Connection ${row.connection || 'unknown'} · ${row.health || 'health unknown'}`];
  lines.push(`Last successful poll ${formatBotSubscriptionTime(row.lastSuccessfulPollAt)}`);
  return cell('polling', ...lines.map((line) => node('small', line)));
}

function activityCell(row, { selectedRowId, onSelect }) {
  const button = node('button', row.rowId === selectedRowId ? 'Showing' : 'View activity', 'wm-button secondary');
  button.type = 'button';
  button.dataset.testid = `bot-subs-select-${row.rowId}`;
  button.setAttribute('aria-pressed', String(row.rowId === selectedRowId));
  button.setAttribute('aria-label', `Show dispatch activity for ${botSubscriptionBotLabel(row)} in ${botSubscriptionWorkspaceLabel(row)}`);
  button.addEventListener('click', () => onSelect(row));
  return cell('activity', button);
}

/**
 * One row per workspace+bot delivery path. Read-only: the only actions are an explicit Tower classification read and
 * selecting a row to filter dispatch activity. Nothing here migrates, classifies or reconnects.
 */
export function createBotSubscriptionTable(rows, {
  classifications = [], selectedRowId = null, onSelect = null, onCheckClassification = null, checkingIds = new Set(),
  caption = 'Bot delivery paths',
} = {}) {
  const wrapper = node('div', '', 'wm-table-container wm-bot-subs__table-wrap');
  wrapper.dataset.testid = 'bot-subs-table-region';
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', caption);
  const table = node('table', '', 'wm-bot-subs__table');
  table.dataset.testid = 'bot-subs-table';
  const captionNode = node('caption', caption, 'wm-sr-only');
  const columns = COLUMNS.filter((column) => !column.selectable || onSelect);
  const head = node('thead');
  const headRow = node('tr');
  for (const column of columns) {
    const th = node('th', column.label);
    th.scope = 'col';
    headRow.append(th);
  }
  head.append(headRow);
  const body = node('tbody');
  const records = new Map(classifications.map((record) => [record.subscriptionId, record]));
  for (const row of rows) {
    const tr = node('tr');
    tr.dataset.testid = `bot-subs-row-${row.rowId}`;
    tr.dataset.status = row.status;
    tr.dataset.kind = row.kind;
    if (row.rowId === selectedRowId) tr.dataset.selected = 'true';
    const issue = botSubscriptionError(row);
    tr.append(
      botCell(row),
      cell('workspace', node('span', botSubscriptionWorkspaceLabel(row))),
      deliveryCell(row),
      classificationCell(row, records.get(row.subscriptionId), { onCheckClassification, checking: checkingIds.has(row.subscriptionId) }),
      pollingCell(row),
      cell('issue', node('span', issue || 'None recorded')),
    );
    if (onSelect) tr.append(activityCell(row, { selectedRowId, onSelect }));
    body.append(tr);
  }
  table.append(captionNode, head, body);
  wrapper.append(table);
  return wrapper;
}
