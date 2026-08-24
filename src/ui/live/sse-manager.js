/**
 * SSE Manager for live session events.
 * Manages EventSource connections with automatic reconnection.
 */

import { MessageStore, PermissionStore, SessionStore } from "./db.js";
import { normalizeRuntimeStatus } from "./session-status-cache.js";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
/** No-event threshold for considering connection unhealthy (90s) */
const HEALTH_CHECK_STALE_MS = 90000;
const STREAM_MODE_UNKNOWN = "unknown";
const STREAM_MODE_EVENT_STREAM = "event-stream";
const STREAM_MODE_HEARTBEAT_ONLY = "heartbeat-only";
const STREAM_MODE_DEGRADED = "degraded";

/**
 * Manages SSE connections to session event streams.
 */
class SSEManager {
  constructor() {
    /** @type {Map<string, EventSource>} Active connections by sessionId */
    this.connections = new Map();
    /** @type {Map<string, number>} Reconnect timers by sessionId */
    this.reconnectTimers = new Map();
    /** @type {Map<string, number>} Reconnect attempt counts by sessionId */
    this.reconnectAttempts = new Map();
    /** @type {Map<string, number>} Last event timestamp by sessionId */
    this.lastEventTime = new Map();
    /** @type {Set<Function>} Status change listeners */
    this.statusListeners = new Set();
    /** @type {Set<Function>} Message listeners */
    this.messageListeners = new Set();
    /** @type {Set<Function>} Connection state listeners */
    this.connectionListeners = new Set();
    /** @type {Map<string, string>} Stream mode by sessionId */
    this.streamModes = new Map();
    /** @type {Set<Function>} Stream mode listeners */
    this.streamModeListeners = new Set();
    /** @type {Set<Function>} Durable message refresh listeners */
    this.refreshListeners = new Set();
  }

  /**
   * Connect to a session's event stream.
   * @param {string} sessionId
   */
  connect(sessionId) {
    // Already connected
    if (this.connections.has(sessionId)) {
      const existing = this.connections.get(sessionId);
      if (existing.readyState !== EventSource.CLOSED) {
        return;
      }
    }

    // Clear any pending reconnect
    this.clearReconnectTimer(sessionId);
    this.setStreamMode(sessionId, STREAM_MODE_UNKNOWN);

    const url = `/api/sessions/${sessionId}/events`;

    try {
      const source = new EventSource(url, { withCredentials: true });

      source.onopen = () => {
        console.log(`[sse] Connected to session ${sessionId}`);
        this.reconnectAttempts.set(sessionId, 0);
        this.lastEventTime.set(sessionId, Date.now());
        this.notifyConnectionListeners(sessionId, "connected");
      };

      source.onerror = (event) => {
        console.warn(`[sse] Connection error for session ${sessionId}`, event);
        this.handleConnectionError(sessionId);
      };

      // EventSource dispatches both unnamed/default events and explicit
      // `event: message` frames to the "message" event type. Register one
      // listener only: combining onmessage with addEventListener("message")
      // delivers every message twice and races IndexedDB reconciliation.
      source.addEventListener("message", async (event) => {
        try {
          this.lastEventTime.set(sessionId, Date.now());
          console.log(`[sse] message event for ${sessionId}:`, event.data?.slice(0, 100));
          const data = JSON.parse(event.data);
          if (data.type === "message" || data.role) {
            this.setStreamMode(sessionId, STREAM_MODE_EVENT_STREAM);
            const result = await MessageStore.upsertMessage(sessionId, data);
            this.notifyMessageListeners(sessionId, data, result);
          }
        } catch (err) {
          console.warn("[sse] Failed to process message event:", err);
        }
      });

      source.addEventListener("status", async (event) => {
        try {
          this.lastEventTime.set(sessionId, Date.now());
          const data = JSON.parse(event.data);
          if (data.type === "upstream_unavailable" || data.type === "upstream_error") {
            this.setStreamMode(sessionId, STREAM_MODE_DEGRADED);
            return;
          }

          if (data.type === "session_stopped") {
            await SessionStore.patchSession(sessionId, {
              status: "stopped",
              agentRuntimeStatus: null,
            });
            this.notifyStatusListeners(sessionId, null);
            return;
          }

          const status = normalizeRuntimeStatus(data.agent_status ?? data.status);
          if (status) {
            this.setStreamMode(sessionId, STREAM_MODE_EVENT_STREAM);
            await SessionStore.updateStatus(sessionId, status, status);
            this.notifyStatusListeners(sessionId, status);
          }
        } catch (err) {
          console.warn("[sse] Failed to process status event:", err);
        }
      });

      source.addEventListener("permission", async (event) => {
        try {
          this.lastEventTime.set(sessionId, Date.now());
          const data = JSON.parse(event.data);
          await PermissionStore.upsert(sessionId, data);
        } catch (err) {
          console.warn("[sse] Failed to process permission event:", err);
        }
      });

      source.addEventListener("transport", (event) => {
        try {
          this.lastEventTime.set(sessionId, Date.now());
          const data = JSON.parse(event.data);
          this.setStreamMode(sessionId, this.normalizeStreamMode(data.mode));
        } catch (err) {
          console.warn("[sse] Failed to process transport event:", err);
        }
      });

      source.addEventListener("heartbeat", () => {
        this.lastEventTime.set(sessionId, Date.now());
      });

      source.addEventListener("refresh", (event) => {
        this.lastEventTime.set(sessionId, Date.now());
        let data = {};
        try {
          data = JSON.parse(event.data);
        } catch {}
        this.notifyRefreshListeners(sessionId, data);
      });

      source.addEventListener("error", async (event) => {
        try {
          const data = JSON.parse(event.data);
          console.error(`[sse] Error event for session ${sessionId}:`, data);
        } catch {
          // Ignore parse errors for error events
        }
      });

      this.connections.set(sessionId, source);
    } catch (error) {
      console.error(`[sse] Failed to create EventSource for ${sessionId}:`, error);
      this.scheduleReconnect(sessionId);
    }
  }

