import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createSessionActions } from "./actions-core.js";

const syncMock = mock(async () => {});
const removeMock = mock(async () => {});
const stopSessionApiMock = mock(async () => ({ success: true }));
const deleteSessionApiMock = mock(async () => ({ success: true }));
const updateSessionNameApiMock = mock(async () => ({ id: "session-1", name: "Renamed" }));
const patchSessionMock = mock(async () => {});
const sessionsStore = {
  items: [],
  sync: syncMock,
};

function buildActions() {
  return createSessionActions({
    getStore: () => sessionsStore,
    apiSessionStore: {
      remove: removeMock,
      patchSession: patchSessionMock,
    },
    stopSessionApi: stopSessionApiMock,
    deleteSessionApi: deleteSessionApiMock,
    updateSessionNameApi: updateSessionNameApiMock,
    resumeNativeSessionApi: mock(async () => ({})),
    forkSessionToWorktreeApi: mock(async () => ({})),
  });
}

describe("session actions", () => {
  beforeEach(() => {
    syncMock.mockClear();
    removeMock.mockClear();
    stopSessionApiMock.mockClear();
    deleteSessionApiMock.mockClear();
    updateSessionNameApiMock.mockClear();
    patchSessionMock.mockClear();
    sessionsStore.items = [];
  });

  test("stopSession syncs the sessions store after a successful stop", async () => {
    const { stopSession } = buildActions();
    const result = await stopSession("session-1");

    expect(stopSessionApiMock).toHaveBeenCalledWith("session-1");
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
  });

  test("deleteSession removes cached session data and syncs after success", async () => {
    const { deleteSession } = buildActions();
    const result = await deleteSession("session-2");

    expect(deleteSessionApiMock).toHaveBeenCalledWith("session-2");
    expect(removeMock).toHaveBeenCalledWith("session-2");
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
  });

  test("renameSession syncs the sessions store after updating details", async () => {
    const { renameSession } = buildActions();
    sessionsStore.items = [
      { id: "session-2", name: "Second", tabOrder: 2, startedAt: "2026-06-12T12:00:00.000Z" },
      { id: "session-1", name: "Original", tabOrder: 1, startedAt: "2026-06-12T11:00:00.000Z" },
    ];
    updateSessionNameApiMock.mockResolvedValueOnce({ id: "session-1", name: "Renamed", tabOrder: 3 });

    const result = await renameSession("session-1", "Renamed", 2);

    expect(updateSessionNameApiMock).toHaveBeenCalledWith("session-1", "Renamed", 2);
    expect(patchSessionMock).toHaveBeenCalledWith("session-1", { id: "session-1", name: "Renamed", tabOrder: 3 });
    expect(sessionsStore.items.map((session) => session.id)).toEqual(["session-2", "session-1"]);
    expect(sessionsStore.items.find((session) => session.id === "session-1")?.name).toBe("Renamed");
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: "session-1", name: "Renamed", tabOrder: 3 });
  });
});
