import type { AgentMessage } from "./agent-client";

interface AcpToolCallState {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: unknown[];
  locations?: unknown[];
  rawInput?: unknown;
  rawOutput?: unknown;
  createdAt: string;
  messageId: string;
  turnId: string;
  order: number;
}

export type AcpNormalizationResult =
  | { kind: "message"; message: AgentMessage }
  | { kind: "messages"; messages: AgentMessage[] }
  | { kind: "ignored" }
  | { kind: "invalid"; reason: string };

export interface AcpEventNormalizerOptions {
  rollIntermediateAgentMessages?: boolean;
}

const TOOL_FIELDS = ["title", "kind", "status", "content", "locations", "rawInput", "rawOutput"] as const;

/**
 * Stateful normalization for the ACP session-update subset shared by native agents.
 * Used by the native Codex, Goose, and Pi ACP transports after their emitted
 * wire behavior has been verified.
 */
export class AcpEventNormalizer {
  private turnNumber = 0;
  private messageOrder = 0;
  private expectingLocalUserEcho = false;
  private currentUserUpstreamId: string | null = null;
  private currentTurnHasAgentContent = false;
  private readonly chunks = new Map<string, AgentMessage>();
  private readonly toolCalls = new Map<string, AcpToolCallState>();
  private readonly workingParts = new Map<"thinking" | "tools", Map<string, string>>();
  private readonly workingMessages = new Map<"thinking" | "tools", AgentMessage>();
  private activeAgentUpstreamId: string | null = null;
  private activeAgentMessage: AgentMessage | null = null;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly options: AcpEventNormalizerOptions = {},
  ) {}

  beginTurn(options: { expectUserEcho?: boolean } = {}): number {
    this.turnNumber += 1;
    this.messageOrder = (this.turnNumber - 1) * 1000;
    this.expectingLocalUserEcho = options.expectUserEcho === true;
    this.currentUserUpstreamId = null;
    this.currentTurnHasAgentContent = false;
    this.chunks.clear();
    this.toolCalls.clear();
    this.workingParts.clear();
    this.workingMessages.clear();
    this.activeAgentUpstreamId = null;
    this.activeAgentMessage = null;
    return this.turnNumber;
  }

  normalize(update: unknown): AcpNormalizationResult {
    if (!isRecord(update)) {
      return { kind: "invalid", reason: "session update is not an object" };
    }

    const updateType = readNonEmptyString(update.sessionUpdate);
    if (!updateType) {
      return { kind: "invalid", reason: "session update is missing sessionUpdate" };
    }

    if (updateType === "agent_message_chunk") {
      this.currentTurnHasAgentContent = true;
      if (this.options.rollIntermediateAgentMessages) {
        return this.normalizeRollingAgentChunk(update);
      }
      return this.normalizeChunk(update, "assistant", "message");
    }
    if (updateType === "agent_thought_chunk") {
      this.currentTurnHasAgentContent = true;
      return this.normalizeChunk(update, "agent-working", "thought");
    }
    if (updateType === "user_message_chunk") {
      this.ensureUserTurn(update);
      return this.normalizeChunk(update, "user", "user");
    }
    if (updateType === "tool_call") {
      this.currentTurnHasAgentContent = true;
      return this.normalizeToolCall(update);
    }
    if (updateType === "tool_call_update") {
      this.currentTurnHasAgentContent = true;
      return this.normalizeToolCallUpdate(update);
    }

    return { kind: "ignored" };
  }

  upsertToolActivity(partId: string, content: string): AgentMessage {
    if (this.turnNumber === 0) this.beginTurn();
    return this.upsertWorkingPart("tools", partId, content, true).message;
  }

  private ensureUserTurn(update: Record<string, unknown>): void {
    const upstreamId = readNonEmptyString(update.messageId);
    const isCurrentChunk = !this.currentTurnHasAgentContent && upstreamId !== null && upstreamId === this.currentUserUpstreamId;
    if (this.expectingLocalUserEcho) {
      this.expectingLocalUserEcho = false;
    } else if (!isCurrentChunk) {
      this.beginTurn();
    }
    this.currentUserUpstreamId = upstreamId;
  }

  private normalizeChunk(
    update: Record<string, unknown>,
    role: "assistant" | "agent-working" | "user",
    fallbackType: "message" | "thought" | "user",
  ): AcpNormalizationResult {
    const text = readTextContent(update.content);
    if (!text) {
      return { kind: "invalid", reason: `${update.sessionUpdate} is missing text content` };
    }

    const upstreamId = readNonEmptyString(update.messageId);
    if (role === "agent-working") {
      return this.upsertWorkingPart("thinking", upstreamId ? `thought:${upstreamId}` : "thought", text);
    }
    if (this.turnNumber === 0) this.beginTurn();
    const turnId = `acp-turn-${this.turnNumber}`;
    const messageId = upstreamId
      ? `${turnId}-${fallbackType}-${encodeIdentity(upstreamId)}`
      : `${turnId}-${fallbackType}`;
    const chunkKey = `${role}:${messageId}`;
    const previous = this.chunks.get(chunkKey);
    const message: AgentMessage = previous
      ? { ...previous, content: previous.content + text }
      : { role, content: text, createdAt: this.now().toISOString(), messageId, turnId, order: this.messageOrder++ };
    this.chunks.set(chunkKey, message);
    return { kind: "message", message };
  }

  private normalizeRollingAgentChunk(update: Record<string, unknown>): AcpNormalizationResult {
    const text = readTextContent(update.content);
    if (!text) {
      return { kind: "invalid", reason: `${update.sessionUpdate} is missing text content` };
    }
    if (this.turnNumber === 0) this.beginTurn();

    const upstreamId = readNonEmptyString(update.messageId) ?? "message";
    const previous = this.activeAgentMessage;
    if (previous && upstreamId === this.activeAgentUpstreamId) {
      const message = { ...previous, content: previous.content + text };
      this.activeAgentMessage = message;
      return { kind: "message", message };
    }

    const messages: AgentMessage[] = [];
    if (previous && this.activeAgentUpstreamId) {
      messages.push(this.upsertWorkingPart(
        "thinking",
        `progress:${this.activeAgentUpstreamId}`,
        previous.content,
        true,
      ).message);
    }

    const turnId = `acp-turn-${this.turnNumber}`;
    const message: AgentMessage = {
      role: "assistant",
      content: text,
      createdAt: this.now().toISOString(),
      messageId: `${turnId}-message`,
      turnId,
      order: this.messageOrder++,
    };
    this.activeAgentUpstreamId = upstreamId;
    this.activeAgentMessage = message;
    messages.push(message);
    return messages.length === 1
      ? { kind: "message", message }
      : { kind: "messages", messages };
  }

  private upsertWorkingPart(
    category: "thinking" | "tools",
    partId: string,
    content: string,
    replace = false,
  ): { kind: "message"; message: AgentMessage } {
    const parts = this.workingParts.get(category) ?? new Map<string, string>();
    this.workingParts.set(category, parts);
    const previous = parts.get(partId) ?? "";
    parts.set(partId, replace || content.startsWith(previous) ? content : previous + content);
    const turnId = `acp-turn-${this.turnNumber}`;
    const existing = this.workingMessages.get(category);
    const message = existing
      ? { ...existing, content: [...parts.values()].join("\n\n") }
      : {
          role: category === "thinking" ? "agent-thinking" : "agent-tools",
          content: [...parts.values()].join("\n\n"),
          createdAt: this.now().toISOString(),
          messageId: `${turnId}-${category}`,
          turnId,
          order: this.messageOrder++,
        };
    this.workingMessages.set(category, message);
    return { kind: "message", message };
  }

  private normalizeToolCall(update: Record<string, unknown>): AcpNormalizationResult {
    if (this.turnNumber === 0) this.beginTurn();
    const toolCallId = readNonEmptyString(update.toolCallId);
    const title = readNonEmptyString(update.title);
    if (!toolCallId || !title) {
      return { kind: "invalid", reason: "tool_call requires toolCallId and title" };
    }
    const invalidField = validateToolFields(update, false);
    if (invalidField) {
      return { kind: "invalid", reason: `tool_call has invalid ${invalidField}` };
    }

    const state: AcpToolCallState = {
      toolCallId,
      title,
      createdAt: this.now().toISOString(),
      messageId: `acp-turn-${this.turnNumber}-tool-${encodeIdentity(toolCallId)}`,
      turnId: `acp-turn-${this.turnNumber}`,
      order: this.messageOrder++,
    };
    applyToolFields(state, update);
    this.toolCalls.set(toolCallId, state);
    const message = toToolMessage(state);
    return this.upsertWorkingPart("tools", `tool:${toolCallId}`, message.content, true);
  }

  private normalizeToolCallUpdate(update: Record<string, unknown>): AcpNormalizationResult {
    const toolCallId = readNonEmptyString(update.toolCallId);
    if (!toolCallId) {
      return { kind: "invalid", reason: "tool_call_update requires toolCallId" };
    }

    const state = this.toolCalls.get(toolCallId);
    if (!state) {
      return { kind: "invalid", reason: `tool_call_update references unknown toolCallId ${toolCallId}` };
    }
    const invalidField = validateToolFields(update, true);
    if (invalidField) {
      return { kind: "invalid", reason: `tool_call_update has invalid ${invalidField}` };
    }

    applyToolFields(state, update);
    const message = toToolMessage(state);
    return this.upsertWorkingPart("tools", `tool:${toolCallId}`, message.content, true);
  }
}

