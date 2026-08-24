import { sortSessionsForTabs } from "./session-order.js";

function mergeSessionIntoStore(store, session) {
  if (!session?.id || !Array.isArray(store?.items)) {
    return;
  }

  const existingIndex = store.items.findIndex((item) => item?.id === session.id);
  const nextItems = existingIndex >= 0
    ? store.items.map((item, index) => (index === existingIndex ? { ...item, ...session } : item))
    : [...store.items, session];
  store.items = sortSessionsForTabs(nextItems);
}

export function createSessionActions({
  getStore,
  apiSessionStore,
  stopSessionApi,
  deleteSessionApi,
  updateSessionNameApi,
  resumeNativeSessionApi,
  forkSessionToWorktreeApi,
}) {
  async function stopSession(sessionId) {
    const result = await stopSessionApi(sessionId);
    if (result.success) {
      await getStore().sync();
    }
    return result;
  }

  async function deleteSession(sessionId) {
    const result = await deleteSessionApi(sessionId);
    if (result.success) {
      await apiSessionStore.remove(sessionId);
      await getStore().sync();
    }
    return result;
  }

  async function renameSession(sessionId, name, position) {
    const result = await updateSessionNameApi(sessionId, name, position);
    const store = getStore();
    if (result?.id) {
      if (typeof apiSessionStore.patchSession === "function") {
        await apiSessionStore.patchSession(result.id, result);
      }
      mergeSessionIntoStore(store, result);
    }
    void store.sync();
    return result;
  }

  async function resumeNativeSession(sessionId) {
    const result = await resumeNativeSessionApi(sessionId);
    await getStore().sync();
    return result;
  }

  async function forkToWorktree(sessionId, branch, messageCount = 5) {
    const result = await forkSessionToWorktreeApi(sessionId, branch, messageCount);
    await getStore().sync();
    return result;
  }

  return {
    stopSession,
    deleteSession,
    renameSession,
    resumeNativeSession,
    forkToWorktree,
  };
}
