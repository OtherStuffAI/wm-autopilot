import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { createSessionLauncher } from "./session-launch.js";

describe("createSessionLauncher", () => {
  let originalFetch;
  let originalLocalStorage;
  let originalWindow;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocalStorage = globalThis.localStorage;
    originalWindow = globalThis.window;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
    globalThis.window = originalWindow;
  });

  test("activates new sessions in the current window even when a caller requests a new tab", async () => {
    const handleSessionStart = mock(async () => {});
    const windowOpen = mock(() => null);
    const draftStore = new Map();

    globalThis.window = { open: windowOpen };
    globalThis.localStorage = {
      setItem: mock((key, value) => draftStore.set(key, value)),
    };
    globalThis.fetch = mock(async () =>
      Response.json({
        id: "session-1",
        agent: "codex",
      }),
    );

    const launchSession = createSessionLauncher({ handleSessionStart });

    await launchSession("codex", "/tmp/project", "Follow up", null, {
      openInNewTab: true,
      initialPrompt: "Continue here",
    });

    expect(windowOpen).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(draftStore.get("session-draft-session-1")).toBe("Continue here");
    expect(handleSessionStart).toHaveBeenCalledWith({
      id: "session-1",
      agent: "codex",
    });
  });
});
