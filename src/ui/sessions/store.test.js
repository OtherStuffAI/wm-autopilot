import { beforeEach, describe, expect, mock, test } from "bun:test";

let registeredStore = null;
let liveQueryObservers = [];

const getAllMock = mock(async () => []);
const upsertManyMock = mock(async () => {});
const clearMock = mock(async () => {});
const attentionGetAllMock = mock(async () => []);
const attentionReconcileMock = mock(async () => []);
const attentionMarkViewedMock = mock(async () => null);
const fetchSessionsApiMock = mock(async () => ({
  sessions: [],
  identities: [],
  filters: { npubs: [] },
}));

mock.module("/vendor/alpinejs/module.esm.js", () => ({
  default: {
    store(name, value) {
      if (name !== "sessions") {
        throw new Error(`Unexpected store registration: ${name}`);
      }
      registeredStore = value;
    },
  },
}));

mock.module("../live/db.js", () => ({
  Dexie: {
    liveQuery(callback) {
      return {
        subscribe(observer) {
          liveQueryObservers.push(observer);
          void callback();
          return { unsubscribe() {} };
        },
      };
    },
  },
  ApiSessionStore: {
    getAll: getAllMock,
    upsertMany: upsertManyMock,
    clear: clearMock,
  },
  SessionAttentionStore: {
    getAll: attentionGetAllMock,
    reconcile: attentionReconcileMock,
    markViewed: attentionMarkViewedMock,
  },
}));

mock.module("../services/sessions.js", () => ({
  fetchSessionsApi: fetchSessionsApiMock,
}));

const { initSessionsStore } = await import("./store.js");

describe("sessions store", () => {
  beforeEach(() => {
    registeredStore = null;
    liveQueryObservers = [];
    getAllMock.mockClear();
    upsertManyMock.mockClear();
    clearMock.mockClear();
    attentionGetAllMock.mockClear();
    attentionReconcileMock.mockClear();
    attentionMarkViewedMock.mockClear();
    fetchSessionsApiMock.mockClear();
    getAllMock.mockResolvedValue([]);
    fetchSessionsApiMock.mockResolvedValue({
      sessions: [],
      identities: [],
      filters: { npubs: [] },
    });
  });

  test("notifies render subscribers when liveQuery updates items", async () => {
    const onItemsChanged = mock(() => {});
    initSessionsStore({
      showToast: mock(() => {}),
      getIdentity: () => ({ npub: "npub1viewer" }),
      onItemsChanged,
      syncOnInit: false,
    });

    await registeredStore.init();
    liveQueryObservers[0]?.next([{ id: "session-1", startedAt: "2026-06-13T01:00:00.000Z" }]);

    expect(onItemsChanged).toHaveBeenCalledWith([
      { id: "session-1", startedAt: "2026-06-13T01:00:00.000Z" },
    ]);
  });

  test("notifies only after the initial server completion baseline", async () => {
    const onSessionCompleted = mock(() => {});
    fetchSessionsApiMock
      .mockResolvedValueOnce({
        sessions: [{ id: "session-1", agentRuntimeStatus: "running" }],
        identities: [],
        filters: { npubs: [] },
      })
      .mockResolvedValueOnce({
        sessions: [{ id: "session-1", agentRuntimeStatus: "stable" }],
        identities: [],
        filters: { npubs: [] },
      });
    attentionReconcileMock
      .mockResolvedValueOnce(["session-1"])
      .mockResolvedValueOnce(["session-1"]);

    initSessionsStore({
      showToast: mock(() => {}),
      getIdentity: () => ({ npub: "npub1viewer" }),
      onSessionCompleted,
      syncOnInit: false,
    });

    await registeredStore.sync();
    expect(onSessionCompleted).not.toHaveBeenCalled();
    await registeredStore.sync();
    expect(onSessionCompleted).toHaveBeenCalledTimes(1);
  });

  test("notifies render subscribers after explicit API sync", async () => {
    const onItemsChanged = mock(() => {});
    fetchSessionsApiMock.mockResolvedValueOnce({
      sessions: [{ id: "session-2", startedAt: "2026-06-13T02:00:00.000Z" }],
      identities: [],
      filters: { npubs: [] },
    });

    initSessionsStore({
      showToast: mock(() => {}),
      getIdentity: () => ({ npub: "npub1viewer" }),
      onItemsChanged,
      syncOnInit: false,
    });

    await registeredStore.sync();

    expect(onItemsChanged).toHaveBeenCalledWith([
      { id: "session-2", startedAt: "2026-06-13T02:00:00.000Z" },
    ]);
  });
});
