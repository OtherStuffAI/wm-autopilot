export function nstackConnectionKey(connection) {
  const endpoint = new URL(connection.directHttpsUrl).href.replace(/\/+$/, '');
  return JSON.stringify([endpoint, connection.serviceNpub, connection.workspaceId, connection.workspaceServiceNpub]);
}

// This controller owns discovery/network commands; all rendered state is materialized in Dexie.
export function createNStackConnectController({ id, table, host = globalThis, setup }) {
  let generation = 0;
  let unsubscribe;
  let pending = Promise.resolve();
  const empty = { id, open: false, stage: 'select', choices: [], selected: [], results: [], busy: false, message: '' };
  function write(patch, expected = generation) {
    pending = pending.catch(() => {}).then(async () => {
      if (expected !== generation) return;
      const state = await table.get(id) || empty;
      if (expected === generation) await table.put({ ...state, ...patch, id, syncedAt: Date.now() });
    });
    return pending;
  }
  async function state() { await pending; return await table.get(id) || empty; }
  function invalidated() {
    generation++;
    unsubscribe?.(); unsubscribe = null;
    return write({ ...empty, open: true, message: 'Browser identity or discovery changed. Choose the connection again.' });
  }
  async function discover() {
    const current = ++generation;
    unsubscribe?.(); unsubscribe = null;
    await write({ ...empty, open: true, busy: true, message: 'Waiting for Nostr Browser discovery…' }, current);
    try {
      const provider = host.NStack;
      if (!provider) throw new Error('Open this Autopilot in Nostr Browser to use saved NStacks. Manual and AgentConnect setup remain available.');
      // The document-start stub resolves when the native provider is installed.
      await (host.NStackReady || provider.ready);
      if (current !== generation) return;
      const api = host.NStack;
      if (typeof api.getConnection !== 'function') throw new Error('Update Nostr Browser: workspace connection discovery is unavailable.');
      await api.requestDiscovery({ workspaces: true });
      if (current !== generation) return;
      unsubscribe = api.on('change', invalidated);
      if (current !== generation) return;
      const stacks = await api.listNStacks();
      const choices = [];
      const failures = [];
      for (const stack of stacks) {
        try {
          const workspaces = await api.listWorkspaces({ stackId: stack.id });
          for (const workspace of workspaces) choices.push({ key: `${stack.id}/${workspace.id}`, stackId: stack.id,
            workspaceAlias: workspace.id, name: workspace.name, stackName: stack.name });
        } catch (error) { failures.push(`${stack.name}: ${error.message}`); }
      }
      await write({ choices, busy: false, message: failures.join('; ') || (choices.length ? 'Select the workspaces this Autopilot should monitor.' : 'No workspaces disclosed. Check browser identity and saved workspaces.') }, current);
    } catch (error) {
      await write({ busy: false, message: error.code === 'consent_denied' ? 'Discovery cancelled. No connections changed.' : error.message }, current);
    }
  }
  async function select(key, checked) {
    const value = await state();
    const selected = new Set(value.selected);
    if (checked) selected.add(key); else selected.delete(key);
    await write({ selected: [...selected] });
  }
  async function review() {
    const current = generation;
    const value = await state();
    if (value.busy || !value.selected.length) return;
    await write({ busy: true, message: 'Reading selected connection details…' }, current);
    try {
      const choices = [];
      for (const choice of value.choices) {
        if (!value.selected.includes(choice.key)) { choices.push(choice); continue; }
        const raw = await host.NStack.getConnection({ stackId: choice.stackId, workspaceId: choice.workspaceAlias });
        // Whitelist public metadata. Never persist provider handles, signatures or secrets.
        const connection = Object.fromEntries(['name', 'workspaceId', 'workspaceOwnerNpub', 'workspaceServiceNpub', 'directHttpsUrl', 'serviceNpub'].map((key) => [key, raw[key]]));
        choices.push({ ...choice, connection });
      }
      await write({ choices, stage: 'review', busy: false, message: 'Autopilot will verify local agent access with Tower, save matching connections and monitor workspace events. Several local agents share a connection; connecting does not create agents.' }, current);
    } catch (error) { await write({ busy: false, message: error.message }, current); }
  }
  async function connect(retry = false) {
    const current = generation;
    const value = await state();
    if (value.busy) return;
    const failed = new Set(value.results.filter((row) => ['failed', 'needs_attention'].includes(row.status)).map((row) => row.key));
    const choices = value.choices.filter((row) => value.selected.includes(row.key) && (!retry || failed.has(row.connection && nstackConnectionKey(row.connection))));
    if (!choices.length || choices.some((row) => !row.connection)) return;
    await write({ busy: true, message: 'Verifying access and setting up monitoring…' }, current);
    try {
      const result = await setup(choices.map((row) => row.connection));
      const retained = retry ? value.results.filter((row) => !failed.has(row.key)) : [];
      await write({ stage: 'results', results: [...retained, ...result.results], busy: false, message: 'Setup finished. Monitoring health is separate from running agents.' }, current);
    } catch (error) { await write({ busy: false, message: error.message }, current); }
  }
  async function close() {
    const value = await state();
    generation++;
    unsubscribe?.(); unsubscribe = null;
    await write({ ...empty, message: value.busy ? 'Cancelled locally. Setup already accepted by Autopilot may finish; check workspace health.' : '' });
  }
  async function providerReady() {
    const value = await state();
    if (value.open && value.stage === 'select' && !value.busy && !value.choices.length) void discover();
  }
  host.addEventListener?.('nstackready', providerReady);
  return { discover, select, review, connect, close,
    back: () => write({ stage: 'select', message: 'Select workspaces to monitor.' }),
    destroy: async () => { generation++; unsubscribe?.(); host.removeEventListener?.('nstackready', providerReady); await pending; await table.delete(id); },
  };
}
