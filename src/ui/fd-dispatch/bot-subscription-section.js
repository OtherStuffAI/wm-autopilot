import {
  listBotSubscriptionClassifications, listBotSubscriptions, readBotSubscriptionClassification,
} from '../services/bot-subscriptions.js';
import {
  botSubscriptionBotLabel, botSubscriptionLegacyFeed, botSubscriptionOutcomeFilter, describeOutcomeScope,
} from './bot-subscription-model.js';
import { createBotSubscriptionTable } from './bot-subscription-panel.js';

function node(tag, text, className = '') {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text, testId, ariaLabel) {
  const element = node('button', text, 'wm-button secondary');
  element.type = 'button';
  element.dataset.testid = testId;
  element.setAttribute('aria-label', ariaLabel);
  return element;
}

/**
 * FD Dispatch "Bot delivery paths" section. Selecting a row scopes the dispatch table to that path; the caller
 * receives `{ row, filter }` (both null for "all paths") and reloads outcomes with the filter.
 */
export function createBotSubscriptionSection({
  loadRows = listBotSubscriptions,
  loadClassifications = listBotSubscriptionClassifications,
  checkClassification = readBotSubscriptionClassification,
  onScopeChange = () => {},
} = {}) {
  const section = node('section', '', 'wm-card wm-bot-subs');
  section.dataset.testid = 'bot-subs-section';
  section.setAttribute('aria-labelledby', 'bot-subs-title');
  const title = node('h3', 'Bot delivery paths');
  title.id = 'bot-subs-title';
  const intro = node('p', 'One row per bot and workspace. Delivery shows how work reaches the bot; Tower classification is checked separately because opting into an inbox does not by itself restrict what the bot can read.', 'wm-bot-subs__note');
  const status = node('p', 'Loading delivery paths…', 'wm-bot-subs__status');
  status.dataset.testid = 'bot-subs-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const tableHost = node('div');
  const scope = node('div', '', 'wm-bot-subs__scope');
  scope.dataset.testid = 'bot-subs-scope';
  scope.setAttribute('aria-live', 'polite');
  section.append(title, intro, status, tableHost, scope);

  let rows = [];
  let classifications = [];
  let selected = null; // { row, filter }
  const checkingIds = new Set();

  function setScope(next) {
    selected = next;
    renderTable();
    renderScope();
    onScopeChange(next || { row: null, filter: null });
  }

  function select(row) {
    if (selected?.row?.rowId === row.rowId && selected.filter?.subscriptionId === row.subscriptionId) {
      setScope(null);
      return;
    }
    const filter = botSubscriptionOutcomeFilter(row);
    setScope(filter ? { row, filter } : null);
  }

  async function check(row) {
    if (checkingIds.has(row.subscriptionId)) return;
    checkingIds.add(row.subscriptionId);
    renderTable();
    status.textContent = `Checking Tower classification for ${botSubscriptionBotLabel(row)}…`;
    try {
      const record = await checkClassification(row.subscriptionId);
      classifications = [...classifications.filter((item) => item.subscriptionId !== row.subscriptionId), record];
      status.textContent = record?.state === 'error'
        ? `Tower classification check failed for ${botSubscriptionBotLabel(row)}.`
        : `Tower classification checked for ${botSubscriptionBotLabel(row)}.`;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Tower classification check failed.';
    } finally {
      checkingIds.delete(row.subscriptionId);
      renderTable();
    }
  }

  function renderTable() {
    if (!rows.length) {
      tableHost.replaceChildren();
      return;
    }
    tableHost.replaceChildren(createBotSubscriptionTable(rows, {
      classifications, selectedRowId: selected?.row?.rowId ?? null, onSelect: select, onCheckClassification: check, checkingIds,
    }));
  }

  function renderScope() {
    if (!selected) {
      scope.replaceChildren(node('p', 'Showing dispatch activity for all delivery paths.', 'wm-bot-subs__note'));
      return;
    }
    const { row, filter } = selected;
    const parts = [node('p', `Showing dispatch activity for ${describeOutcomeScope(row, filter)}.`, 'wm-bot-subs__scope-label')];
    const legacy = botSubscriptionLegacyFeed(row, rows);
    if (legacy && filter.subscriptionId === row.subscriptionId) {
      parts.push(node('p', 'Work this bot received before it had its own subscription was recorded on the shared feed and is not repeated here.', 'wm-bot-subs__note'));
      const earlier = button('View earlier shared-feed activity', 'bot-subs-view-legacy', `View ${botSubscriptionBotLabel(row)} activity on the shared feed`);
      earlier.addEventListener('click', () => setScope({ row, filter: { subscriptionId: legacy.subscriptionId, agentId: row.agentId } }));
      parts.push(earlier);
    } else if (row.kind === 'profile' && filter.subscriptionId === row.subscriptionId) {
      parts.push(node('p', 'Only activity recorded on this bot’s own subscription is listed. Earlier activity through a retired shared feed is not shown here.', 'wm-bot-subs__note'));
    } else if (row.kind === 'profile') {
      const back = button('Back to own subscription', 'bot-subs-view-own', `View ${botSubscriptionBotLabel(row)} activity on its own subscription`);
      back.addEventListener('click', () => setScope({ row, filter: botSubscriptionOutcomeFilter(row) }));
      parts.push(back);
    }
    const clear = button('Show all paths', 'bot-subs-clear', 'Show dispatch activity for all delivery paths');
    clear.addEventListener('click', () => setScope(null));
    parts.push(clear);
    scope.replaceChildren(...parts);
  }

  async function refresh() {
    status.dataset.state = 'loading';
    try {
      const [loaded, saved] = await Promise.all([loadRows(), loadClassifications().catch(() => [])]);
      rows = loaded;
      classifications = saved;
      if (selected && !rows.some((row) => row.rowId === selected.row.rowId)) setScope(null);
      status.dataset.state = rows.length ? 'ready' : 'empty';
      const blocked = rows.filter((row) => row.status === 'blocked').length;
      status.textContent = rows.length
        ? `${rows.length} delivery path${rows.length === 1 ? '' : 's'}${blocked ? `, ${blocked} blocked` : ''}.`
        : 'No Flight Deck delivery paths configured.';
    } catch (error) {
      rows = [];
      status.dataset.state = 'error';
      status.textContent = error instanceof Error ? error.message : 'Per-bot delivery status could not be loaded.';
    }
    renderTable();
    renderScope();
  }

  section.refreshBotSubscriptions = refresh;
  renderScope();
  void refresh();
  return section;
}
