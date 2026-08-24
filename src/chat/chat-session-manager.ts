/**
 * Chat session manager for private AI conversations.
 * Manages chat sessions without spawning agent subprocesses.
 */

import { randomUUID } from "node:crypto";
import type { WingmanConfig } from "../config";
import { messageStore, type StoredMessage, type StoredSessionRecord } from "../storage/message-store";
import {
  createMapleClient,
  streamChatCompletion,
  type ChatMessage,
  type MapleClientOptions,
  MAPLE_MODELS,
} from "./maple-client";

/** Agent type used for private chat sessions */
export const CHAT_AGENT_TYPE = "chat";

export interface ChatSession {
  id: string;
  name: string;
  model: string;
  npub: string | null;
  startedAt: string;
  messages: StoredMessage[];
}

export interface CreateChatOptions {
  name?: string;
  model?: string;
}

/**
 * Creates a new chat session stored in the message store.
 */
export function createChatSession(
  config: WingmanConfig,
  npub: string | null,
  options: CreateChatOptions = {}
): ChatSession {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const name = options.name?.trim() || `Chat ${new Date().toLocaleString()}`;
  const model = options.model || config.mapleDefaultModel;

  // Store session in database
  messageStore.recordSession({
    id,
    agent: CHAT_AGENT_TYPE,
    startedAt,
    name,
    npub: npub ?? undefined,
    model,
    metadata: { AGENT: false, billingMode: "subscription" },
  });

  return {
    id,
    name,
    model,
    npub,
    startedAt,
    messages: [],
  };
}

/**
 * Retrieves a chat session by ID.
 */
export function getChatSession(sessionId: string): ChatSession | null {
  const stored = messageStore.getSession(sessionId);
  if (!stored || stored.agent !== CHAT_AGENT_TYPE) {
    return null;
  }

  const messages = messageStore.listSessionMessages(sessionId);

  return {
    id: stored.id,
    name: stored.name ?? "Untitled",
    model: stored.model ?? "llama-3.3-70b",
    npub: stored.npub,
    startedAt: stored.startedAt,
    messages,
  };
}

/**
 * Lists all chat sessions for an npub.
 * If npub is null, returns all chat sessions (admin view).
 */
export function listChatSessions(npub: string | null): ChatSession[] {
  const allSessions = messageStore.listSessions();
  const chatSessions = allSessions.filter((s) => s.agent === CHAT_AGENT_TYPE);

  // Filter by npub if provided
  const filtered = npub
    ? chatSessions.filter((s) => s.npub === npub)
    : chatSessions;

  return filtered.map((stored) => ({
    id: stored.id,
    name: stored.name ?? "Untitled",
    model: stored.model ?? "llama-3.3-70b",
    npub: stored.npub,
    startedAt: stored.startedAt,
    messages: [], // Don't load messages for list view
  }));
}

/**
 * Deletes a chat session and its messages.
 */
export function deleteChatSession(sessionId: string): boolean {
  const session = getChatSession(sessionId);
  if (!session) {
    return false;
  }

  messageStore.removeSession(sessionId);
  return true;
}

/**
 * Updates a chat session's name.
 */
export function updateChatSessionName(sessionId: string, name: string): boolean {
  const stored = messageStore.getSession(sessionId);
  if (!stored || stored.agent !== CHAT_AGENT_TYPE) {
    return false;
  }

  // Re-record with updated name
  messageStore.recordSession({
    id: stored.id,
    agent: CHAT_AGENT_TYPE,
    startedAt: stored.startedAt,
    name: name.trim() || stored.name || "Untitled",
    npub: stored.npub ?? undefined,
    model: stored.model ?? undefined,
    workingDirectory: stored.workingDirectory ?? undefined,
    logsDir: stored.logsDir ?? undefined,
    runtimeStatus: stored.runtimeStatus,
    origin: stored.origin,
    metadata: stored.metadata,
  });

  return true;
}

/**
 * Adds a user message to the chat session.
 */
