import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { createSessionRouting } from "./session-routing.js";

describe("createSessionRouting", () => {
  let originalWindow;
  let originalRequestAnimationFrame;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  });

  afterEach(() => {
    globalThis.window = originalWindow;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });

  test("defers forced bottom scroll until after a live tab switch render", () => {
    const frames = [];
    const sessionsState = {
      activeSessionId: "session-a",
      lastActiveSessionId: "session-a",
      items: [
        { id: "session-a", port: 4700 },
        { id: "session-b", port: 4701 },
      ],
    };
    const scheduleLiveScroll = mock(() => {});

    globalThis.requestAnimationFrame = (callback) => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.window = {
      location: { pathname: "/live/session-a" },
      history: { pushState: mock((_state, _title, path) => { globalThis.window.location.pathname = path; }) },
    };

    const { setActiveSession } = createSessionRouting({
      sessionsStore: () => sessionsState,
      getCurrentRoute: () => "live",
      getLastLoggedSessionId: () => null,
      setLastLoggedSessionId: mock(() => {}),
      LIVE_ROUTE_PREFIX: "/live",
      getSessionById: (id) => sessionsState.items.find((session) => session.id === id) ?? null,
      getActiveSessions: () => sessionsState.items,
      getSessionIdFromPath: () => null,
      updateDocumentTitle: mock(() => {}),
      activateLiveSessionRefresh: mock(() => {}),
      deactivateLiveSessionRefresh: mock(() => {}),
      getLiveRefreshSessionId: () => "session-a",
      isAlpineChatEnabled: () => false,
      scheduleLiveScroll,
    });

    setActiveSession("session-b", { logPort: false });

    expect(scheduleLiveScroll).not.toHaveBeenCalled();

    frames.shift()?.();
    expect(scheduleLiveScroll).not.toHaveBeenCalled();

    frames.shift()?.();
    expect(scheduleLiveScroll).toHaveBeenCalledWith("session-b", {
      includeWindow: true,
      force: true,
    });
  });
});
