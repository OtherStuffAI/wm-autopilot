import type { RequestAuthContext } from "../auth/request-context";
import type { LogLevel } from "./daily-log-writer";
import { writeServerLog } from "./server-logger";

interface BrowserLogEntry {
  level?: string;
  messages?: unknown[];
  timestamp?: string;
}

const PATHNAME = "/api/logs/browser";

const methodMap: Record<string, LogLevel> = {
  log: "INFO",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
  debug: "DEBUG",
  trace: "TRACE",
};

const normaliseLevel = (value: unknown): LogLevel => {
  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (methodMap[normalised]) {
      return methodMap[normalised];
    }
  }
  return "INFO";
};

const serialiseMessage = (value: unknown): string => {
  if (value instanceof Error) {
    return value.stack ?? value.message ?? value.name ?? "Error";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserialisable object]";
    }
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  return "[unknown]";
};

const parseEntries = async (request: Request): Promise<BrowserLogEntry[]> => {
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const entries = Array.isArray((payload as { entries?: unknown }).entries)
    ? ((payload as { entries: unknown[] }).entries as BrowserLogEntry[])
    : [];
  return entries;
};

export const createBrowserLogHandler = () => {
  return async (
    request: Request,
    url: URL,
    method: string,
    authContext: RequestAuthContext,
  ): Promise<Response | null> => {
    if (url.pathname !== PATHNAME) {
      return null;
    }

    if (method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    if (!authContext.npub) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const entries = await parseEntries(request);
    if (entries.length === 0) {
      return Response.json({ error: "No log entries provided" }, { status: 400 });
    }

    const context = {
      npub: authContext.npub,
      userAgent: request.headers.get("user-agent") ?? "unknown",
      origin: request.headers.get("origin") ?? "unknown",
    };

    entries.forEach((entry) => {
      const level = normaliseLevel(entry.level);
      const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;
      const messages = Array.isArray(entry.messages) ? entry.messages.map(serialiseMessage) : [];
      const prefix = `[browser][${context.npub}]`;
      const suffix = timestamp ? ` (client:${timestamp})` : "";
      if (messages.length === 0) {
        writeServerLog(level, `${prefix} ${suffix}`.trim());
      } else {
        writeServerLog(level, `${prefix}${suffix ? ` ${suffix}` : ""}`, ...messages);
      }
    });

    return Response.json({ ok: true });
  };
};