export function addUserMessage(sessionId: string, content: string): StoredMessage | null {
  const session = getChatSession(sessionId);
  if (!session) {
    return null;
  }

  const messages = messageStore.listSessionMessages(sessionId);
  const newMessage: StoredMessage = {
    id: randomUUID(),
    sessionId,
    role: "user",
    content,
    createdAt: new Date().toISOString(),
  };

  // Store all messages including new one
  messageStore.replaceMessages(sessionId, [
    ...messages.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
    {
      role: newMessage.role,
      content: newMessage.content,
      createdAt: newMessage.createdAt,
    },
  ]);

  return newMessage;
}

/**
 * Adds an assistant message to the chat session.
 */
export function addAssistantMessage(sessionId: string, content: string): StoredMessage | null {
  const session = getChatSession(sessionId);
  if (!session) {
    return null;
  }

  const messages = messageStore.listSessionMessages(sessionId);
  const newMessage: StoredMessage = {
    id: randomUUID(),
    sessionId,
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
  };

  // Store all messages including new one
  messageStore.replaceMessages(sessionId, [
    ...messages.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
    {
      role: newMessage.role,
      content: newMessage.content,
      createdAt: newMessage.createdAt,
    },
  ]);

  return newMessage;
}

/**
 * Builds the message array for API calls from stored messages.
 */
export function buildChatMessages(session: ChatSession): ChatMessage[] {
  return session.messages.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));
}

/**
 * Sends a message and streams the response from Maple Proxy.
 * Returns an async generator that yields response chunks.
 */
export async function* sendChatMessage(
  config: WingmanConfig,
  sessionId: string,
  userContent: string,
  signal?: AbortSignal,
  recordUsage?: (data: { sessionId: string; model: string; inputTokens: number; outputTokens: number }) => Promise<void>
): AsyncGenerator<{ type: "chunk" | "done" | "error"; content: string; messageId?: string }, void, unknown> {
  const session = getChatSession(sessionId);
  if (!session) {
    yield { type: "error", content: "Chat session not found" };
    return;
  }

  // Add user message
  const userMessage = addUserMessage(sessionId, userContent);
  if (!userMessage) {
    yield { type: "error", content: "Failed to add user message" };
    return;
  }

  // Get updated session with all messages
  const updatedSession = getChatSession(sessionId);
  if (!updatedSession) {
    yield { type: "error", content: "Failed to retrieve updated session" };
    return;
  }

  const chatMessages = buildChatMessages(updatedSession);
  const client = createMapleClient(config);

  let fullResponse = "";

  try {
    for await (const chunk of streamChatCompletion(client, chatMessages, session.model, signal)) {
      fullResponse += chunk;
      yield { type: "chunk", content: chunk };
    }

    // Store the complete assistant response
    const assistantMessage = addAssistantMessage(sessionId, fullResponse);

    // Estimate tokens (~4 chars per token) and record usage for billing
    if (recordUsage) {
      const inputChars = chatMessages.reduce((sum, m) => sum + m.content.length, 0);
      const estimatedInputTokens = Math.ceil(inputChars / 4);
      const estimatedOutputTokens = Math.ceil(fullResponse.length / 4);
      recordUsage({
        sessionId,
        model: session.model,
        inputTokens: estimatedInputTokens,
        outputTokens: estimatedOutputTokens,
      }).catch(err => console.error(`[chat] billing error: ${(err as Error).message}`));
    }

    yield {
      type: "done",
      content: fullResponse,
      messageId: assistantMessage?.id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Still save partial response if we got any
    if (fullResponse.length > 0) {
      addAssistantMessage(sessionId, fullResponse + "\n\n[Response interrupted]");
    }

    yield { type: "error", content: message };
  }
}

/**
 * Returns the list of available models.
 */
export function getAvailableModels(): readonly string[] {
  return MAPLE_MODELS;
}

/**
 * Checks if a user can access a chat session.
 */
export function canAccessChatSession(
  session: ChatSession,
  npub: string | null,
  isAdmin: boolean
): boolean {
  if (isAdmin) {
    return true;
  }
  if (!npub) {
    return false;
  }
  return session.npub === npub;
}
