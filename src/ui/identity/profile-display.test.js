import { describe, expect, test } from "bun:test";

import { getIdentityDisplayName } from "./profile-display.js";

describe("identity profile display", () => {
  test("prefers the Nostr profile name over the three-word alias", () => {
    expect(getIdentityDisplayName({ profileName: "Example Operator", alias: "sample-operator" })).toBe("Example Operator");
  });

  test("uses the three-word alias when the Nostr profile has no name", () => {
    expect(getIdentityDisplayName({ profileName: null, alias: "sample-operator" })).toBe("sample-operator");
  });
});
