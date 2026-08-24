/**
 * API route handlers for private chat feature.
 * Handles CRUD operations and message streaming for chat sessions.
 */

import type { WingmanConfig } from "../config";
import {
  createChatSession,
  getChatSession,
  listChatSessions,
  deleteChatSession,
  updateChatSessionName,
  canAccessChatSession,
  getAvailableModels,
  CHAT_AGENT_TYPE,
} from "../chat/chat-session-manager";
import { messageStore } from "../storage/message-store";
import {
  createChatMessageStreamHandler,
  createChatEventsHandler,
} from "./chat-events";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface ChatApiContext {
  config: WingmanConfig;
  npub: string | null;
  isAdmin: boolean;
  /** Optional callback to record token usage for billing/analytics */
  recordUsage?: (data: { sessionId: string; model: string; inputTokens: number; outputTokens: number }) => Promise<void>;
}

/**
 * Main handler for /api/chats/* routes.
 * Returns null if the route doesn't match, otherwise returns a Response.
 */
export async function handleChatApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  context: ChatApiContext
): Promise<Response | null> {
  const pathname = url.pathname;

  // GET /api/maple/models - List available models
  if (pathname === "/api/maple/models" && method === "GET") {
    return handleGetModels();
  }

  // GET /api/chats - List chats
  if (pathname === "/api/chats" && method === "GET") {
    return handleListChats(context);
  }

  // POST /api/chats - Create chat
  if (pathname === "/api/chats" && method === "POST") {
    return handleCreateChat(request, context);
  }

  // Match /api/chats/:id routes
  const chatIdMatch = pathname.match(/^\/api\/chats\/([^/]+)$/);
  if (chatIdMatch && chatIdMatch[1]) {
    const chatId = chatIdMatch[1];

    if (method === "GET") {
      return handleGetChat(chatId, context);
    }

    if (method === "DELETE") {
      return handleDeleteChat(chatId, context);
    }

    if (method === "PATCH") {
      return handleUpdateChat(chatId, request, context);
    }
  }

  // Match /api/chats/:id/messages
  const messagesMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (messagesMatch && messagesMatch[1]) {
    const chatId = messagesMatch[1];

    if (method === "GET") {
      return handleGetMessages(chatId, context);
    }

    if (method === "POST") {
      return handlePostMessage(chatId, request, context);
    }
  }

  // Match /api/chats/:id/events
  const eventsMatch = pathname.match(/^\/api\/chats\/([^/]+)\/events$/);
  if (eventsMatch && eventsMatch[1] && method === "GET") {
    const chatId = eventsMatch[1];
    return handleChatEventsRoute(chatId, request, context);
  }

  return null;
}

/**
 * GET /api/maple/models
 */
function handleGetModels(): Response {
  const models = getAvailableModels();
  return Response.json({ models });
}

/**
 * GET /api/chats
 */
function handleListChats(context: ChatApiContext): Response {
  const { npub, isAdmin } = context;

  // Admin can see all, non-admin sees only their own
  const filterNpub = isAdmin ? null : npub;
  const chats = listChatSessions(filterNpub);

  return Response.json({
    chats: chats.map((chat) => ({
      id: chat.id,
      name: chat.name,
      model: chat.model,
      npub: chat.npub,
      startedAt: chat.startedAt,
    })),
  });
}

/**
 * POST /api/chats
 */
async function handleCreateChat(
  request: Request,
  context: ChatApiContext
): Promise<Response> {
  const { config, npub } = context;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!payload || typeof payload !== "object") {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { name, model } = payload as Record<string, unknown>;

  const chat = createChatSession(config, npub, {
    name: typeof name === "string" ? name : undefined,
    model: typeof model === "string" ? model : undefined,
  });

  return Response.json({
    chat: {
      id: chat.id,
      name: chat.name,
      model: chat.model,
      npub: chat.npub,
      startedAt: chat.startedAt,
    },
  }, { status: 201 });
}

/**
 * GET /api/chats/:id
 */
function handleGetChat(chatId: string, context: ChatApiContext): Response {
  const { npub, isAdmin } = context;

  const chat = getChatSession(chatId);
  if (!chat) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  if (!canAccessChatSession(chat, npub, isAdmin)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  return Response.json({
    chat: {
      id: chat.id,
      name: chat.name,
      model: chat.model,
      npub: chat.npub,
      startedAt: chat.startedAt,
      messageCount: chat.messages.length,
    },
  });
}

/**
 * DELETE /api/chats/:id
 */
function handleDeleteChat(chatId: string, context: ChatApiContext): Response {
  const { npub, isAdmin } = context;

  const chat = getChatSession(chatId);
  if (!chat) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  if (!canAccessChatSession(chat, npub, isAdmin)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const deleted = deleteChatSession(chatId);
  if (!deleted) {
    return Response.json({ error: "Failed to delete chat" }, { status: 500 });
  }

  return Response.json({ deleted: true });
}

/**
 * PATCH /api/chats/:id
 */
async function handleUpdateChat(
  chatId: string,
  request: Request,
  context: ChatApiContext
): Promise<Response> {
  const { npub, isAdmin } = context;

  const chat = getChatSession(chatId);
  if (!chat) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  if (!canAccessChatSession(chat, npub, isAdmin)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!payload || typeof payload !== "object") {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { name } = payload as Record<string, unknown>;

  if (typeof name === "string") {
    const updated = updateChatSessionName(chatId, name);
    if (!updated) {
      return Response.json({ error: "Failed to update chat" }, { status: 500 });
    }
  }

  const updatedChat = getChatSession(chatId);
  return Response.json({
    chat: {
      id: updatedChat?.id,
      name: updatedChat?.name,
      model: updatedChat?.model,
      npub: updatedChat?.npub,
      startedAt: updatedChat?.startedAt,
    },
  });
}

/**
 * GET /api/chats/:id/messages
 */
function handleGetMessages(chatId: string, context: ChatApiContext): Response {
  const { npub, isAdmin } = context;

  const chat = getChatSession(chatId);
  if (!chat) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  if (!canAccessChatSession(chat, npub, isAdmin)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  return Response.json({
    messages: chat.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
  });
}

/**
 * POST /api/chats/:id/messages
 * Streams the response via SSE.
 */
async function handlePostMessage(
  chatId: string,
  request: Request,
  context: ChatApiContext
): Promise<Response> {
  const { config, npub, isAdmin } = context;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!payload || typeof payload !== "object") {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { content } = payload as Record<string, unknown>;

  if (typeof content !== "string" || content.trim().length === 0) {
    return Response.json({ error: "Content is required" }, { status: 400 });
  }

  // Create the stream handler and invoke it
  const handler = createChatMessageStreamHandler({
    config,
    sseKeepaliveIntervalMs: config.sseKeepaliveIntervalMs,
    recordUsage: context.recordUsage,
  });

  return handler(chatId, content.trim(), npub, isAdmin, request);
}

/**
 * GET /api/chats/:id/events
 * SSE endpoint for real-time updates.
 */
async function handleChatEventsRoute(
  chatId: string,
  request: Request,
  context: ChatApiContext
): Promise<Response> {
  const { config, npub, isAdmin } = context;

  const handler = createChatEventsHandler({
    config,
    sseKeepaliveIntervalMs: config.sseKeepaliveIntervalMs,
  });

  return handler(chatId, npub, isAdmin, request);
}
