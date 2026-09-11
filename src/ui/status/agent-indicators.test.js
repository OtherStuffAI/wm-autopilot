import { describe, expect, test } from "bun:test";

import { getAgentStatusIndicatorPresentation } from "./agent-status-presentation.js";

describe("agent status indicator presentation", () => {
  test("names active and ready runtime states", () => {
    expect(getAgentStatusIndicatorPresentation("running")).toEqual({
      ariaLabel: "Agent status: running",
      pillLabel: "Running",
    });
    expect(getAgentStatusIndicatorPresentation("stable")).toEqual({
      ariaLabel: "Agent status: ready",
      pillLabel: "Ready",
    });
  });

  test("keeps queue count out of the runtime status pill", () => {
    expect(getAgentStatusIndicatorPresentation("running", 2)).toEqual({
      ariaLabel: "Agent status: running",
      pillLabel: "Running",
    });
  });
});
