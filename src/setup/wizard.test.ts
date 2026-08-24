import { describe, expect, test } from "bun:test";

import { validateNonInteractiveSetupConfig } from "./wizard";

describe("noninteractive setup validation", () => {
  test("requires admin npub before completing Docker setup", () => {
    const missing = validateNonInteractiveSetupConfig(new Map([
      ["DIRECTORY_DEF", "/workspace"],
      ["IDENTITY_SESSION_SECRET", "secret"],
    ]), {});

    expect(missing).toEqual(["ADMIN_NPUB"]);
  });

  test("accepts generated Docker env aliases for the happy path", () => {
    const missing = validateNonInteractiveSetupConfig(new Map([
      ["WINGMAN_DIRECTORY_DEF", "/workspace"],
      ["WINGMAN_IDENTITY_SESSION_SECRET", "secret"],
      ["WINGMAN_ADMIN_NPUB", "npub1operator"],
    ]), {});

    expect(missing).toEqual([]);
  });
});
