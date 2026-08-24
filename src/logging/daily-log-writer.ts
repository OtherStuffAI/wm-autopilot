import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";

const DEFAULT_LOG_DIR = fileURLToPath(new URL("../../data/logs", import.meta.url));

const safeEnsureDir = (path: string) => {
  mkdirSync(path, { recursive: true });
};

const getDateStamp = (date: Date): string => {
  return date.toISOString().slice(0, 10);
};

const getLogFilePath = (directory: string, baseName: string, dateStamp: string): string => {
  return join(directory, `${baseName}-${dateStamp}.log`);
};

export interface DailyLogWriterOptions {
  directory?: string;
  baseName?: string;
}

export class DailyLogWriter {
  private readonly directory: string;
  private readonly baseName: string;
  private currentDateStamp: string;
  private currentFilePath: string;

  constructor(options: DailyLogWriterOptions = {}) {
    this.directory = options.directory ?? DEFAULT_LOG_DIR;
    this.baseName = options.baseName ?? "server";

    safeEnsureDir(this.directory);
    this.currentDateStamp = getDateStamp(new Date());
    this.currentFilePath = getLogFilePath(this.directory, this.baseName, this.currentDateStamp);
    safeEnsureDir(dirname(this.currentFilePath));
  }

  write(level: LogLevel, args: unknown[]): void {
    try {
      const now = new Date();
      const dateStamp = getDateStamp(now);
      if (dateStamp !== this.currentDateStamp) {
        this.currentDateStamp = dateStamp;
        this.currentFilePath = getLogFilePath(this.directory, this.baseName, this.currentDateStamp);
      }
      const timestamp = now.toISOString();
      const rendered = util.format(...args);
      const line = `${timestamp} [${level}] ${rendered}\n`;
      appendFileSync(this.currentFilePath, line);
    } catch (error) {
      const fallback = `[logging] failed to write to log file: ${
        error instanceof Error ? error.message : String(error)
      }\n`;
      try {
        process.stderr.write(fallback);
      } catch {
        // If stderr is unavailable just give up quietly to avoid recursive errors.
      }
    }
  }
}
