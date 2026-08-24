const METHODS = ["log", "info", "warn", "error", "debug", "trace"];
const ORIGINAL_METHODS = new Map();

const MAX_QUEUE_SIZE = 50;
const FLUSH_INTERVAL_MS = 2000;
const ENDPOINT = "/api/logs/browser";

const queue = [];
let flushTimer = null;
let installed = false;

const serialiseValue = (value) => {
  if (value instanceof Error) {
    return value.stack || `${value.name || "Error"}: ${value.message || "Unknown error"}`;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "undefined" || value === null) {
    return String(value);
  }
  if (typeof value === "function") {
    return `[function ${value.name || "anonymous"}]`;
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserialisable value]";
  }
};

const sendBatch = async (batch) => {
  const payload = {
    entries: batch,
  };
  const body = JSON.stringify(payload);
  if (navigator.sendBeacon) {
    try {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(ENDPOINT, blob)) {
        return;
      }
    } catch {
      // ignore sendBeacon errors and fallback to fetch
    }
  }
  try {
    await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body,
      credentials: "include",
      keepalive: true,
    });
  } catch {
    // Ignore network errors; console output still appears locally.
  }
};

const flushQueue = async () => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) {
    return;
  }
  const batch = queue.splice(0, queue.length);
  await sendBatch(batch);
};

const scheduleFlush = () => {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    void flushQueue();
  }, FLUSH_INTERVAL_MS);
};

const capture = (method, args) => {
  const entry = {
    level: method,
    messages: Array.from(args).map(serialiseValue),
    timestamp: new Date().toISOString(),
    location: window.location.href,
  };
  queue.push(entry);
  if (queue.length >= MAX_QUEUE_SIZE) {
    void flushQueue();
  } else {
    scheduleFlush();
  }
};

const wrapConsole = (method) => {
  const original = console[method];
  if (typeof original !== "function") {
    return;
  }
  if (!ORIGINAL_METHODS.has(method)) {
    ORIGINAL_METHODS.set(method, original.bind(console));
  }
  console[method] = (...args) => {
    capture(method, args);
    ORIGINAL_METHODS.get(method)?.(...args);
  };
};

const install = () => {
  if (installed) {
    return;
  }
  installed = true;
  METHODS.forEach((method) => {
    wrapConsole(method);
  });
  if (typeof window !== "undefined") {
    window.addEventListener(
      "beforeunload",
      () => {
        if (queue.length === 0) {
          return;
        }
        const batch = queue.splice(0, queue.length);
        const payload = {
          entries: batch,
        };
        try {
          const body = JSON.stringify(payload);
          if (navigator.sendBeacon) {
            const blob = new Blob([body], { type: "application/json" });
            navigator.sendBeacon(ENDPOINT, blob);
          }
        } catch {
          // Swallow errors so unload is not blocked.
        }
      },
      { passive: true },
    );
  }
};

install();
