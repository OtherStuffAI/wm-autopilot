import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const disableNightWatchMock = mock(async () => ({ intervalMinutes: 5 }));
const enableNightWatchMock = mock(async () => ({ intervalMinutes: 5, maxCycles: 21 }));
const fetchNightWatchConfigMock = mock(async () => ({
  prompt: "Any progress?",
  intervalMinutes: 5,
  minIntervalMinutes: 2,
  maxIntervalMinutes: 60,
  maxCycles: 21,
  maxCycleOptions: [6, 21, 256],
}));
const fetchNightWatchSessionStateMock = mock(async () => null);
const openNightWatchEnableModalMock = mock(async () => null);
const updateSessionMetadataApiMock = mock(async () => ({ metadata: {} }));

mock.module("./api.js", () => ({
  disableNightWatch: disableNightWatchMock,
  enableNightWatch: enableNightWatchMock,
  fetchNightWatchConfig: fetchNightWatchConfigMock,
  fetchNightWatchSessionState: fetchNightWatchSessionStateMock,
}));

mock.module("./enable-modal.js", () => ({
  openNightWatchEnableModal: openNightWatchEnableModalMock,
}));

mock.module("../services/sessions.js", () => ({
  updateSessionMetadataApi: updateSessionMetadataApiMock,
}));

const {
  ensureNightWatchSessionToggleLoaded,
  toggleNightWatchForSession,
} = await import("./session-toggle.js");

