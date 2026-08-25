import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { hardenProcessStatePermissions } from "./process-state-permissions";

function permissions(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("process state permissions", () => {
  test("restricts PM2 dumps and managed app state to the current account", async () => {
    const root = mkdtempSync(join(tmpdir(), "process-state-permissions-"));
    const pm2Home = join(root, "pm2");
    const appStateDirectory = join(root, "app-state");
    try {
      mkdirSync(pm2Home, { recursive: true });
      mkdirSync(appStateDirectory, { recursive: true });
      writeFileSync(join(pm2Home, "dump.pm2"), "[]\n");
      writeFileSync(join(pm2Home, "dump.pm2.bak"), "[]\n");
      writeFileSync(join(appStateDirectory, "ecosystem.config.cjs"), "module.exports = { apps: [] };\n");
      chmodSync(pm2Home, 0o755);
      chmodSync(join(pm2Home, "dump.pm2"), 0o644);
      chmodSync(join(pm2Home, "dump.pm2.bak"), 0o644);
      chmodSync(appStateDirectory, 0o755);
      chmodSync(join(appStateDirectory, "ecosystem.config.cjs"), 0o644);

      await hardenProcessStatePermissions({ pm2Home, appStateDirectory });

      expect(permissions(pm2Home)).toBe(0o700);
      expect(permissions(join(pm2Home, "dump.pm2"))).toBe(0o600);
      expect(permissions(join(pm2Home, "dump.pm2.bak"))).toBe(0o600);
      expect(permissions(appStateDirectory)).toBe(0o700);
      expect(permissions(join(appStateDirectory, "ecosystem.config.cjs"))).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
