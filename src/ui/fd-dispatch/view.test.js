import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  FLIGHT_DECK_DISPATCH_PAGE_SIZE,
  createDispatchTable,
  createFlightDeckDispatchView,
  flightDeckDispatchActionHref,
  formatFlightDeckDispatchReason,
  formatFlightDeckDispatchSource,
  formatFlightDeckDispatchSourceDisplay,
  formatFlightDeckDispatchTime,
} from './view.js';
import {
  DEFAULT_HOME_TAB_ID,
  HOME_TABS,
  createHomeTabContent,
} from '../views/home-view.js';

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const authSource = readFileSync(new URL('../core/auth-route-guard.js', import.meta.url), 'utf8');
const homeSource = readFileSync(new URL('../views/home-view.js', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const navigationSource = readFileSync(new URL('../navigation/navigation.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const viewSource = readFileSync(new URL('./view.js', import.meta.url), 'utf8');

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

function findByTestId(root, testId) {
  if (root.dataset?.testid === testId) return root;
  for (const child of root.children ?? []) {
    const found = findByTestId(child, testId);
    if (found) return found;
  }
  return null;
}

function findByTag(root, tagName) {
  if (root.tagName === tagName) return root;
  for (const child of root.children ?? []) {
    const found = findByTag(child, tagName);
    if (found) return found;
  }
  return null;
}

const originalDocument = globalThis.document;

afterEach(() => {
  globalThis.document = originalDocument;
});

describe('FD Dispatch Home tab placement', () => {
  test('appends the exact internal tab after Archive and keeps Sessions as default', () => {
    expect(HOME_TABS).toEqual([
      { id: 'sessions', label: 'Sessions' },
      { id: 'pipelines', label: 'Pipelines' },
      { id: 'apps', label: 'Apps' },
      { id: 'archive', label: 'Archive' },
      { id: 'fd-dispatch', label: 'FD Dispatch' },
    ]);
    expect(DEFAULT_HOME_TAB_ID).toBe('sessions');
  });

  test('has no global menu, navigation, auth-route, or standalone render owner', () => {
    expect(htmlSource).not.toContain('data-route="fd-dispatch"');
    expect(navigationSource).not.toContain('navigateToFlightDeckDispatch');
    expect(appSource).not.toContain('renderFlightDeckDispatch');
    expect(authSource).not.toContain('"fd-dispatch"');
    expect(homeSource).not.toContain('history.pushState({ route: "fd-dispatch"');
  });

  test('selects exactly one content owner for Sessions or FD Dispatch', async () => {
    globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
    let sessionsCreated = 0;
    let dispatchCreated = 0;
    const factories = {
      sessions: () => {
        sessionsCreated += 1;
        return new FakeElement('sessions');
      },
      'fd-dispatch': () => {
        dispatchCreated += 1;
        return createFlightDeckDispatchView({ loadPage: async () => ({ rows: [], total: 0 }) });
      },
    };

    const sessions = createHomeTabContent(DEFAULT_HOME_TAB_ID, factories);
    expect(sessions.tagName).toBe('sessions');
    expect(sessionsCreated).toBe(1);
    expect(dispatchCreated).toBe(0);

    const dispatch = createHomeTabContent('fd-dispatch', factories);
    expect(findByTestId(dispatch, 'flightdeck-dispatch-view')).toBe(dispatch);
    expect(sessionsCreated).toBe(1);
    expect(dispatchCreated).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('FD Dispatch view', () => {
  test('links only durable launched actions', () => {
    expect(flightDeckDispatchActionHref({ action: 'session', actionId: 'session/1' })).toBe('/live/session%2F1');
    expect(flightDeckDispatchActionHref({ action: 'pipeline', actionId: 'run 1' })).toBe('/pipelines/runs/run%201');
    expect(flightDeckDispatchActionHref({ action: null, actionId: null })).toBeNull();
  });

  test('uses 25-row server-backed pages and handles invalid dates', () => {
    expect(FLIGHT_DECK_DISPATCH_PAGE_SIZE).toBe(25);
    expect(formatFlightDeckDispatchTime('invalid')).toBe('—');
    expect(viewSource).toContain('includeIgnoredAndSuppressed: includeFiltered.checked');
  });

  test('preserves data, fallbacks, badges, links, and readable source labels', () => {
    globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
    const rawSource = '@[Example Agent](mention:agent:npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg) Review the full-width layout';
    const wrapper = createDispatchTable([
      {
        receivedAt: '2026-07-28T02:00:00.000Z', workspaceName: 'Example Operator', sourceLabel: rawSource,
        agentId: 'exampleAgent', trigger: 'chat', outcome: 'suppressed', reasonLabel: 'Recent duplicate', action: null, actionId: null,
      },
      {
        receivedAt: '2026-07-28T02:01:00.000Z', workspaceName: 'Example Operator', agentId: 'dispatch-pipeline', trigger: 'doc', outcome: 'launched',
        action: 'pipeline', actionId: 'run 1',
      },
      {
        receivedAt: '2026-07-28T02:02:00.000Z', workspaceName: 'Example Operator', agentId: 'exampleAgent', trigger: 'chat', outcome: 'queued',
        reasonLabel: 'Waiting for durable session', action: null, actionId: null,
      },
    ]);
    const table = findByTag(wrapper, 'table');
    const body = table.children.find((child) => child.tagName === 'tbody');
    const firstRow = body.children[0].children;
    const secondRow = body.children[1].children;
    const queuedRow = body.children[2].children;

    expect(firstRow[0].textContent).toBe('—');
    expect(firstRow[3].textContent).toBe('exampleAgent');
    expect(firstRow[3].title).toBe('exampleAgent');
    expect(firstRow[4].children[0].textContent).toBe('Example Agent Review the full-width layout');
    expect(firstRow[4].children[0].title).toBe(rawSource);
    expect(firstRow[6].children[0].textContent).toBe('suppressed');
    expect(firstRow[7].children[0].textContent).toBe('Recent duplicate');
    expect(secondRow[0].children[0].href).toBe('/pipelines/runs/run%201');
    expect(secondRow[4].children[0].textContent).toBe('Source label not recorded');
    expect(secondRow[6].children[0].textContent).toBe('launched');
    expect(secondRow[8].children[0].textContent).toBe('pipeline');
    expect(queuedRow[0].textContent).toBe('—');
    expect(queuedRow[6].children[0].textContent).toBe('queued');
    expect(queuedRow[7].children[0].textContent).toBe('Waiting for durable session');
    expect(queuedRow[8].textContent).toBe('—');
    expect(formatFlightDeckDispatchReason({ outcome: 'suppressed' })).toBe('Reason not recorded');
    expect(formatFlightDeckDispatchReason({ outcome: 'failed' })).toBe('—');
    expect(formatFlightDeckDispatchSource({})).toBe('Source label not recorded');
    expect(formatFlightDeckDispatchSourceDisplay({ sourceLabel: rawSource })).toBe('Example Agent Review the full-width layout');
  });

  test('keeps pagination server-side and refreshes the current page', async () => {
    globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
    const calls = [];
    const view = createFlightDeckDispatchView({
      loadPage: async ({ limit, offset }) => {
        calls.push({ limit, offset });
        return {
          rows: Array.from({ length: offset === 0 ? 25 : 5 }, (_, index) => ({
            receivedAt: '2026-07-28T02:00:00.000Z', workspaceName: 'Example Operator', sourceLabel: `Row ${offset + index + 1}`,
            trigger: 'task', outcome: 'launched', action: 'pipeline', actionId: `run-${offset + index + 1}`,
          })),
          total: 30,
        };
      },
    });
    expect(findByTestId(view, 'flightdeck-dispatch-view')).toBe(view);
    await new Promise((resolve) => setTimeout(resolve, 0));
    findByTestId(view, 'flightdeck-dispatch-next').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    findByTestId(view, 'flightdeck-dispatch-refresh').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([
      { limit: 25, offset: 0 },
      { limit: 25, offset: 25 },
      { limit: 25, offset: 25 },
    ]);
    expect(findByTestId(view, 'flightdeck-dispatch-page').textContent).toBe('Page 2 of 2');
  });

  test('hides ignored and suppressed outcomes by default and reloads from page one when enabled', async () => {
    globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
    const calls = [];
    const view = createFlightDeckDispatchView({
      loadPage: async (input) => {
        calls.push(input);
        return { rows: [], total: 0 };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const filter = findByTestId(view, 'flightdeck-dispatch-include-filtered');
    expect(filter.checked).toBeFalsy();
    filter.checked = true;
    filter.listeners.get('change')();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([
      { limit: 25, offset: 0, includeIgnoredAndSuppressed: false },
      { limit: 25, offset: 0, includeIgnoredAndSuppressed: true },
    ]);
  });

  test('renders loading, empty, and error states accessibly', async () => {
    globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
    const emptyView = createFlightDeckDispatchView({ loadPage: async () => ({ rows: [], total: 0 }) });
    const loadingStatus = findByTestId(emptyView, 'flightdeck-dispatch-panel').children[1].children[0];
    expect(loadingStatus.textContent).toBe('Loading dispatch outcomes…');
    expect(loadingStatus.attributes['aria-live']).toBe('polite');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadingStatus.dataset.state).toBe('empty');
    expect(loadingStatus.textContent).toBe('No Flight Deck dispatch outcomes recorded yet.');

    const errorView = createFlightDeckDispatchView({ loadPage: async () => { throw new Error('Dispatch unavailable'); } });
    const errorStatus = findByTestId(errorView, 'flightdeck-dispatch-panel').children[1].children[0];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errorStatus.dataset.state).toBe('error');
    expect(errorStatus.textContent).toBe('Dispatch unavailable');
  });

  test('uses shared responsive table hooks and keyboard focus treatment', () => {
    expect(styles).toContain('.wm-flightdeck-dispatch__table-wrap {');
    expect(styles).toContain('overflow-x: auto;');
    expect(styles).toContain('table-layout: fixed;');
    expect(styles).toContain('min-width: 1680px;');
    expect(styles).toContain('.wm-flightdeck-dispatch__col--agent { width: 15rem; }');
    expect(styles).toContain('.wm-flightdeck-dispatch__clamped-value {');
    expect(styles).toContain('-webkit-line-clamp: 2;');
    expect(styles).toContain('.wm-flightdeck-dispatch__table-wrap:focus-visible');
    expect(styles).toContain('.wm-flightdeck-dispatch__target a:focus-visible');
  });
});
