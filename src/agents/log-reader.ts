/**
 * Filesystem-based log reader for PM2 managed processes.
 * Reads log files from user-specific directories.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

import { sanitizeLogEntry } from "../logging/log-sanitizer";

export interface LogPaths {
  stdout: string;
  stderr: string;
}

export interface LogEntry {
  source: "stdout" | "stderr";
  content: string;
  timestamp?: string;
}

/**
 * Get the log file paths for a process.
 */
export function getLogPaths(logsDir: string, processName: string): LogPaths {
  return {
    stdout: join(logsDir, `${processName}-out.log`),
    stderr: join(logsDir, `${processName}-error.log`),
  };
}

/**
 * Read the last N lines from a file.
 * Returns empty string if file doesn't exist.
 */
export async function readLogTail(filePath: string, lines: number = 100): Promise<string> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return "";
    }

    const text = await file.text();
    if (!text) {
      return "";
    }

    const allLines = text.split("\n");
    return allLines.slice(-lines).join("\n");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

/**
 * Read and combine stdout/stderr logs, returning sanitized entries.
 * Each line is prefixed with [stdout] or [stderr].
 */
export async function readCombinedLogs(
  logsDir: string,
  processName: string,
  lines: number = 100,
): Promise<string[]> {
  const paths = getLogPaths(logsDir, processName);

  const [stdoutContent, stderrContent] = await Promise.all([
    readLogTail(paths.stdout, lines),
    readLogTail(paths.stderr, lines),
  ]);

  const entries: string[] = [];

  // Process stdout lines
  for (const line of stdoutContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) {
      const sanitized = sanitizeLogEntry(`[stdout] ${trimmed}`);
      if (sanitized) {
        entries.push(sanitized);
      }
    }
  }

  // Process stderr lines
  for (const line of stderrContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) {
      const sanitized = sanitizeLogEntry(`[stderr] ${trimmed}`);
      if (sanitized) {
        entries.push(sanitized);
      }
    }
  }

  // Return last N entries
  return entries.slice(-lines);
}

/**
 * Get file stats for log files (for checking if they've been updated).
 */
export async function getLogStats(
  logsDir: string,
  processName: string,
): Promise<{ stdout: { size: number; mtime: Date } | null; stderr: { size: number; mtime: Date } | null }> {
  const paths = getLogPaths(logsDir, processName);

  const getStats = async (filePath: string) => {
    try {
      const stats = await stat(filePath);
      return { size: stats.size, mtime: stats.mtime };
    } catch {
      return null;
    }
  };

  const [stdout, stderr] = await Promise.all([
    getStats(paths.stdout),
    getStats(paths.stderr),
  ]);

  return { stdout, stderr };
}

/**
 * Check if log files exist for a process.
 */
export async function logsExist(logsDir: string, processName: string): Promise<boolean> {
  const paths = getLogPaths(logsDir, processName);
  const stdoutFile = Bun.file(paths.stdout);
  const stderrFile = Bun.file(paths.stderr);

  const [stdoutExists, stderrExists] = await Promise.all([
    stdoutFile.exists(),
    stderrFile.exists(),
  ]);

  return stdoutExists || stderrExists;
}

/**
 * Delete log files for a process.
 */
export async function deleteLogs(logsDir: string, processName: string): Promise<void> {
  const paths = getLogPaths(logsDir, processName);
  const { unlink } = await import("node:fs/promises");

  const deleteFile = async (filePath: string) => {
    try {
      await unlink(filePath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
  };

  await Promise.all([deleteFile(paths.stdout), deleteFile(paths.stderr)]);
}

/**
 * Truncate log files (clear them without deleting).
 */
export async function truncateLogs(logsDir: string, processName: string): Promise<void> {
  const paths = getLogPaths(logsDir, processName);
  const { writeFile } = await import("node:fs/promises");

  const truncateFile = async (filePath: string) => {
    try {
      await writeFile(filePath, "", "utf-8");
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
  };

  await Promise.all([truncateFile(paths.stdout), truncateFile(paths.stderr)]);
}
