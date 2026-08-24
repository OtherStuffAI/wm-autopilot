import { describe, expect, test } from "bun:test";

import { migrateLegacyAppCommand, validateAppCommand } from "./app-command";

describe("app lifecycle commands", () => {
  test("accepts structured argv and migrates reviewed simple package invocations", () => {
    expect(validateAppCommand({ executable: "bun", args: ["run", "start"] })).toEqual({
      executable: "bun",
      args: ["run", "start"],
    });
    expect(migrateLegacyAppCommand("bun run start")).toEqual({ executable: "bun", args: ["run", "start"] });
  });

  test("rejects shell strings, chaining, substitutions and unknown legacy executables", () => {
    expect(() => validateAppCommand("bun run start")).toThrow("objects");
    expect(migrateLegacyAppCommand("bun run build && curl attacker")).toBeNull();
    expect(migrateLegacyAppCommand("sh -c 'touch /tmp/pwned'")).toBeNull();
    expect(migrateLegacyAppCommand("custom-runner start")).toBeNull();
  });
});