function applyToolFields(state: AcpToolCallState, update: Record<string, unknown>): void {
  for (const field of TOOL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(update, field)) continue;
    const value = update[field];
    if (value === null || value === undefined) {
      delete state[field];
      continue;
    }
    state[field] = value as never;
  }
}

function validateToolFields(update: Record<string, unknown>, nullable: boolean): string | null {
  for (const field of ["title", "kind", "status"] as const) {
    if (!Object.prototype.hasOwnProperty.call(update, field)) continue;
    const value = update[field];
    if (nullable && value === null) continue;
    if (typeof value !== "string" || (field === "title" && !value.trim())) return field;
  }
  for (const field of ["content", "locations"] as const) {
    if (!Object.prototype.hasOwnProperty.call(update, field)) continue;
    const value = update[field];
    if (nullable && value === null) continue;
    if (!Array.isArray(value)) return field;
  }
  return null;
}

function toToolMessage(state: AcpToolCallState): AgentMessage {
  const status = state.status ? ` (${state.status.replaceAll("_", " ")})` : "";
  const details = [
    formatDetail("Input", state.rawInput),
    formatToolContent(state.content),
    formatDetail("Output", state.rawOutput),
  ].filter((value): value is string => Boolean(value));
  return {
    role: "agent-working",
    content: [`Tool call: ${state.title ?? "tool"}${status}`, ...details].join("\n\n"),
    createdAt: state.createdAt,
    messageId: state.messageId,
    turnId: state.turnId,
    order: state.order,
  };
}

function encodeIdentity(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

function formatToolContent(content: unknown[] | undefined): string | null {
  if (!content?.length) return null;
  const text = content
    .map((entry) => {
      if (!isRecord(entry)) return null;
      if (entry.type === "content" && isRecord(entry.content)) return readTextContent(entry.content);
      return null;
    })
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return text ? `Content: ${text}` : null;
}

function formatDetail(label: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value ? `${label}: ${value}` : null;
  try {
    return `${label}: ${JSON.stringify(value)}`;
  } catch {
    return `${label}: [unserializable]`;
  }
}

function readTextContent(value: unknown): string | null {
  if (!isRecord(value) || value.type !== "text" || typeof value.text !== "string" || !value.text) {
    return null;
  }
  return value.text;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
