import type { LogLevel } from "./daily-log-writer";
import { DailyLogWriter } from "./daily-log-writer";

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";

const methodLevelMap: Record<ConsoleMethod, LogLevel> = {
  log: "INFO",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
  debug: "DEBUG",
  trace: "TRACE",
};

const originalConsole: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};
const dailyWriter = new DailyLogWriter({ baseName: "server" });

const ensureOriginalMethod = (method: ConsoleMethod) => {
  if (!originalConsole[method]) {
    originalConsole[method] = console[method].bind(console);
  }
};

const interceptConsoleMethod = (method: ConsoleMethod) => {
  ensureOriginalMethod(method);
  console[method] = (...args: unknown[]) => {
    dailyWriter.write(methodLevelMap[method], args);
    originalConsole[method]?.(...args);
  };
};

const installInterceptors = () => {
  (Object.keys(methodLevelMap) as ConsoleMethod[]).forEach((method) => {
    interceptConsoleMethod(method);
  });
};

installInterceptors();

export const writeServerLog = (level: LogLevel, ...args: unknown[]) => {
  dailyWriter.write(level, args);
};
