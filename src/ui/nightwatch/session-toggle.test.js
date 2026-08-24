import { describe, expect, test } from "bun:test";

import {
  getNightWatchToggleLabel,
  syncSessionMetadata,
} from "./session-toggle.js";

describe("session-toggle", () => {
  test("formats the Night Watch toggle label", () => {
    expect(getNightWatchToggleLabel(true)).toBe("Night Watch: On");
    expect(getNightWatchToggleLabel(false)).toBe("Night Watch: Off");
  });

  test("reconciles the in-memory session metadata object with the patch response", () => {
    const metadata = {
      goal: "Ship it",
      nextAction: "reflect",
      stale: "value",
    };

    syncSessionMetadata(metadata, {
      metadata: {
        goal: "Review it",
        nextActionPayload: "Open the drawer",
      },
    });

    expect(metadata).toEqual({
      goal: "Review it",
      nextActionPayload: "Open the drawer",
    });
  });
});