  /**
   * Handle event data from SSE stream.
   * @param {string} sessionId
   * @param {Object} data
   */
  async handleEventData(sessionId, data) {
    // Handle message events
    if (data.type === "message" || data.role || data.content) {
      this.setStreamMode(sessionId, STREAM_MODE_EVENT_STREAM);
      const result = await MessageStore.upsertMessage(sessionId, data);
      this.notifyMessageListeners(sessionId, data, result);
    }

    // Handle status events
    const status = normalizeRuntimeStatus(data.agent_status ?? data.status);
    if (status) {
      this.setStreamMode(sessionId, STREAM_MODE_EVENT_STREAM);
      await SessionStore.updateStatus(sessionId, status, status);
      this.notifyStatusListeners(sessionId, status);
    }

    if (data.type === "permission") {
      await PermissionStore.upsert(sessionId, data);
    }
  }

  /**
   * Disconnect from a session's event stream.
   * @param {string} sessionId
   */
  disconnect(sessionId) {
    const source = this.connections.get(sessionId);
    if (source) {
      source.close();
      this.connections.delete(sessionId);
      this.notifyConnectionListeners(sessionId, "disconnected");
    }
    this.clearReconnectTimer(sessionId);
    this.reconnectAttempts.delete(sessionId);
    this.lastEventTime.delete(sessionId);
    this.streamModes.delete(sessionId);
  }

  /**
   * Disconnect all active connections.
   */
  disconnectAll() {
    for (const sessionId of this.connections.keys()) {
      this.disconnect(sessionId);
    }
  }

  /**
   * Handle connection error - disconnect and schedule reconnect.
   * @param {string} sessionId
   */
  handleConnectionError(sessionId) {
    const source = this.connections.get(sessionId);
    if (source) {
      source.close();
      this.connections.delete(sessionId);
    }
    this.setStreamMode(sessionId, STREAM_MODE_DEGRADED);
    this.notifyConnectionListeners(sessionId, "error");
    this.scheduleReconnect(sessionId);
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   * @param {string} sessionId
   */
  scheduleReconnect(sessionId) {
    const attempts = this.reconnectAttempts.get(sessionId) || 0;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempts), RECONNECT_MAX_MS);

    console.log(`[sse] Scheduling reconnect for ${sessionId} in ${delay}ms (attempt ${attempts + 1})`);

    const timerId = window.setTimeout(() => {
      this.reconnectTimers.delete(sessionId);
      this.reconnectAttempts.set(sessionId, attempts + 1);
      this.connect(sessionId);
    }, delay);

