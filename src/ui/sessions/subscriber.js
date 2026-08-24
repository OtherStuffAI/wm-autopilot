/**
 * Session Subscriber — SSE client for live session list updates.
 *
 * Connects to /api/sessions/subscribe and triggers a store sync
 * whenever a session is started, stopped, or updated so the home
 * page and navigation reflect changes without a manual reload.
 */

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;
const REFRESH_BACKSTOP_INTERVAL_MS = 15_000;

let eventSource = null;
let reconnectTimer = null;
let refreshTimer = null;
let reconnectAttempts = 0;
let onSessionEvent = null;
let onConnect = null;
let onConnectionStateChange = null;
let lastRefreshAt = 0;

/**
 * Start listening for session lifecycle events.
 *
 * @param {Function} callback — called with the event payload on each
 *   session-started / session-stopped / session-updated event.
 */
export function startSessionSubscriber(callbackOrOptions) {
  stopSessionSubscriber();
  const options = normalizeOptions(callbackOrOptions);
  onSessionEvent = options.onEvent;
  onConnect = options.onConnect;
  onConnectionStateChange = options.onConnectionStateChange;
  startRefreshBackstop();
  connect();
}

/** Stop the subscriber and clean up. */
export function stopSessionSubscriber() {
  onSessionEvent = null;
  onConnect = null;
  onConnectionStateChange = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  reconnectAttempts = 0;
  lastRefreshAt = 0;
}

function connect() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  const source = new EventSource("/api/sessions/subscribe", { withCredentials: true });

  source.onopen = () => {
    console.log("[session-sub] Connected");
    reconnectAttempts = 0;
    markRefresh();
    onConnectionStateChange?.("connected");
    onConnect?.();
  };

  source.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.type && onSessionEvent) {
        markRefresh();
        onSessionEvent(data);
      }
    } catch {
      // ignore non-JSON (keepalive comments won't fire onmessage)
    }
  };

  source.onerror = () => {
    console.warn("[session-sub] Connection lost, scheduling reconnect");
    source.close();
    eventSource = null;
    onConnectionStateChange?.("disconnected");
    requestRefresh("disconnect");
    scheduleReconnect();
  };

  eventSource = source;
}

function markRefresh() {
  lastRefreshAt = Date.now();
}

function requestRefresh(reason) {
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_BACKSTOP_INTERVAL_MS) {
    return;
  }

  markRefresh();
  if (onSessionEvent) {
    onSessionEvent({ type: "session-refresh", reason });
    return;
  }
  onConnect?.();
}

function startRefreshBackstop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  refreshTimer = setInterval(() => {
    if (!onSessionEvent && !onConnect) {
      return;
    }

    const readyState = eventSource?.readyState;
    if (!eventSource || readyState === EventSource.CLOSED) {
      requestRefresh("backstop-disconnected");
      return;
    }

    if (Date.now() - lastRefreshAt >= REFRESH_BACKSTOP_INTERVAL_MS) {
      requestRefresh("backstop-interval");
    }
  }, REFRESH_BACKSTOP_INTERVAL_MS);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (onSessionEvent || onConnect || onConnectionStateChange) {
      connect();
    }
  }, delay);
}

function normalizeOptions(callbackOrOptions) {
  if (typeof callbackOrOptions === "function") {
    return {
      onEvent: callbackOrOptions,
      onConnect: null,
      onConnectionStateChange: null,
    };
  }

  if (callbackOrOptions && typeof callbackOrOptions === "object") {
    return {
      onEvent: typeof callbackOrOptions.onEvent === "function" ? callbackOrOptions.onEvent : null,
      onConnect: typeof callbackOrOptions.onConnect === "function" ? callbackOrOptions.onConnect : null,
      onConnectionStateChange:
        typeof callbackOrOptions.onConnectionStateChange === "function"
          ? callbackOrOptions.onConnectionStateChange
          : null,
    };
  }

  return {
    onEvent: null,
    onConnect: null,
    onConnectionStateChange: null,
  };
}
