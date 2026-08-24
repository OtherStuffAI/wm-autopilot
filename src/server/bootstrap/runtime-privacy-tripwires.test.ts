import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertNoPersistentRootMcpConfig } from "./runtime-privacy-tripwires";

describe("runtime privacy tripwires", () => {
  test("rejects a repository-root MCP file", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-tripwire-"));
    try {
      assertNoPersistentRootMcpConfig(root);
      await writeFile(join(root, ".mcp.json"), "{}");
      expect(() => assertNoPersistentRootMcpConfig(root)).toThrow("repository-root .mcp.json is unsupported");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