    this.reconnectTimers.set(sessionId, timerId);
  }

  /**
   * Clear any pending reconnect timer.
   * @param {string} sessionId
   */
  clearReconnectTimer(sessionId) {
    const timerId = this.reconnectTimers.get(sessionId);
    if (timerId) {
      window.clearTimeout(timerId);
      this.reconnectTimers.delete(sessionId);
    }
  }

  /**
   * Check if connected to a session.
   * @param {string} sessionId
   * @returns {boolean}
   */
  isConnected(sessionId) {
    const source = this.connections.get(sessionId);
    return source && source.readyState === EventSource.OPEN;
  }

  /**
   * Get connection state for a session.
   * @param {string} sessionId
   * @returns {"connected" | "connecting" | "disconnected"}
   */
  getConnectionState(sessionId) {
    const source = this.connections.get(sessionId);
    if (!source) return "disconnected";
    switch (source.readyState) {
      case EventSource.CONNECTING:
        return "connecting";
      case EventSource.OPEN:
        return "connected";
      default:
        return "disconnected";
    }
  }

  normalizeStreamMode(mode) {
    switch (mode) {
      case STREAM_MODE_EVENT_STREAM:
        return STREAM_MODE_EVENT_STREAM;
      case STREAM_MODE_HEARTBEAT_ONLY:
        return STREAM_MODE_HEARTBEAT_ONLY;
      case STREAM_MODE_DEGRADED:
        return STREAM_MODE_DEGRADED;
      default:
        return STREAM_MODE_UNKNOWN;
    }
  }

  setStreamMode(sessionId, mode) {
    const normalized = this.normalizeStreamMode(mode);
    const previous = this.streamModes.get(sessionId) || STREAM_MODE_UNKNOWN;
    if (previous === normalized) {
      return;
    }
    this.streamModes.set(sessionId, normalized);
    this.notifyStreamModeListeners(sessionId, normalized);
  }

  getStreamMode(sessionId) {
    return this.streamModes.get(sessionId) || STREAM_MODE_UNKNOWN;
  }

  /**
   * Check if a connection is healthy (received events recently).
   * @param {string} sessionId
   * @returns {boolean} True if healthy, false if stale or disconnected
   */
  isConnectionHealthy(sessionId) {
    const state = this.getConnectionState(sessionId);
    if (state !== "connected") {
      return false;
    }

    const lastEvent = this.lastEventTime.get(sessionId);
    if (!lastEvent) {
      // No events recorded yet - consider unhealthy
      return false;
    }

    const elapsed = Date.now() - lastEvent;
    return elapsed < HEALTH_CHECK_STALE_MS;
  }

  /**
   * Force reconnect to a session's event stream.
   * Disconnects if connected, then reconnects.
   * @param {string} sessionId
   */
  reconnect(sessionId) {
    console.log(`[sse] Force reconnecting session ${sessionId}`);
    this.disconnect(sessionId);
    this.connect(sessionId);
  }

  /**
   * Subscribe to status changes.
   * @param {Function} callback - Called with (sessionId, status)
   * @returns {Function} Unsubscribe function
   */
  onStatusChange(callback) {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  /**
   * Subscribe to message events.
   * @param {Function} callback - Called with (sessionId, message, meta)
   * @returns {Function} Unsubscribe function
   */
  onMessage(callback) {
    this.messageListeners.add(callback);
    return () => this.messageListeners.delete(callback);
  }

  /**
   * Subscribe to connection state changes.
   * @param {Function} callback - Called with (sessionId, state)
   * @returns {Function} Unsubscribe function
   */
  onConnectionChange(callback) {
    this.connectionListeners.add(callback);
    return () => this.connectionListeners.delete(callback);
  }

  onStreamModeChange(callback) {
    this.streamModeListeners.add(callback);
    return () => this.streamModeListeners.delete(callback);
  }

  onRefresh(callback) {
    this.refreshListeners.add(callback);
    return () => this.refreshListeners.delete(callback);
  }

  /**
   * Notify status listeners.
   * @param {string} sessionId
   * @param {string} status
   */
  notifyStatusListeners(sessionId, status) {
    for (const listener of this.statusListeners) {
      try {
        listener(sessionId, status);
      } catch (err) {
        console.warn("[sse] Status listener error:", err);
      }
    }
  }

  /**
   * Notify message listeners.
   * @param {string} sessionId
   * @param {Object} message
   * @param {Object} meta
   */
  notifyMessageListeners(sessionId, message, meta = {}) {
    for (const listener of this.messageListeners) {
      try {
        listener(sessionId, message, meta);
      } catch (err) {
        console.warn("[sse] Message listener error:", err);
      }
    }
  }

  /**
   * Notify connection listeners.
   * @param {string} sessionId
   * @param {string} state
   */
  notifyConnectionListeners(sessionId, state) {
    for (const listener of this.connectionListeners) {
      try {
        listener(sessionId, state);
      } catch (err) {
        console.warn("[sse] Connection listener error:", err);
      }
    }
  }

  notifyStreamModeListeners(sessionId, mode) {
    for (const listener of this.streamModeListeners) {
      try {
        listener(sessionId, mode);
      } catch (err) {
        console.warn("[sse] Stream mode listener error:", err);
      }
    }
  }

  notifyRefreshListeners(sessionId, data) {
    for (const listener of this.refreshListeners) {
      try {
        listener(sessionId, data);
      } catch (err) {
        console.warn("[sse] Refresh listener error:", err);
      }
    }
  }
}

// Export singleton instance
export const sseManager = new SSEManager();
