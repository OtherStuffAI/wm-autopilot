type Payload = Record<string, unknown>;
export interface NativeTurnRecord {
  type: "user" | "message" | "tools" | "complete" | "aborted" | "started";
  turnId: string | null;
  text?: string;
  phase?: unknown;
  error?: unknown;
  source: string;
  id?: string;
}

function object(value: unknown): Payload | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Payload : null;
}
function textContent(value: unknown): string | null {
  if (!Array.isArray(value) || !value.length) return null;
  if (!value.every(part => object(part) && ["text", "Text", "input_text", "output_text"].includes(part.type) && typeof part.text === "string")) return null;
  return value.map(part => part.text).join("");
}

/** Interpret actual input items, never replayed instructions/environment as requests. */
export class NativeTurnRecords {
  count = 0;
  private turnId: string | null = null;
  private users = new Map<string, string>();
  private messageIds = new Set<string>();
  private lastUser: { text: string; source: string } | null = null;

  visit(record: Payload): NativeTurnRecord | null {
    const payload = object(record.payload);
    if (!payload) return null;
    if (record.type === "turn_context") {
      if (typeof payload.turn_id === "string") this.turnId = payload.turn_id;
      return { type: "started", turnId: this.turnId, source: "turn_context" };
    }
    const source = `${record.type}:${payload.type}`;
    const explicitTurn = typeof payload.turn_id === "string" ? payload.turn_id : null;
    if (record.type === "event_msg" && payload.type === "task_started") {
      this.turnId = explicitTurn;
      this.lastUser = null;
      return { type: "started", turnId: this.turnId, source };
    }
    const metadata = object(payload.internal_chat_message_metadata_passthrough);
    const turnId = explicitTurn ?? (typeof metadata?.turn_id === "string" ? metadata.turn_id : this.turnId);
    // Replayed items from another turn cannot supply this turn's prompt or activity.
    if (this.turnId && turnId && turnId !== this.turnId) return null;
    const item = record.type === "event_msg" && payload.type === "item_completed" ? object(payload.item) : null;
    let result: NativeTurnRecord | null = null;
    if (record.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
      result = { type: "user", text: payload.message, turnId, source };
    } else if (record.type === "response_item" && payload.type === "message" && payload.role === "user") {
      const kinds = metadata?.content_item_kinds;
      if (!Array.isArray(kinds) || !kinds.length || !kinds.every(kind => kind === "user.text")) return null;
      const text = textContent(payload.content);
      if (text !== null) result = { type: "user", text, turnId, source };
    } else if (item?.type === "UserMessage") {
      const text = textContent(item.content);
      if (text !== null) result = { type: "user", text, turnId, source };
    } else if (record.type === "event_msg" && payload.type === "agent_message" && typeof payload.message === "string") {
      result = { type: "message", text: payload.message, phase: payload.phase, turnId, source };
    } else if ((record.type === "response_item" && payload.type === "message" && payload.role === "assistant") || item?.type === "AgentMessage") {
      const message = item ?? payload;
      const text = textContent(message.content);
      if (text !== null) result = { type: "message", text, phase: message.phase, turnId, source, id: typeof message.id === "string" ? message.id : undefined };
    } else if ((record.type === "response_item" && ["function_call", "custom_tool_call", "web_search_call", "local_shell_call"].includes(String(payload.type))) ||
      (item && ["CommandExecution", "McpToolCall", "WebSearch", "CustomToolCall"].includes(String(item.type)))) {
      result = { type: "tools", turnId, source };
    } else if (record.type === "event_msg" && ["task_complete", "turn_aborted"].includes(String(payload.type))) {
      result = { type: payload.type === "task_complete" ? "complete" : "aborted", text: typeof payload.last_agent_message === "string" ? payload.last_agent_message : undefined, error: payload.error, turnId, source };
    }
    if (result?.type === "user") {
      if (turnId && this.users.has(turnId)) {
        if (this.users.get(turnId) !== result.text) throw new Error("Native turn contains inconsistent user input");
        return null;
      }
      if (this.lastUser && this.lastUser.text === result.text && this.lastUser.source !== source) {
        if (turnId) this.users.set(turnId, result.text!);
        return null;
      }
      this.count++;
      if (turnId) this.users.set(turnId, result.text!);
      this.lastUser = { text: result.text!, source };
    } else if (result && result.type !== "started") {
      this.lastUser = null;
      if (result.type === "message" && result.id) {
        const key = JSON.stringify([turnId, result.id]);
        if (this.messageIds.has(key)) return null;
        this.messageIds.add(key);
      }
    }
    if (result?.type === "complete" || result?.type === "aborted") {
      this.turnId = null;
    }
    return result;
  }
}

/** Saved logical request ordinal and exact bytes jointly bind the active turn. */
export class NativeTurnBoundary {
  readonly records = new NativeTurnRecords();
  active = false;
  closed = false;
  private turnId: string | null = null;
  constructor(private readonly checkpoint: number, private readonly prompt: string) {
    if (!Number.isSafeInteger(checkpoint) || checkpoint < 0) throw new Error("Invalid native turn checkpoint");
  }
  visit(record: Payload): NativeTurnRecord | null {
    if (this.closed) return null;
    const event = this.records.visit(record);
    if (!event) return null;
    if (event.type === "started" && this.active && event.turnId !== this.turnId) { this.closed = true; return null; }
    if (event.type === "user") {
      if (this.records.count <= this.checkpoint) return null;
      if (this.active) { this.closed = true; return null; }
      if (this.records.count !== this.checkpoint + 1 || event.text !== this.prompt) throw new Error("Native turn checkpoint does not match the exact bound prompt/request");
      this.active = true;
      this.turnId = event.turnId;
      return null;
    }
    if (!this.active || (this.turnId && event.turnId !== this.turnId)) return null;
    if (event.type === "complete" || event.type === "aborted") this.closed = true;
    return event;
  }
}
