import { NativeTurnBoundary } from "./native-turn-records.ts";
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
  private readonly boundary: NativeTurnBoundary;
  private index = 0;
  private tools = false;
  private mirrors: { source: string; text: string; at: number }[] = [];
  finalResponse: string | null = null;

  constructor(checkpoint: number, prompt: string) { this.boundary = new NativeTurnBoundary(checkpoint, prompt); }

  visit(record: Record<string, unknown>): void {
    this.index++;
    const event = this.boundary.visit(record);
    if (!event) return;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
    if (!Number.isFinite(Date.parse(timestamp))) return;
    const text = event.type === "message" ? event.text ?? null : null;
    const phase = event.phase;
    if (text !== null && phase === "final_answer") this.finalResponse = text;
    if (text?.trim() && phase === "commentary") {
      const at = Date.parse(timestamp);
      // Codex mirrors the same public item into two record families. Keep its first source identity.
      const mirrored = this.mirrors.some(item => item.source !== event.source && item.text === text && Math.abs(item.at - at) <= 500);
      this.mirrors.push({ source: event.source, text, at });
      this.mirrors = this.mirrors.filter(item => at - item.at <= 1000).slice(-32);
      if (mirrored) return;
      this.tools = false;
      this.add(timestamp, "commentary", text.replace(/\0/g, "").trim().slice(0, 4000));
    } else if (event.type === "tools") {
      if (!this.tools) this.add(timestamp, "tools", "Using tools");
      this.tools = true;
    }
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
