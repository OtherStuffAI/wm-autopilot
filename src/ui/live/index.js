/**
 * Live module entry point.
 * Provides real-time session updates via SSE with Dexie persistence.
 */

export { db, MessageStore, PermissionStore, PromptQueueStore, SessionStore, DbUtils, Dexie } from "./db.js";
export { sseManager } from "./sse-manager.js";
export { visibilityManager } from "./visibility-manager.js";
export { attachWorkingNotesToggle } from "./working-notes-toggle.js";
export {
  isAlpineChatEnabled,
  enableAlpineChat,
  disableAlpineChat,
  initAlpineChat,
  getChatTemplate,
  registerChatComponent,
  configureLiveChatFeatures,
  Alpine,
} from "./chat-component.js";

// Module initialization state
let initialized = false;
let initPromise = null;

/**
 * Initialize the live module.
 * Opens the Dexie database and prepares for SSE connections.
 * Safe to call multiple times - will only initialize once.
 * @returns {Promise<void>}
 */
export async function initLiveModule() {
  if (initialized) {
    return;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      // Database opens automatically on first use, but we can ensure it's ready
      const { db } = await import("./db.js");
      await db.open();
      initialized = true;
      console.log("[live] Module initialized");
    } catch (error) {
      console.error("[live] Failed to initialize module:", error);
      initPromise = null;
      throw error;
    }
  })();

  return initPromise;
}

/**
 * Check if the live module is initialized.
 * @returns {boolean}
 */
export function isLiveModuleInitialized() {
  return initialized;
}

/**
 * Setup live updates for a session.
 * Connects SSE and syncs messages to Dexie.
 * @param {string} sessionId
 * @param {Object} options
 * @param {Function} [options.onMessage] - Called when new message received
 * @param {Function} [options.onStatus] - Called when status changes
 * @returns {Function} Cleanup function
 */
export function setupLiveSession(sessionId, options = {}) {
  const { sseManager } = require("./sse-manager.js");

  // Subscribe to events
  const unsubscribers = [];

  if (options.onMessage) {
    unsubscribers.push(sseManager.onMessage((sid, msg) => {
      if (sid === sessionId) {
        options.onMessage(msg);
      }
    }));
  }

  if (options.onStatus) {
    unsubscribers.push(sseManager.onStatusChange((sid, status) => {
      if (sid === sessionId) {
        options.onStatus(status);
      }
    }));
  }

  // Connect SSE
  sseManager.connect(sessionId);

  // Return cleanup function
  return () => {
    unsubscribers.forEach((unsub) => unsub());
    sseManager.disconnect(sessionId);
  };
}
