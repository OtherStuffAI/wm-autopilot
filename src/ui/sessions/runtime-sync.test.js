import { describe, expect, test } from "bun:test";

import { buildSessionFilterOptions, initSessionRuntimeSync } from "./runtime-sync.js";

describe("buildSessionFilterOptions", () => {
  test("prepends the viewer option for admins and preserves session metadata", () => {
    const options = buildSessionFilterOptions({
      isAdmin: true,
      viewerNpub: "npub1viewer",
      filterOptions: [
        { value: "npub1viewer", npub: "npub1viewer", label: "Viewer", sessionCount: 2, activeCount: 1 },
        { value: "npub1other", npub: "npub1other", label: "Alice", sessionCount: 5, activeCount: 0 },
      ],
      abbreviateNpub: (value) => `abbr:${value.slice(0, 8)}`,
    });

    expect(options).toEqual([
      { value: "npub1viewer", label: "My identity (abbr:npub1vie)", npub: "npub1viewer" },
      { value: "all", label: "All identities" },
      {
        value: "npub1other",
        label: "Alice • 5 sessions",
        npub: "npub1other",
        sessionCount: 5,
        activeCount: 0,
      },
    ]);
  });

  test("falls back to anonymous labels when option metadata is sparse", () => {
    const options = buildSessionFilterOptions({
      isAdmin: false,
      viewerNpub: null,
      filterOptions: [{ value: "__anonymous__", sessionCount: 1, activeCount: 1 }],
      abbreviateNpub: (value) => value,
    });

    expect(options).toEqual([
      { value: "all", label: "All identities" },
      {
        value: "__anonymous__",
        label: "Anonymous • 1 sessions (1 active)",
        npub: null,
        sessionCount: 1,
        activeCount: 1,
      },
    ]);
  });

  test("can hydrate active live details without blocking session sync", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    const originalElement = globalThis.Element;
    const pendingDetailFetch = new Promise(() => {});
    globalThis.fetch = async (url) => {
      const path = String(url);
      if (path.includes("/logs") || path.includes("/messages")) {
        return pendingDetailFetch;
      }
      return new Response(JSON.stringify({}), {
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.window = {
      location: { pathname: "/live/session-1" },
      history: { replaceState() {} },
    };
    globalThis.Element = class Element {};

    const sessionState = {
      items: [{ id: "session-1" }],
      initialized: true,
      activeSessionId: "session-1",
      lastActiveSessionId: "session-1",
      sync: async () => {},
      filters: { options: [] },
    };
    const runtime = initSessionRuntimeSync({
      state: {
        identity: {},
        logs: new Map(),
        messageDrafts: new Map(),
        conversationContainers: new Map(),
        logContainers: new Map(),
        lastMessageCount: new Map(),
        liveMessageWindows: new Map(),
        lastLogLength: new Map(),
        promptQueues: new Map(),
      },
      sessionsStore: () => sessionState,
      agentSelect: { innerHTML: "", append() {}, value: "" },
      directoryInput: null,
      getCurrentRoute: () => "live",
      setCurrentRoute: () => {},
      homeRoute: "/home",
      getSessionIdFromPath: () => "session-1",
      normaliseNpubValue: (value) => value,
      abbreviateNpub: (value) => value,
      syncFeatureFlagsFromConfig: () => {},
      updateIdentityState: () => {},
      scheduleDirectorySuggestions: () => {},
      MessageStore: { syncFromServerIfChanged: async () => ({ changed: false }) },
      isAlpineChatEnabled: () => true,
      scrollPillIsNearBottom: () => true,
      scrollPillShow: () => {},
      updateLogsDOM: () => {},
      updateConversationDOM: async () => {},
      fetchSessionQueue: () => pendingDetailFetch,
      applyRouteSessionFromPath: () => {},
      ensureActiveSession: () => {},
    });

    try {
      await expect(
        Promise.race([
          runtime.fetchSessions({ waitForActiveSessionDetails: false }).then(() => "resolved"),
          new Promise((resolve) => setTimeout(() => resolve("timed-out"), 20)),
        ]),
      ).resolves.toBe("resolved");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.window = originalWindow;
      globalThis.Element = originalElement;
    }
  });
});
