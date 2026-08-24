import { describe, expect, test } from "bun:test";

import {
  buildAgentCliUpdateArgs,
  buildAgentCliUpdateEnv,
  isAgentCliAutoUpdateEnabled,
} from "./agent-cli-update-policy";

describe("agent CLI update policy", () => {
  test("defaults agent CLI auto-updates off", () => {
    expect(isAgentCliAutoUpdateEnabled({})).toBe(false);
  });

  test("accepts explicit auto-update opt-in", () => {
    expect(isAgentCliAutoUpdateEnabled({ AGENT_CLI_AUTOUPDATE: "true" })).toBe(true);
    expect(isAgentCliAutoUpdateEnabled({ AGENT_CLI_AUTOUPDATE: "1" })).toBe(true);
  });

  test("builds Claude auto-updater disable env", () => {
    expect(buildAgentCliUpdateEnv("claude", false)).toEqual({
      DISABLE_AUTOUPDATER: "1",
    });
  });

  test("builds Codex update-notifier disable env", () => {
    expect(buildAgentCliUpdateEnv("codex", false)).toEqual({
      NO_UPDATE_NOTIFIER: "1",
      npm_config_update_notifier: "false",
    });
  });

  test("builds Codex startup update-check disable args", () => {
    expect(buildAgentCliUpdateArgs("codex", false)).toEqual([
      "-c",
      "check_for_update_on_startup=false",
    ]);
  });

  test("leaves agent env untouched when auto-updates are enabled", () => {
    expect(buildAgentCliUpdateEnv("claude", true)).toEqual({});
    expect(buildAgentCliUpdateEnv("codex", true)).toEqual({});
    expect(buildAgentCliUpdateArgs("codex", true)).toEqual([]);
  });
});
