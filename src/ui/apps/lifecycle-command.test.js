import { describe, expect, test } from "bun:test";

import { formatLifecycleCommand, parseLifecycleCommand } from "./lifecycle-command.js";

describe("app lifecycle command form adapter", () => {
  test("round trips structured argv", () => {
    const command = { executable: "bun", args: ["run", "start"] };
    expect(formatLifecycleCommand(command)).toBe("bun run start");
    expect(parseLifecycleCommand("bun run start")).toEqual(command);
  });

  test("rejects shell syntax", () => {
    expect(() => parseLifecycleCommand("bun run build && curl attacker")).toThrow("shell syntax");
    expect(() => parseLifecycleCommand("sh -c 'touch /tmp/pwned'")).toThrow("shell syntax");
  });
});
