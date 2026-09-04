import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("Wingman Git credential Docker packaging", () => {
  test("compiles, installs, and readiness-checks the executable", async () => {
    const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
    const readiness = await readFile(new URL("../../scripts/docker-readiness.ts", import.meta.url), "utf8");
    expect(dockerfile).toContain("--outfile /usr/local/bin/git-credential-wingman");
    expect(dockerfile).toContain("test -x /usr/local/bin/git-credential-wingman");
    expect(readiness).toContain('command: "/usr/local/bin/git-credential-wingman", args: ["--version"]');
  });
});
