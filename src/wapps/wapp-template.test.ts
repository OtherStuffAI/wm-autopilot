import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "bun:test";

import { createWappTemplate } from "./wapp-template";

describe("WApp template publishing example", () => {
  test("documents broker publishing without generating private-key client code", async () => {
    const root = mkdtempSync(join(tmpdir(), "wapp-template-publishing-"));
    try {
      const result = await createWappTemplate(root, { force: true });
      expect(result.files).not.toContain("src/wapp-publishing-client.ts");
      expect(result.files).not.toContain("src/publishing-example.ts");
      const readme = readFileSync(join(root, "README.md"), "utf8");
      expect(readme).toContain("installation-scoped broker");
      expect(readme).not.toContain("WAPP_NSEC");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
