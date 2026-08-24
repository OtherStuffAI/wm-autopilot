import { describe, expect, mock, test } from "bun:test";

import { createSessionStopFeedback } from "./session-stop-feedback.js";

function createStopFeedback(overrides = {}) {
  const session = { id: "session-1", name: "Codex" };
  const stopSession = overrides.stopSession ?? mock(async () => ({ success: true }));
  const showToast = overrides.showToast ?? mock(() => {});
  const confirm = overrides.confirm ?? mock(() => true);

  globalThis.window = {
    ...(globalThis.window ?? {}),
    confirm,
  };

  return {
    session,
    stopSession,
    showToast,
    confirm,
    feedback: createSessionStopFeedback({
      getSessionById: (sessionId) => (sessionId === session.id ? session : null),
      getSessionDisplayName: (item) => item.name,
      stopSession,
      showToast,
    }),
  };
}

describe("createSessionStopFeedback", () => {
  test("shows progress and success toasts for a confirmed stop", async () => {
    const { feedback, showToast, stopSession, confirm } = createStopFeedback();

    const result = await feedback.requestStopSession("session-1", { confirm: true });

    expect(result).toEqual({ success: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledWith("session-1");
    expect(showToast).toHaveBeenNthCalledWith(1, "Stopping Codex...", { type: "info" });
    expect(showToast).toHaveBeenNthCalledWith(2, "Stopped Codex", { type: "success" });
  });

  test("returns early when the user cancels confirmation", async () => {
    const { feedback, stopSession, showToast, confirm } = createStopFeedback({
      confirm: mock(() => false),
    });

    const result = await feedback.requestStopSession("session-1", { confirm: true });

    expect(result).toEqual({ success: false, cancelled: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(stopSession).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  test("surfaces stop failures through an error toast", async () => {
    const { feedback, showToast } = createStopFeedback({
      stopSession: mock(async () => ({ success: false, error: "session-not-running" })),
    });

    const result = await feedback.requestStopSession("session-1");

    expect(result).toEqual({ success: false, error: "session-not-running" });
    expect(showToast).toHaveBeenNthCalledWith(1, "Stopping Codex...", { type: "info" });
    expect(showToast).toHaveBeenNthCalledWith(2, "Failed to stop Codex: session-not-running", {
      type: "error",
      duration: 5000,
    });
  });
});
