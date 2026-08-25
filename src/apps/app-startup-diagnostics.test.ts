import { describe, expect, test } from "bun:test";

import { summarizeAppStartupLogs } from "./app-startup-diagnostics";

describe("app startup diagnostics", () => {
  test("returns the concrete startup error instead of wrapper noise", () => {
    expect(summarizeAppStartupLogs([
      "[stderr] 2026-08-25 09:12:05: error when starting preview server:",
      "[stderr] 2026-08-25 09:12:05: Error: FLIGHT_DECK_PG_APP_NPUB must be set",
      "[stderr] 2026-08-25 09:12:05:     at requireNpubEnv (vite.config.js:12:3)",
      "[stderr] 2026-08-25 09:12:05: error: script \"start\" exited with code 1",
    ])).toBe("Error: FLIGHT_DECK_PG_APP_NPUB must be set");
  });

  test("returns null when logs only contain command wrapper noise", () => {
    expect(summarizeAppStartupLogs([
      "[stdout] $ bun run start",
      "[stderr] error: script \"start\" exited with code 1",
    ])).toBeNull();
  });
});
