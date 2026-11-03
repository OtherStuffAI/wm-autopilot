import { afterEach, describe, expect, test } from 'bun:test';

import { BOT_SUBSCRIPTION_FIXTURE_ROWS as ROWS } from './fixtures/bot-subscription-rows.js';
import {
  botSubscriptionClassificationLabel, botSubscriptionLegacyFeed, botSubscriptionOutcomeFilter, botSubscriptionStatus,
  botSubscriptionWorkspaceLabel, describeOutcomeScope, scopeOutcomeRows,
} from './bot-subscription-model.js';
import { createBotSubscriptionTable } from './bot-subscription-panel.js';
import { createBotSubscriptionSection } from './bot-subscription-section.js';
import { createFlightDeckDispatchView } from './view.js';
import { listBotSubscriptions, readBotSubscriptionClassification } from '../services/bot-subscriptions.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.textContent = '';
    this.disabled = false;
    this.listeners = new Map();
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { this.listeners.get('click')?.(); }
}

function find(root, testId) {
  if (root?.dataset?.testid === testId) return root;
  for (const child of root?.children ?? []) {
    const found = find(child, testId);
    if (found) return found;
  }
  return null;
}

function allText(root) {
  return [root.textContent, ...(root.children ?? []).map(allText)].join(' ');
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const byId = (id) => ROWS.find((row) => row.rowId === id);
const originalDocument = globalThis.document;

function useFakeDocument() {
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
}

function memoryDb() {
  const table = (key) => {
    const map = new Map();
    return {
      clear: async () => map.clear(),
      bulkPut: async (rows) => rows.forEach((row) => map.set(row[key], row)),
      put: async (row) => map.set(row[key], row),
      get: async (id) => map.get(id),
      toArray: async () => [...map.values()],
    };
  };
  return { rows: table('rowId'), classifications: table('subscriptionId'), transaction: async (_mode, _table, run) => run() };
}

afterEach(() => {
  globalThis.document = originalDocument;
});

describe('bot delivery path model', () => {
  test('labels delivery status without inferring Tower classification', () => {
    expect(botSubscriptionStatus(byId('profile:sub-inbox-a')).label).toBe('Addressed inbox');
    expect(botSubscriptionStatus(byId('served:sub-shared:agent-gamma')).label).toBe('Not migrated');
    expect(botSubscriptionStatus({ status: 'mystery' }).label).toBe('Unknown');
    expect(botSubscriptionClassificationLabel(byId('profile:sub-inbox-a'), null)).toBe('Not checked');
    expect(botSubscriptionClassificationLabel(byId('shared:sub-shared'), null)).toBe('Not applicable (shared feed)');
    expect(botSubscriptionClassificationLabel(byId('profile:sub-inbox-a'), { state: 'unclassified', profile: null, checkedAt: '2026-11-03T04:00:00Z' }))
      .toStartWith('Not classified');
    expect(botSubscriptionClassificationLabel(byId('profile:sub-inbox-a'), { state: 'error', error: 'Tower unavailable' }))
      .toBe('Check failed: Tower unavailable (checked unknown time)');
    expect(botSubscriptionWorkspaceLabel(byId('profile:sub-blocked'))).toBe('Workspace title unavailable');
  });

  test('scopes outcomes to one bot and finds the earlier shared feed', () => {
    expect(botSubscriptionOutcomeFilter(byId('profile:sub-inbox-a'))).toEqual({ subscriptionId: 'sub-inbox-a', agentId: 'agent-alpha' });
    expect(botSubscriptionOutcomeFilter(byId('served:sub-shared:agent-gamma'))).toEqual({ subscriptionId: 'sub-shared', agentId: 'agent-gamma' });
    expect(botSubscriptionOutcomeFilter(byId('shared:sub-shared'))).toEqual({ subscriptionId: 'sub-shared' });
    expect(botSubscriptionLegacyFeed(byId('profile:sub-inbox-a'), ROWS)?.rowId).toBe('shared:sub-shared');
    expect(botSubscriptionLegacyFeed(byId('profile:sub-blocked'), ROWS)).toBeNull();
    const outcomes = [
      { id: 1, subscriptionId: 'sub-inbox-a', agentId: 'agent-alpha' },
      { id: 2, subscriptionId: 'sub-inbox-a', agentId: 'agent-beta' },
      { id: 3, subscriptionId: 'sub-shared', agentId: 'agent-alpha' },
      { id: 4, subscriptionId: 'sub-shared', agentId: 'agent-gamma' },
    ];
    expect(scopeOutcomeRows(outcomes, { subscriptionId: 'sub-inbox-a', agentId: 'agent-alpha' }).map((row) => row.id)).toEqual([1]);
    expect(scopeOutcomeRows(outcomes, { subscriptionId: 'sub-shared' }).map((row) => row.id)).toEqual([3, 4]);
    expect(scopeOutcomeRows(outcomes, null)).toHaveLength(4);
    expect(describeOutcomeScope(byId('profile:sub-inbox-a'), { subscriptionId: 'sub-shared', agentId: 'agent-alpha' }))
      .toBe('Example Bot via shared feed in Example Workspace');
  });
});

describe('bot delivery path table', () => {
  test('renders one row per path with exact identities and explicit, profile-only classification checks', () => {
    useFakeDocument();
    const checked = [];
    const table = createBotSubscriptionTable(ROWS, { onSelect: () => {}, onCheckClassification: (row) => checked.push(row.rowId) });
    for (const row of ROWS) expect(find(table, `bot-subs-row-${row.rowId}`)).not.toBeNull();
    const first = find(table, 'bot-subs-row-profile:sub-inbox-a');
    const second = find(table, 'bot-subs-row-profile:sub-inbox-b');
    // Duplicate display names are disambiguated by full public identity.
    expect(allText(first)).toContain(ROWS[0].botNpub);
    expect(allText(second)).toContain(ROWS[1].botNpub);
    expect(allText(first)).toContain('Initial floor');
    expect(allText(find(table, 'bot-subs-row-profile:sub-blocked'))).toContain('Workspace title unavailable');
    expect(find(table, 'bot-subs-check-shared:sub-shared')).toBeNull();
    expect(find(table, 'bot-subs-check-served:sub-shared:agent-gamma')).toBeNull();
    find(table, 'bot-subs-check-profile:sub-inbox-a').click();
    expect(checked).toEqual(['profile:sub-inbox-a']);
    expect(find(table, 'bot-subs-classification-profile:sub-inbox-a').textContent).toBe('Not checked');
  });

  test('omits the activity column for read-only embeds', () => {
    useFakeDocument();
    const table = createBotSubscriptionTable(ROWS.slice(0, 1));
    expect(find(table, 'bot-subs-select-profile:sub-inbox-a')).toBeNull();
    expect(find(table, 'bot-subs-check-profile:sub-inbox-a')).toBeNull();
  });
});

describe('FD Dispatch per-bot scoping', () => {
  test('selecting a bot reloads agent-scoped outcomes and withholds other bots', async () => {
    useFakeDocument();
    const calls = [];
    const view = createFlightDeckDispatchView({
      loadPage: async (input) => {
        calls.push(input);
        // Simulates an older backend that ignores the filter parameters.
        return { rows: [
          { id: 'o1', subscriptionId: 'sub-inbox-a', agentId: 'agent-alpha', outcome: 'launched' },
          { id: 'o2', subscriptionId: 'sub-inbox-b', agentId: 'agent-beta', outcome: 'launched' },
          { id: 'o3', subscriptionId: 'sub-shared', agentId: 'agent-alpha', outcome: 'launched' },
        ], total: 3 };
      },
      createDeliveryPaths: (options) => createBotSubscriptionSection({ ...options, loadRows: async () => ROWS, loadClassifications: async () => [] }),
    });
    await tick();
    find(view, 'bot-subs-select-profile:sub-inbox-a').click();
    await tick();
    expect(calls.at(-1)).toEqual({ limit: 25, offset: 0, includeIgnoredAndSuppressed: false, subscriptionId: 'sub-inbox-a', agentId: 'agent-alpha' });
    const table = find(view, 'flightdeck-dispatch-table');
    const body = table.children.find((child) => child.tagName === 'tbody');
    expect(body.children).toHaveLength(1);
    expect(allText(view)).toContain('2 outcomes for other bots withheld.');
    expect(allText(find(view, 'bot-subs-scope'))).toContain('recorded on the shared feed');

    find(view, 'bot-subs-view-legacy').click();
    await tick();
    expect(calls.at(-1)).toMatchObject({ subscriptionId: 'sub-shared', agentId: 'agent-alpha' });

    find(view, 'bot-subs-clear').click();
    await tick();
    expect(calls.at(-1)).toEqual({ limit: 25, offset: 0, includeIgnoredAndSuppressed: false });
  });

  test('discards a slow response from the previous scope and clears rows on selection', async () => {
    useFakeDocument();
    const pending = [];
    const view = createFlightDeckDispatchView({
      loadPage: (input) => new Promise((resolve) => pending.push({ input, resolve })),
      createDeliveryPaths: (options) => createBotSubscriptionSection({ ...options, loadRows: async () => ROWS, loadClassifications: async () => [] }),
    });
    await tick();
    const content = find(view, 'flightdeck-dispatch-panel').children[1];
    find(view, 'bot-subs-select-profile:sub-inbox-b').click();
    expect(content.children).toHaveLength(1);
    find(view, 'bot-subs-select-profile:sub-inbox-a').click();
    expect(pending.map((call) => call.input.agentId ?? null)).toEqual([null, 'agent-beta', 'agent-alpha']);
    // Newest scope answers first; the older bot-beta response then arrives late and must be ignored.
    pending[2].resolve({ rows: [{ id: 'a1', subscriptionId: 'sub-inbox-a', agentId: 'agent-alpha', outcome: 'launched', actionId: 'alpha-run' }], total: 1 });
    await tick();
    pending[1].resolve({ rows: [{ id: 'b1', subscriptionId: 'sub-inbox-b', agentId: 'agent-beta', outcome: 'launched', actionId: 'beta-run' }], total: 1 });
    pending[0].resolve({ rows: [{ id: 'b2', subscriptionId: 'sub-inbox-b', agentId: 'agent-beta', outcome: 'launched' }], total: 1 });
    await tick();
    const body = find(view, 'flightdeck-dispatch-table').children.find((child) => child.tagName === 'tbody');
    expect(body.children).toHaveLength(1);
    expect(allText(view)).not.toContain('beta-run');
    expect(find(view, 'flightdeck-dispatch-refresh').disabled).toBe(false);
  });

  test('keeps dispatch outcomes available when per-bot status is unavailable', async () => {
    useFakeDocument();
    const view = createFlightDeckDispatchView({
      loadPage: async () => ({ rows: [], total: 0 }),
      createDeliveryPaths: (options) => createBotSubscriptionSection({
        ...options, loadRows: async () => { throw new Error('Per-bot delivery status is not available on this Autopilot build yet.'); },
        loadClassifications: async () => [],
      }),
    });
    await tick();
    const status = find(view, 'bot-subs-status');
    expect(status.dataset.state).toBe('error');
    expect(status.attributes['aria-live']).toBe('polite');
    expect(status.textContent).toContain('not available');
    expect(find(view, 'flightdeck-dispatch-panel')).not.toBeNull();
  });

  test('records explicit classification checks and announces the result', async () => {
    useFakeDocument();
    const section = createBotSubscriptionSection({
      loadRows: async () => ROWS,
      loadClassifications: async () => [],
      checkClassification: async (subscriptionId) => ({ subscriptionId, state: 'classified', profile: 'notification_only', checkedAt: '2026-11-03T04:00:00Z' }),
    });
    await tick();
    find(section, 'bot-subs-check-profile:sub-inbox-a').click();
    await tick();
    expect(find(section, 'bot-subs-classification-profile:sub-inbox-a').textContent).toStartWith('Notification-only');
    expect(find(section, 'bot-subs-classification-profile:sub-inbox-b').textContent).toBe('Not checked');
    expect(find(section, 'bot-subs-status').textContent).toBe('Tower classification checked for Example Bot.');
  });
});

describe('bot delivery path service', () => {
  test('writes rows to the local store and treats a missing route as unavailable', async () => {
    const db = memoryDb();
    await db.rows.put({ rowId: 'stale' });
    const rows = await listBotSubscriptions({ db, fetchImpl: async () => Response.json({ rows: ROWS.slice(0, 2) }) });
    expect(rows.map((row) => row.rowId)).toEqual(['profile:sub-inbox-a', 'profile:sub-inbox-b']);
    await expect(listBotSubscriptions({ db, fetchImpl: async () => new Response('', { status: 404 }) }))
      .rejects.toThrow('not available on this Autopilot build');
  });

  test('stores classification errors honestly instead of assuming restriction', async () => {
    const db = memoryDb();
    const failed = await readBotSubscriptionClassification('sub-inbox-a', {
      db, fetchImpl: async () => Response.json({ error: 'No active key exists for this bot identity.' }, { status: 409 }),
    });
    expect(failed).toMatchObject({ state: 'error', error: 'No active key exists for this bot identity.' });
    const ok = await readBotSubscriptionClassification('sub-inbox-a', {
      db, fetchImpl: async (url) => {
        expect(url).toBe('/api/agent-chat/subscriptions/sub-inbox-a/agent-inbox/classification');
        return Response.json({ subscriptionId: 'sub-inbox-a', classified: false, profile: null, checkedAt: '2026-11-03T04:00:00Z' });
      },
    });
    expect(ok).toMatchObject({ state: 'unclassified', profile: null });
    const ambiguous = await readBotSubscriptionClassification('sub-inbox-a', {
      db, fetchImpl: async () => Response.json({ subscriptionId: 'sub-inbox-a', profile: null }),
    });
    expect(ambiguous).toMatchObject({ state: 'error', error: 'Tower returned no classification answer.' });
  });

  test('labels restored classification as a saved check with its time', () => {
    const label = botSubscriptionClassificationLabel(byId('profile:sub-inbox-a'),
      { state: 'classified', profile: 'notification_only', checkedAt: '2026-11-03T04:00:00Z', cached: true });
    expect(label).toStartWith('Notification-only (saved check from ');
    expect(botSubscriptionClassificationLabel(byId('profile:sub-inbox-a'), { state: 'classified', checkedAt: null, cached: true }))
      .toContain('unknown time');
  });
});
