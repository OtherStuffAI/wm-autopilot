import { chmod, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export async function ensureNodePtyMacHelperExecutable(): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const packageJsonPath = require.resolve("node-pty/package.json");
  const packageRoot = dirname(packageJsonPath);
  const helperPath = join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  await ensureExecutableBit(helperPath);
}

export async function ensureExecutableBit(path: string): Promise<void> {
  const info = await stat(path);
  if ((info.mode & 0o111) !== 0) {
    return;
  }
  await chmod(path, info.mode | 0o755);
}
