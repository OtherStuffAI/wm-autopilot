import { describe, expect, test } from "bun:test";
import { containerArguments, validateExecution, validateSnapshot } from "./project-profile.ts";
const image = `sha256:${"a".repeat(64)}`;

describe("managed project profile", () => {
  test("fails closed on mutable images and unsafe snapshots", () => {
    expect(() => containerArguments("wm-project-a", "bun:latest")).toThrow();
    for (const path of ["../sibling", "/home/key", "a/../key", "a//b", ".", "a\\b"]) {
      expect(() => validateSnapshot([{ path, base64: "" }])).toThrow();
    }
    expect(() => validateSnapshot([{ path: "a", base64: "" }, { path: "a/b", base64: "" }])).toThrow();
    expect(() => validateSnapshot([{ path: "a", base64: "invalid!" }])).toThrow();
    expect(() => validateExecution({ project: [], continuity: [], command: ["sh"], durationMs: 120001 })).toThrow();
  });
  test("has no host mounts, network, capability or env passthrough", () => {
    const args = containerArguments("wm-project-a", image);
    expect(args).toContain("--network=none");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--read-only");
    expect(args).toContain("--user=10001:10001");
    expect(args).toContain("--pids-limit=128");
    expect(args).toContain("--security-opt=no-new-privileges:true");
    expect(args.some((arg) => /^--(?:mount|volume|privileged|publish|pid|env-file)(?:=|$)/.test(arg))).toBe(false);
  });
});
