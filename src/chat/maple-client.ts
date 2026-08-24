/**
 * Maple Proxy client for OpenAI-compatible chat completions.
 * Provides streaming chat completion via SSE from a Maple Proxy server.
 */

import type { WingmanConfig } from "../config";

/** Available models on Maple Proxy */
export const MAPLE_MODELS = [
  "llama-3.3-70b",
  "gpt-oss-120b",
  "deepseek-r1-0528",
  "kimi-k2-thinking",
  "qwen3-vl-30b",
  "qwen3-coder-480b",
] as const;

export type MapleModel = (typeof MAPLE_MODELS)[number];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }>;
}

export interface MapleClientOptions {
  baseUrl: string;
  apiKey: string | null;
}

/**
 * Creates a Maple Proxy client for chat completions.
 */
export function createMapleClient(config: WingmanConfig): MapleClientOptions {
  return {
    baseUrl: config.mapleProxyUrl,
    apiKey: config.mapleApiKey,
  };
}

/**
 * Streams chat completions from Maple Proxy.
 * Yields content chunks as they arrive from the SSE stream.
 *
 * @param client - Maple client options
 * @param messages - Array of chat messages
 * @param model - Model to use for completion
 * @param signal - Optional AbortSignal for cancellation
 * @yields Content string chunks from the response
 */
export async function* streamChatCompletion(
  client: MapleClientOptions,
  messages: ChatMessage[],
  model: string,
  signal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  const url = `${client.baseUrl}/v1/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  if (client.apiKey) {
    headers["Authorization"] = `Bearer ${client.apiKey}`;
  }

  const body = JSON.stringify({
    model,
    messages,
    stream: true,
  });

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`Maple Proxy error (${response.status}): ${errorText}`);
  }

  if (!response.body) {
    throw new Error("No response body from Maple Proxy");
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
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) {
          // Empty line or SSE comment (keepalive)
          continue;
        }

        if (trimmed === "data: [DONE]") {
          return;
        }

        if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          try {
            const chunk = JSON.parse(jsonStr) as ChatCompletionChunk;
            const content = chunk.choices?.[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch (parseError) {
            console.warn("[maple-client] Failed to parse chunk:", jsonStr, parseError);
          }
        }
      }
    }

    // Process any remaining buffer content
    if (buffer.trim() && buffer.trim().startsWith("data: ") && buffer.trim() !== "data: [DONE]") {
      const jsonStr = buffer.trim().slice(6);
      try {
        const chunk = JSON.parse(jsonStr) as ChatCompletionChunk;
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
          yield content;
        }
      } catch {
        // Ignore parse errors on final buffer
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Non-streaming chat completion for simple use cases.
 *
 * @param client - Maple client options
 * @param messages - Array of chat messages
 * @param model - Model to use for completion
 * @param signal - Optional AbortSignal for cancellation
 * @returns Complete assistant response content
 */
export async function chatCompletion(
  client: MapleClientOptions,
  messages: ChatMessage[],
  model: string,
  signal?: AbortSignal
): Promise<string> {
  let fullContent = "";
  for await (const chunk of streamChatCompletion(client, messages, model, signal)) {
    fullContent += chunk;
  }
  return fullContent;
}

/**
 * Validates if a string is a valid Maple model.
 */
export function isValidMapleModel(model: string): model is MapleModel {
  return MAPLE_MODELS.includes(model as MapleModel);
}
