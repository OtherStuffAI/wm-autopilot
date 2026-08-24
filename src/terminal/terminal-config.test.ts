import { describe, expect, test } from "bun:test";
import { resolveTerminalConfig } from "./terminal-config";

describe("terminal config", () => {
  test("does not derive terminal access from a default PIN", () => {
    const config = resolveTerminalConfig({
      env: { SHELL: "/bin/zsh" },
      defaultCwd: "/tmp/autopilot",
    });
    expect("pin" in config).toBe(false);
    expect(config.shell).toBe("/bin/zsh");
    expect(config.cwd).toBe("/tmp/autopilot");
    expect(config.ptyMode).toBe("bridge");
  });

  test("ignores the retired TMAN_PIN environment fallback", () => {
    const config = resolveTerminalConfig({
      env: { TMAN_PIN: "12345", TMAN_CWD: "workspace" },
      defaultCwd: "/tmp/autopilot",
    });
    expect("pin" in config).toBe(false);
    expect(config.cwd).toBe("/tmp/autopilot/workspace");
  });

  test("allows direct PTY mode for diagnostics", () => {
    const config = resolveTerminalConfig({
      env: { TMAN_PTY_MODE: "direct" },
      defaultCwd: "/tmp/autopilot",
    });

    expect(config.ptyMode).toBe("direct");
  });

  test("rejects invalid PTY mode values", () => {
    expect(() => resolveTerminalConfig({
      env: { TMAN_PTY_MODE: "docker" },
      defaultCwd: "/tmp/autopilot",
    })).toThrow('TMAN_PTY_MODE must be "bridge" or "direct"');
  });
});
