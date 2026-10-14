import { readNative, type NativeTurnContext } from "../sessions/completed-turn-recovery.ts";

export interface PublicTurnActivity {
  sourceId: string;
  timestamp: string;
  type: "commentary" | "tools";
  content: string;
}

/** Project only explicit public commentary and opaque tool indicators from one exact turn. */
export class BoundTurnActivity {
  readonly activities: PublicTurnActivity[] = [];
  private users = 0;
  private index = 0;
  private active = false;
  private closed = false;
  private tools = false;
  private mirrors: { source: string; text: string; at: number }[] = [];
  finalResponse: string | null = null;

  constructor(private readonly checkpoint: number, private readonly prompt: string) {}

  visit(record: Record<string, unknown>): void {
    this.index++;
    if (this.closed) return;
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload) return;
    if (record.type === "event_msg" && payload.type === "user_message") {
      this.users++;
      if (this.users <= this.checkpoint) return;
      if (this.active) { this.closed = true; return; }
      if (this.users !== this.checkpoint + 1 || payload.message !== this.prompt) {
        throw new Error("Activity checkpoint does not match the exact bound prompt");
      }
      this.active = true;
      return;
    }
    if (!this.active) return;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
    if (!Number.isFinite(Date.parse(timestamp))) return;
    let text: string | null = null;
    let phase: unknown;
    if (record.type === "event_msg" && payload.type === "agent_message" && typeof payload.message === "string") {
      text = payload.message;
      phase = payload.phase;
    } else if (record.type === "response_item" && payload.type === "message" && payload.role === "assistant" && Array.isArray(payload.content)) {
      text = payload.content.map((part: { text?: unknown }) => typeof part.text === "string" ? part.text : "").join("");
      phase = payload.phase;
    }
    if (text !== null && phase === "final_answer") this.finalResponse = text;
    if (text?.trim() && phase === "commentary") {
      const at = Date.parse(timestamp);
      // Codex mirrors the same public item into two record families. Keep its first source identity.
      const mirrored = this.mirrors.some(item => item.source !== record.type && item.text === text && Math.abs(item.at - at) <= 500);
      this.mirrors.push({ source: String(record.type), text, at });
      this.mirrors = this.mirrors.filter(item => at - item.at <= 1000).slice(-32);
      if (mirrored) return;
      this.tools = false;
      this.add(timestamp, "commentary", text.replace(/\0/g, "").trim().slice(0, 4000));
    } else if (record.type === "response_item" && ["function_call", "custom_tool_call", "web_search_call", "local_shell_call"].includes(String(payload.type))) {
      if (!this.tools) this.add(timestamp, "tools", "Using tools");
      this.tools = true;
    }
    if (record.type === "event_msg" && ["task_complete", "turn_aborted"].includes(String(payload.type))) this.closed = true;
  }

  private add(timestamp: string, type: PublicTurnActivity["type"], content: string): void {
    if (this.activities.length < 256) this.activities.push({ sourceId: String(this.index), timestamp, type, content });
  }
}

export async function readBoundTurnActivity(context: NativeTurnContext, checkpoint: number, prompt: string): Promise<BoundTurnActivity> {
  const projection = new BoundTurnActivity(checkpoint, prompt);
  await readNative(context, record => projection.visit(record));
  return projection;
}
