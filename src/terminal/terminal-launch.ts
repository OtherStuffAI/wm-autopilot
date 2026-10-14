import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { TerminalConfig } from "./terminal-config";

export async function validateTerminalLaunch(config: TerminalConfig): Promise<TerminalConfig> {
  try {
    if (!(await stat(config.cwd)).isDirectory()) throw new Error("not a directory");
    await access(config.cwd, constants.X_OK);
  } catch {
    throw new Error(`Terminal working directory is unavailable: ${config.cwd}. Check TMAN_CWD.`);
  }
  const candidates = config.shell.includes("/")
    ? [isAbsolute(config.shell) ? config.shell : resolve(config.cwd, config.shell)]
    : (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory || config.cwd, config.shell));
  for (const shell of candidates) {
    try {
      if (!(await stat(shell)).isFile()) continue;
      await access(shell, constants.X_OK);
      return { ...config, shell };
    } catch {
      // Continue only the requested executable's PATH search, never choose another shell.
    }
  }
  throw new Error(`Terminal shell is not executable: ${config.shell}. Check TMAN_SHELL.`);
}
