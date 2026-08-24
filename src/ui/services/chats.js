/**
 * Chat API client - HTTP wrappers for private chat endpoints.
 * These functions handle HTTP requests and return parsed data.
 */

/**
 * Fetches available Maple Proxy models.
 * @returns {Promise<{models: string[]} | null>}
 */
export async function fetchModelsApi() {
  const response = await fetch("/api/maple/models");
  if (!response.ok) {
    console.error("Failed to load models:", response.status, response.statusText);
    return null;
  }
  return response.json();
}

/**
 * Fetches all chat sessions for the current user.
 * @returns {Promise<{chats: Array} | null>}
 */
export async function fetchChatsApi() {
  const response = await fetch("/api/chats");

  if (response.status === 401) {
    return { unauthorized: true, chats: [] };
  }

  if (!response.ok) {
    console.error("Failed to load chats:", response.status, response.statusText);
    return null;
  }

  return response.json();
}

/**
 * Creates a new chat session.
 * @param {string} [name] - Optional chat name
 * @param {string} [model] - Optional model selection
 * @returns {Promise<{chat: Object} | null>}
 */
export async function createChatApi(name, model) {
  const body = {};
  if (name) body.name = name;
  if (model) body.model = model;

  const response = await fetch("/api/chats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    console.error("Failed to create chat:", data.error || response.statusText);
    return null;
  }

  return response.json();
}

/**
 * Fetches a single chat by ID.
 * @param {string} chatId - The chat ID
 * @returns {Promise<{chat: Object} | null>}
 */
export async function fetchChatApi(chatId) {
  const response = await fetch(`/api/chats/${chatId}`);
  if (!response.ok) return null;
  return response.json();
}

/**
 * Deletes a chat session.
 * @param {string} chatId - The chat ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function deleteChatApi(chatId) {
  const response = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { success: false, error: data.error || response.statusText };
  }
  return { success: true };
}

/**
 * Updates a chat session's name.
 * @param {string} chatId - The chat ID
 * @param {string} name - The new name
 * @returns {Promise<{chat: Object} | null>}
 */
export async function updateChatNameApi(chatId, name) {
  const response = await fetch(`/api/chats/${chatId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || response.statusText || "Failed to update chat");
  }

  return response.json();
}

/**
 * Fetches message history for a chat.
 * @param {string} chatId - The chat ID
 * @returns {Promise<{messages: Array} | null>}
 */
export async function fetchChatMessagesApi(chatId) {
  const response = await fetch(`/api/chats/${chatId}/messages`);
  if (!response.ok) return null;
  return response.json();
}

/**
 * Posts a message to a chat.
 * Returns a ReadableStream for SSE responses.
 * @param {string} chatId - The chat ID
 * @param {string} content - Message content
 * @returns {Promise<Response>}
 */
export async function postChatMessageApi(chatId, content) {
  const response = await fetch(`/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || response.statusText || "Failed to send message");
  }

  // Response is SSE stream
  return response;
}
