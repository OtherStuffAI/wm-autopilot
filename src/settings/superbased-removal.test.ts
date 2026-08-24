import { describe, expect, test } from "bun:test";

import { INSTANCE_SETTING_DEFINITIONS } from "./instance-settings-registry";

describe("removed SuperBased settings", () => {
  test("does not expose an active config key or environment alias", () => {
    expect(INSTANCE_SETTING_DEFINITIONS.some((definition) => (
      definition.key.toLowerCase().includes("superbased")
      || definition.envAliases.some((alias) => alias.toUpperCase().includes("SUPERBASED"))
      || definition.compatibilityEnvName?.toUpperCase().includes("SUPERBASED")
    ))).toBe(false);
  });
});
