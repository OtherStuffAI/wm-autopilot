function recordTiming(name, start, end) {
  performance.clearMeasures?.(name);
  performance.measure?.(name, { start, end });
}

// Request coordination only. Durable rows and mutation revisions live in Dexie.
export function createSessionHistoryLoader({ fetchMessages, store }) {
  const requests = new Map();
  const controllers = new Map();
  function cancel(sessionId) {
    controllers.get(sessionId)?.abort();
    controllers.delete(sessionId);
  }
  function sync(sessionId, { refresh = false } = {}) {
    const key = `${sessionId}:${refresh}`;
    const current = requests.get(key);
    if (current && !current.signal.aborted) return current.promise;
    let controller = controllers.get(sessionId);
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      controllers.set(sessionId, controller);
    }
    const signal = controller.signal;
    const entry = { signal, promise: null };
    const started = performance.now();
    entry.promise = (async () => {
      const expectedRevision = await store.getRevision(sessionId);
      if (signal.aborted) return { stale: true, changed: false };
      const upstreamStart = performance.now();
      const payload = await fetchMessages(sessionId, { refresh, signal, throwOnError: true });
      const received = performance.now();
      if (signal.aborted) return { stale: true, changed: false };
      if (!Array.isArray(payload?.messages)) throw new Error(
        refresh ? "Could not refresh current messages. Saved history is still available." : "Could not load saved session history.",
      );
      const result = await store.syncFromServerIfChanged(sessionId, payload.messages, { expectedRevision, signal });
      recordTiming(`session-history:${sessionId}:${refresh ? "fresh" : "saved"}:http`, upstreamStart, received);
      recordTiming(`session-history:${sessionId}:${refresh ? "fresh" : "saved"}:dexie`, received, performance.now());
      recordTiming(`session-history:${sessionId}:${refresh ? "fresh" : "saved"}:total`, started, performance.now());
      return result;
    })().finally(() => {
      if (requests.get(key) === entry) requests.delete(key);
      if (controllers.get(sessionId) === controller &&
          !requests.has(`${sessionId}:false`) && !requests.has(`${sessionId}:true`)) controllers.delete(sessionId);
    });
    requests.set(key, entry);
    return entry.promise;
  }
  return { sync, cancel };
}

const loaders = new WeakMap();
export function getSessionHistoryLoader(dependencies) {
  let loader = loaders.get(dependencies.store);
  if (!loader) {
    loader = createSessionHistoryLoader(dependencies);
    loaders.set(dependencies.store, loader);
  }
  return loader;
}
