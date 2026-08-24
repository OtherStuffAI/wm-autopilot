import { describe, expect, test } from "bun:test";

import { CODEX_ACP_FLAG, PI_ACP_FLAG } from "../agents/agent-adapter";
import { MANAGED_FEATURE_FLAG_DEFAULTS, ensureManagedFeatureFlags } from "./managed-feature-flags";

describe("managed feature flags", () => {
  test("ships Codex ACP off by default", () => {
    expect(MANAGED_FEATURE_FLAG_DEFAULTS.find((flag) => flag.key === CODEX_ACP_FLAG)).toMatchObject({
      label: "Codex ACP",
      state: "off",
    });
  });

  test("reconciles the Codex ACP managed default to off", () => {
    const states = new Map<string, string>();
    ensureManagedFeatureFlags({
      ensureDefaults: (defaults) => defaults.forEach((flag) => states.set(flag.key, flag.state ?? "off")),
      ensureDefaultState: (key, state) => {
        states.set(key, state);
        return null;
      },
    });
    expect(states.get(CODEX_ACP_FLAG)).toBe("off");
    expect(states.get(PI_ACP_FLAG)).toBe("off");
  });

  test("ships Pi ACP off by default", () => {
    expect(MANAGED_FEATURE_FLAG_DEFAULTS.find((flag) => flag.key === PI_ACP_FLAG)).toMatchObject({
      label: "Pi ACP",
      state: "off",
    });
  });

  test("does not expose the removed relay task listener as an operative feature", () => {
    expect(MANAGED_FEATURE_FLAG_DEFAULTS.some((flag) => flag.key === "task_listener_enabled")).toBe(false);
  });
});
