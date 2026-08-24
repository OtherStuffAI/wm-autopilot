import { beforeEach, describe, expect, mock, test } from "bun:test";

let registeredStore = null;
let liveQueryNext = null;

const getAllMock = mock(async () => []);
const upsertManyMock = mock(async () => {});
const clearMock = mock(async () => {});
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
          liveQueryNext = observer.next;
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
}));

mock.module("../services/sessions.js", () => ({
  fetchSessionsApi: fetchSessionsApiMock,
}));

const { initSessionsStore } = await import("./store.js");

describe("sessions store", () => {
  beforeEach(() => {
    registeredStore = null;
    liveQueryNext = null;
    getAllMock.mockClear();
    upsertManyMock.mockClear();
    clearMock.mockClear();
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
    liveQueryNext?.([{ id: "session-1", startedAt: "2026-06-13T01:00:00.000Z" }]);

    expect(onItemsChanged).toHaveBeenCalledWith([
      { id: "session-1", startedAt: "2026-06-13T01:00:00.000Z" },
    ]);
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