describe("session Night Watch flow", () => {
  beforeEach(() => {
    disableNightWatchMock.mockClear();
    enableNightWatchMock.mockClear();
    fetchNightWatchConfigMock.mockClear();
    fetchNightWatchSessionStateMock.mockClear();
    openNightWatchEnableModalMock.mockClear();
    updateSessionMetadataApiMock.mockClear();

    disableNightWatchMock.mockImplementation(async () => ({ intervalMinutes: 5 }));
    enableNightWatchMock.mockImplementation(async () => ({ intervalMinutes: 5, maxCycles: 21 }));
    fetchNightWatchConfigMock.mockImplementation(async () => ({
      prompt: "Any progress?",
      intervalMinutes: 5,
      minIntervalMinutes: 2,
      maxIntervalMinutes: 60,
      maxCycles: 21,
      maxCycleOptions: [6, 21, 256],
    }));
    fetchNightWatchSessionStateMock.mockImplementation(async () => null);
    openNightWatchEnableModalMock.mockImplementation(async () => null);
    updateSessionMetadataApiMock.mockImplementation(async () => ({ metadata: {} }));
  });

  afterEach(() => {
    disableNightWatchMock.mockReset();
    enableNightWatchMock.mockReset();
    fetchNightWatchConfigMock.mockReset();
    fetchNightWatchSessionStateMock.mockReset();
    openNightWatchEnableModalMock.mockReset();
    updateSessionMetadataApiMock.mockReset();
  });

  test("loads per-session Night Watch state through the existing session state endpoint and caches it", async () => {
    const state = {
      nightwatch: {
        sessionToggles: new Map(),
      },
    };
    const onResolved = mock(() => {});
    fetchNightWatchSessionStateMock.mockImplementation(async () => ({
      enabled: true,
      intervalMinutes: 9,
    }));

    const firstResult = await ensureNightWatchSessionToggleLoaded({
      sessionId: "session-1",
      state,
      onResolved,
    });
    const secondResult = await ensureNightWatchSessionToggleLoaded({
      sessionId: "session-1",
      state,
      onResolved,
    });

    expect(fetchNightWatchSessionStateMock).toHaveBeenCalledTimes(1);
    expect(fetchNightWatchSessionStateMock).toHaveBeenCalledWith("session-1");
    expect(firstResult).toEqual({ enabled: true, intervalMinutes: 9 });
    expect(secondResult).toEqual({ enabled: true, intervalMinutes: 9 });
    expect(state.nightwatch.sessionToggles.get("session-1")).toEqual({
      enabled: true,
      intervalMinutes: 9,
    });
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith({ enabled: true, intervalMinutes: 9 });
  });

  test("PATCHes goal and next-action metadata before enabling Night Watch", async () => {
    const callOrder = [];
    const state = {
      nightwatch: {
        sessionToggles: new Map([["session-1", { enabled: false }]]),
      },
    };
    const sessionMetadata = {
      goal: "Old goal",
      nextAction: "reflect",
      nextActionTemplate: "Reflect on {{topic}}",
      stale: "remove me",
    };
    const showToast = mock((message) => {
      callOrder.push(`toast:${message}`);
    });
    const onChanged = mock((nextState) => {
      callOrder.push(`changed:${nextState.enabled}`);
    });

    fetchNightWatchConfigMock.mockImplementation(async () => {
      callOrder.push("fetch-config");
      return {
        prompt: "Any progress?",
        intervalMinutes: 5,
        minIntervalMinutes: 2,
        maxIntervalMinutes: 60,
        maxCycles: 21,
        maxCycleOptions: [6, 21, 256],
      };
    });
    fetchNightWatchSessionStateMock.mockImplementation(async () => {
      callOrder.push("fetch-session-state");
      return {
        prompt: "Check the transcript",
        intervalMinutes: 11,
        maxCycles: 13,
      };
    });
    openNightWatchEnableModalMock.mockImplementation(async (options) => {
      callOrder.push("open-modal");
      expect(options).toMatchObject({
        sessionName: "Drawer Test",
        prompt: "Check the transcript",
        intervalMinutes: 11,
        maxCycles: 13,
        goal: "Old goal",
        nextAction: "reflect",
        nextActionTemplate: "Reflect on {{topic}}",
      });
      return {
        prompt: "Check the transcript",
        intervalMinutes: 11,
        maxCycles: 13,
        goal: "Ship the drawer",
        nextAction: "Review the transcript",
        nextActionTemplate: "Review {{artifact}}",
      };
    });
    updateSessionMetadataApiMock.mockImplementation(async (sessionId, payload) => {
      callOrder.push("patch-metadata");
      expect(sessionId).toBe("session-1");
      expect(payload).toEqual({
        goal: "Ship the drawer",
        nextAction: "Review the transcript",
        nextActionTemplate: "Review {{artifact}}",
      });
      return {
        metadata: {
          goal: "Ship the drawer",
          nextActionPayload: "Review the transcript",
        },
      };
    });
    enableNightWatchMock.mockImplementation(async (sessionId, settings) => {
      callOrder.push("enable-night-watch");
      expect(sessionId).toBe("session-1");
      expect(settings).toMatchObject({
        prompt: "Check the transcript",
        intervalMinutes: 11,
        maxCycles: 13,
      });
      return {
        prompt: settings.prompt,
        intervalMinutes: settings.intervalMinutes,
        maxCycles: settings.maxCycles,
      };
    });

    const result = await toggleNightWatchForSession({
      sessionId: "session-1",
      sessionName: "Drawer Test",
      sessionMetadata,
      state,
      showToast,
      onChanged,
    });

    expect(callOrder).toEqual([
      "fetch-config",
      "fetch-session-state",
      "open-modal",
      "patch-metadata",
      "enable-night-watch",
      "toast:Night Watch enabled",
      "changed:true",
    ]);
    expect(result).toEqual({
      enabled: true,
      prompt: "Check the transcript",
      intervalMinutes: 11,
      maxCycles: 13,
    });
    expect(state.nightwatch.sessionToggles.get("session-1")).toEqual({
      enabled: true,
      prompt: "Check the transcript",
      intervalMinutes: 11,
      maxCycles: 13,
    });
    expect(sessionMetadata).toEqual({
      goal: "Ship the drawer",
      nextActionPayload: "Review the transcript",
    });
  });

  test("disables Night Watch through the existing per-session endpoint without patching metadata", async () => {
    const state = {
      nightwatch: {
        sessionToggles: new Map([["session-1", { enabled: true, intervalMinutes: 7 }]]),
      },
    };
    const showToast = mock(() => {});
    const onChanged = mock(() => {});

    disableNightWatchMock.mockImplementation(async (sessionId) => {
      expect(sessionId).toBe("session-1");
      return { intervalMinutes: 7 };
    });

    const result = await toggleNightWatchForSession({
      sessionId: "session-1",
      sessionName: "Drawer Test",
      sessionMetadata: { goal: "Ship the drawer" },
      state,
      showToast,
      onChanged,
    });

    expect(disableNightWatchMock).toHaveBeenCalledTimes(1);
    expect(enableNightWatchMock).not.toHaveBeenCalled();
    expect(updateSessionMetadataApiMock).not.toHaveBeenCalled();
    expect(result).toEqual({ enabled: false, intervalMinutes: 7 });
    expect(state.nightwatch.sessionToggles.get("session-1")).toEqual({
      enabled: false,
      intervalMinutes: 7,
    });
    expect(showToast).toHaveBeenCalledWith("Night Watch disabled");
    expect(onChanged).toHaveBeenCalledWith({ enabled: false, intervalMinutes: 7 });
  });
});
