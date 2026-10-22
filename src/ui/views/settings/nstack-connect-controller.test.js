import { expect, test } from 'bun:test';
import { createNStackConnectController, nstackConnectionKey } from './nstack-connect-controller.js';
function fixture() {
  let value; let listener; let submitted = [];
  const table = { get: async () => structuredClone(value), put: async (row) => { value = structuredClone(row); }, delete: async () => { value = undefined; } };
  const api = { requestDiscovery: async () => {}, listNStacks: async () => [{ id: 's', name: 'Saved' }],
    listWorkspaces: async () => ['a', 'b'].map((id) => ({ id, name: id })),
    getConnection: async ({ workspaceId }) => ({ name: workspaceId, workspaceId, workspaceOwnerNpub: 'owner', workspaceServiceNpub: 'ws', directHttpsUrl: 'https://tower.example', serviceNpub: 'tower', token: 'never-store' }),
    on: (_event, callback) => { listener = callback; return () => { listener = null; }; } };
  const host = { NStack: api };
  const controller = createNStackConnectController({ id: 'flow', table, host, setup: async (connections) => {
    submitted.push(connections);
    return { results: connections.map((row) => ({ key: nstackConnectionKey(row), workspaceId: row.workspaceId, status: row.workspaceId === 'b' && submitted.length === 1 ? 'failed' : 'monitoring' })) };
  } });
  return { api, host, controller, state: () => value, submitted, change: () => listener?.({ reason: 'identity_changed' }) };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test('selects, reviews, persists only public metadata and retries failed workspaces', async () => {
  const f = fixture(); await f.controller.discover();
  await f.controller.select('s/a', true); await f.controller.select('s/b', true);
  await f.controller.review();
  expect(f.state().stage).toBe('review'); expect(JSON.stringify(f.state())).not.toContain('never-store');
  await f.controller.connect(); expect(f.state().stage).toBe('results');
  await f.controller.connect(true);
  expect(f.submitted.map((rows) => rows.map((row) => row.workspaceId))).toEqual([['a', 'b'], ['b']]);
  expect(f.state().results.map((row) => row.status)).toEqual(['monitoring', 'monitoring']);
});
test('late provider readiness and cancelled native selection cannot reopen the flow', async () => {
  const f = fixture(); let ready; f.host.NStackReady = new Promise((resolve) => { ready = resolve; });
  const discovery = f.controller.discover(); await tick();
  expect(f.state().busy).toBe(true);
  await f.controller.close(); ready(); await discovery;
  expect(f.state().open).toBe(false); expect(f.state().choices).toEqual([]);
  await f.controller.discover(); expect(f.state().choices).toHaveLength(2);
});
test('identity changes invalidate review and discard late connection responses', async () => {
  const f = fixture(); await f.controller.discover(); await f.controller.select('s/a', true);
  let finish; f.api.getConnection = () => new Promise((resolve) => { finish = resolve; });
  const review = f.controller.review(); await tick(); f.change(); await tick();
  finish({ workspaceId: 'old' }); await review;
  expect(f.state().selected).toEqual([]); expect(f.state().stage).toBe('select');
  await f.controller.connect(); expect(f.submitted).toEqual([]);
});
test('missing provider, declined discovery and no selection never submit setup', async () => {
  const f = fixture(); delete f.host.NStack;
  await f.controller.discover(); expect(f.state().message).toContain('Nostr Browser');
  f.host.NStack = f.api;
  f.api.requestDiscovery = async () => { throw Object.assign(new Error('denied'), { code: 'consent_denied' }); };
  await f.controller.discover(); expect(f.state().message).toContain('cancelled');
  await f.controller.review(); await f.controller.connect(); expect(f.submitted).toEqual([]);
});
test('retry distinguishes the same workspace ID on two NStacks', async () => {
  const f = fixture();
  f.api.listNStacks = async () => [{ id: 's1', name: 'One' }, { id: 's2', name: 'Two' }];
  f.api.listWorkspaces = async () => [{ id: 'same', name: 'Same ID' }];
  f.api.getConnection = async ({ stackId }) => ({ name: 'Same ID', workspaceId: 'same', workspaceOwnerNpub: 'owner', workspaceServiceNpub: 'ws', serviceNpub: 'tower', directHttpsUrl: `https://${stackId}.example` });
  await f.controller.discover();
  await f.controller.select('s1/same', true); await f.controller.select('s2/same', true); await f.controller.review();
  // Materialize a partial result as a previous successful command would.
  const state = f.state();
  state.results = state.choices.map((row, index) => ({ key: nstackConnectionKey(row.connection), workspaceId: 'same', status: index ? 'failed' : 'monitoring' }));
  state.stage = 'results';
  // Fixture returns its stored object here, matching an already persisted snapshot.
  await f.controller.connect(true);
  expect(f.submitted[0].map((row) => row.directHttpsUrl)).toEqual(['https://s2.example']);
  expect(f.state().results).toHaveLength(2);
});
test('provider discovery change notification does not cancel its own consent request', async () => {
  const f = fixture();
  f.api.requestDiscovery = async () => { f.change(); };
  await f.controller.discover();
  expect(f.state().choices).toHaveLength(2);
});
test('late native setup response after cancellation cannot reopen results', async () => {
  let value; let finish;
  const table = { get: async () => value, put: async (row) => { value = row; }, delete: async () => {} };
  const f = fixture();
  const controller = createNStackConnectController({ id: 'late', table, host: f.host, setup: () => new Promise((resolve) => { finish = resolve; }) });
  await controller.discover(); await controller.select('s/a', true); await controller.review();
  const setup = controller.connect(); await tick(); await controller.close();
  finish({ results: [] }); await setup;
  expect(value.open).toBe(false); expect(value.results).toEqual([]);
});
