/**
 * SSE Manager for private chat message streaming.
 * Manages streaming responses from the chat message endpoint.
 */

/**
 * Parses an SSE line and extracts the data.
 * @param {string} line - Raw SSE line
 * @returns {Object|null} Parsed event data or null
 */
function parseSSELine(line) {
  const trimmed = line.trim();

  // Skip empty lines and comments
  if (!trimmed || trimmed.startsWith(":")) {
    return null;
  }

  // Handle [DONE] signal
  if (trimmed === "data: [DONE]") {
    return { type: "done" };
  }

  // Parse data lines
  if (trimmed.startsWith("data: ")) {
    try {
      return JSON.parse(trimmed.slice(6));
    } catch (err) {
      console.warn("[chat-sse] Failed to parse SSE data:", trimmed, err);
      return null;
    }
  }

  return null;
}

/**
 * Streams a chat message response from the server.
 * Yields parsed events as they arrive.
 *
 * @param {Response} response - Fetch response with SSE body
 * @yields {{type: "chunk"|"done"|"error", content?: string, messageId?: string}}
 */
export async function* streamChatResponse(response) {
  if (!response.body) {
    yield { type: "error", content: "No response body" };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");

      // Keep the last incomplete line in the buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        const event = parseSSELine(line);
        if (event) {
          yield event;

          // Stop processing if we get a done or error event
          if (event.type === "done" || event.type === "error") {
            return;
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const event = parseSSELine(buffer);
      if (event) {
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Chat SSE Manager class for managing chat event subscriptions.
 */
class ChatSSEManager {
  constructor() {
    /** @type {Map<string, EventSource>} Active event subscriptions by chatId */
    this.connections = new Map();
    /** @type {Set<Function>} Event listeners */
    this.listeners = new Set();
  }

  /**
   * Subscribe to chat events (general updates, not message streaming).
   * @param {string} chatId - The chat ID
   */
  subscribe(chatId) {
    if (this.connections.has(chatId)) {
      const existing = this.connections.get(chatId);
      if (existing.readyState !== EventSource.CLOSED) {
        return;
      }
    }

    const url = `/api/chats/${chatId}/events`;

    try {
      const source = new EventSource(url, { withCredentials: true });

      source.onopen = () => {
        console.log(`[chat-sse] Connected to chat ${chatId}`);
        this.notify(chatId, "connected", null);
      };

      source.onerror = () => {
        console.warn(`[chat-sse] Connection error for chat ${chatId}`);
        this.notify(chatId, "error", null);
      };

      source.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.notify(chatId, data.type || "message", data);
        } catch (err) {
          console.warn("[chat-sse] Failed to parse event:", err);
        }
      };

      this.connections.set(chatId, source);
    } catch (error) {
      console.error(`[chat-sse] Failed to create EventSource for ${chatId}:`, error);
    }
  }

  /**
   * Unsubscribe from chat events.
   * @param {string} chatId - The chat ID
   */
  unsubscribe(chatId) {
    const source = this.connections.get(chatId);
    if (source) {
      source.close();
      this.connections.delete(chatId);
    }
  }

  /**
   * Unsubscribe from all chat events.
   */
  unsubscribeAll() {
    for (const chatId of this.connections.keys()) {
      this.unsubscribe(chatId);
    }
  }

  /**
   * Add an event listener.
   * @param {Function} callback - Called with (chatId, eventType, data)
   * @returns {Function} Unsubscribe function
   */
  onEvent(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Notify all listeners of an event.
   * @param {string} chatId
   * @param {string} eventType
   * @param {Object|null} data
   */
  notify(chatId, eventType, data) {
    for (const listener of this.listeners) {
      try {
        listener(chatId, eventType, data);
      } catch (err) {
        console.warn("[chat-sse] Listener error:", err);
      }
    }
  }

  /**
   * Check if connected to a chat.
   * @param {string} chatId
   * @returns {boolean}
   */
  isConnected(chatId) {
    const source = this.connections.get(chatId);
    return source && source.readyState === EventSource.OPEN;
  }
}

// Export singleton instance
export const chatSSEManager = new ChatSSEManager();
