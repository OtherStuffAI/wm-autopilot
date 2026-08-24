import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const stdioSource = readFileSync(new URL("./stdio-server.ts", import.meta.url), "utf8");

describe("removed SuperBased MCP surface", () => {
  test("does not register legacy tools and preserves generic NIP-44 tools", () => {
    expect(stdioSource).not.toMatch(/registerWingmanTool\(server,\s*["']superbased_/);
    expect(stdioSource).not.toContain("./tools/superbased-");
    expect(stdioSource).toMatch(/registerWingmanTool\(server,\s*["']nip44_encrypt["']/);
    expect(stdioSource).toMatch(/registerWingmanTool\(server,\s*["']nip44_decrypt["']/);
  });
});
