/**
 * Visibility Manager for tab visibility changes.
 * Handles SSE reconnection when returning to a hidden tab.
 */

/** Time hidden before forcing reconnect (1 minute) */
const STALE_THRESHOLD_MS = 60000;

/**
 * Manages tab visibility and triggers SSE reconnection when needed.
 */
class VisibilityManager {
  constructor() {
    /** @type {number|null} Timestamp when tab became hidden */
    this.hiddenAt = null;
    /** @type {boolean} Whether manager is initialized */
    this.initialized = false;
    /** @type {Set<Function>} Visibility change listeners */
    this.listeners = new Set();
    /** @type {Function|null} Callback to get current session ID */
    this.getSessionId = null;
    /** @type {Function|null} Callback to check connection health */
    this.checkHealth = null;
    /** @type {Function|null} Callback to reconnect SSE */
    this.reconnect = null;

    this._handleVisibilityChange = this._handleVisibilityChange.bind(this);
  }

  /**
   * Initialize the visibility manager.
   * @param {Object} options
   * @param {Function} options.getSessionId - Returns current active session ID
   * @param {Function} options.checkHealth - Returns true if connection is healthy
   * @param {Function} options.reconnect - Reconnects SSE for a session
   */
  init(options) {
    if (this.initialized) {
      console.warn("[visibility] Already initialized");
      return;
    }

    this.getSessionId = options.getSessionId;
    this.checkHealth = options.checkHealth;
    this.reconnect = options.reconnect;

    document.addEventListener("visibilitychange", this._handleVisibilityChange);
    this.initialized = true;
    console.log("[visibility] Manager initialized");
  }

  /**
   * Clean up the visibility manager.
   */
  destroy() {
    if (!this.initialized) return;

    document.removeEventListener("visibilitychange", this._handleVisibilityChange);
    this.listeners.clear();
    this.hiddenAt = null;
    this.initialized = false;
    console.log("[visibility] Manager destroyed");
  }

  /**
   * Handle visibility change event.
   * @private
   */
  _handleVisibilityChange() {
    const isVisible = document.visibilityState === "visible";

    if (!isVisible) {
      // Tab is now hidden - record the time
      this.hiddenAt = Date.now();
      this._notifyListeners(false);
      return;
    }

    // Tab is now visible
    const hiddenDuration = this.getHiddenDuration();
    this.hiddenAt = null;

    this._notifyListeners(true);

    // Check if we need to reconnect
    if (hiddenDuration > STALE_THRESHOLD_MS) {
      this._checkAndReconnect(hiddenDuration);
    }
  }

  /**
   * Check connection health and reconnect if needed.
   * @param {number} hiddenDuration - How long the tab was hidden (ms)
   * @private
   */
  _checkAndReconnect(hiddenDuration) {
    const sessionId = this.getSessionId?.();
    if (!sessionId) {
      console.log("[visibility] No active session, skipping reconnect check");
      return;
    }

    const isHealthy = this.checkHealth?.(sessionId) ?? true;
    if (!isHealthy) {
      console.log(`[visibility] Force reconnecting session ${sessionId} after ${Math.round(hiddenDuration / 1000)}s hidden`);
      this.reconnect?.(sessionId);
    } else {
      console.log(`[visibility] Connection healthy for ${sessionId}, no reconnect needed`);
    }
  }

  /**
   * Notify all listeners of visibility change.
   * @param {boolean} isVisible
   * @private
   */
  _notifyListeners(isVisible) {
    for (const listener of this.listeners) {
      try {
        listener(isVisible);
      } catch (err) {
        console.warn("[visibility] Listener error:", err);
      }
    }
  }

  /**
   * Check if the tab is currently visible.
   * @returns {boolean}
   */
  isVisible() {
    return document.visibilityState === "visible";
  }

  /**
   * Get how long the tab has been hidden (0 if visible).
   * @returns {number} Duration in milliseconds
   */
  getHiddenDuration() {
    if (this.hiddenAt === null) return 0;
    return Date.now() - this.hiddenAt;
  }

  /**
   * Subscribe to visibility changes.
   * @param {Function} callback - Called with (isVisible: boolean)
   * @returns {Function} Unsubscribe function
   */
  onVisibilityChange(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
}

// Export singleton instance
export const visibilityManager = new VisibilityManager();
