/**
 * Chat module entry point.
 * Exports components and utilities for private chat functionality.
 */

export { chatSSEManager, streamChatResponse } from "./chat-sse-manager.js";
export { createChatDialogController } from "./chat-dialog.js";
export {
  fetchModelsApi,
  fetchChatsApi,
  createChatApi,
  fetchChatApi,
  deleteChatApi,
  updateChatNameApi,
  fetchChatMessagesApi,
  postChatMessageApi,
} from "../services/chats.js";

/** Chat route prefix */
export const CHAT_ROUTE_PREFIX = "/chat";

/**
 * Extracts chat ID from pathname.
 * @param {string} pathname - Current pathname
 * @returns {string|null} Chat ID or null
 */
export function getChatIdFromPath(pathname) {
  if (!pathname.startsWith(CHAT_ROUTE_PREFIX)) {
    return null;
  }
  if (pathname === CHAT_ROUTE_PREFIX) {
    return null;
  }
  const segments = pathname.slice(CHAT_ROUTE_PREFIX.length + 1).split("/").filter(Boolean);
  return segments[0] || null;
}

/**
 * Builds a chat URL.
 * @param {string} [chatId] - Optional chat ID
 * @returns {string} Chat URL
 */
export function buildChatUrl(chatId) {
  if (chatId) {
    return `${CHAT_ROUTE_PREFIX}/${chatId}`;
  }
  return CHAT_ROUTE_PREFIX;
}

/**
 * Checks if current route is a chat route.
 * @param {string} pathname - Current pathname
 * @returns {boolean}
 */
export function isChatRoute(pathname) {
  return pathname === CHAT_ROUTE_PREFIX || pathname.startsWith(`${CHAT_ROUTE_PREFIX}/`);
}
