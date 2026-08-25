import { chmod, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const AUTOPILOT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface ProcessStatePermissionOptions {
  pm2Home?: string;
  appStateDirectory?: string;
}

async function chmodIfPresent(path: string, mode: number): Promise<boolean> {
  try {
    await stat(path);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return false;
    throw error;
  }
  await chmod(path, mode);
  return true;
}

export async function hardenProcessStatePermissions(
  options: ProcessStatePermissionOptions = {},
): Promise<void> {
  const configuredPm2Home = process.env.PM2_HOME?.trim();
  const pm2Home = options.pm2Home ?? (configuredPm2Home || join(homedir(), ".pm2"));
  const appStateDirectory = options.appStateDirectory ?? join(AUTOPILOT_ROOT, "data", "admin");

  await mkdir(pm2Home, { recursive: true, mode: 0o700 });
  await chmod(pm2Home, 0o700);
  await Promise.all([
    chmodIfPresent(join(pm2Home, "dump.pm2"), 0o600),
    chmodIfPresent(join(pm2Home, "dump.pm2.bak"), 0o600),
  ]);

  await mkdir(appStateDirectory, { recursive: true, mode: 0o700 });
  await chmod(appStateDirectory, 0o700);
  await chmodIfPresent(join(appStateDirectory, "ecosystem.config.cjs"), 0o600);
}
