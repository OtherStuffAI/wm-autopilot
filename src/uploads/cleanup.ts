import { type Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Configuration for a generic upload cleanup run.
 *
 * @property root       - Absolute path to the root upload directory.
 *                        Expected structure: root/<user>/<sub-dir>/<files>
 * @property ttlMs      - Time-to-live in milliseconds. Files older than this
 *                        (measured by mtime) are deleted.
 * @property label      - Human-readable label used in log messages
 *                        (e.g. "image", "attachment").
 */
export interface CleanupConfig {
  root: string;
  ttlMs: number;
  label: string;
}

/**
 * Configuration for scheduling a recurring cleanup job.
 * Extends CleanupConfig with an interval.
 *
 * @property intervalMs - How often to run cleanup in milliseconds.
 */
export interface ScheduleCleanupConfig extends CleanupConfig {
  intervalMs: number;
}

/**
 * Walk root/<user>/<sub-dir>/<files> and delete any file whose mtime is
 * older than `config.ttlMs`. Missing root directories are silently ignored
 * so the function is safe to call before the first upload has been made.
 */
export const runCleanup = async (config: CleanupConfig): Promise<void> => {
  const { root, ttlMs, label } = config;

  let userDirs: Dirent[];
  try {
    userDirs = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    console.error(`[uploads] failed to list ${label} directory`, error);
    return;
  }

  const threshold = Date.now() - ttlMs;

  await Promise.all(
    userDirs
      .filter((entry) => entry.isDirectory())
      .map(async (userDir) => {
        const userPath = join(root, userDir.name);
        let subEntries: Dirent[];
        try {
          subEntries = await readdir(userPath, { withFileTypes: true });
        } catch (error) {
          console.error(`[uploads] failed to list user ${label} directory ${userDir.name}`, error);
          return;
        }

        await Promise.all(
          subEntries
            .filter((entry) => entry.isDirectory())
            .map(async (subDir) => {
              const subPath = join(userPath, subDir.name);
              let files: Dirent[];
              try {
                files = await readdir(subPath, { withFileTypes: true });
              } catch (error) {
                console.error(`[uploads] failed to list ${label} subdirectory ${subDir.name}`, error);
                return;
              }

              await Promise.all(
                files
                  .filter((entry) => entry.isFile())
                  .map(async (file) => {
                    const filePath = join(subPath, file.name);
                    try {
                      const stats = await stat(filePath);
                      if (stats.mtimeMs < threshold) {
                        await rm(filePath, { force: true });
                        console.log(`[uploads] removed expired ${label} ${filePath}`);
                      }
                    } catch (error) {
                      console.error(`[uploads] failed to cleanup ${label} ${filePath}`, error);
                    }
                  }),
              );
            }),
        );
      }),
  );
};

/**
 * Schedule a recurring cleanup job. Runs once immediately (fire-and-forget,
 * best-effort) then repeats every `config.intervalMs` milliseconds.
 * The interval timer is unref'd so it does not prevent process exit.
 */
export const scheduleCleanup = (config: ScheduleCleanupConfig): void => {
  const { intervalMs, label } = config;

  // Initial run on startup
  runCleanup(config).catch((error) =>
    console.error(`[uploads] initial ${label} cleanup failed`, error),
  );

  setInterval(() => {
    runCleanup(config).catch((error) =>
      console.error(`[uploads] scheduled ${label} cleanup failed`, error),
    );
  }, intervalMs).unref?.();
};
