import { findCodexSessionFileForReading, resolveCodexHome } from "../agents/codex-session-fork.ts";
import { readCodexJsonlRecords } from "../agents/codex-jsonl-reader.ts";

export interface NativeTurnContext { nativeSessionId: string; directory: string; }

async function readNative(context: NativeTurnContext, visit: (record: Record<string, unknown>) => void): Promise<void> {
  const path = await findCodexSessionFileForReading({ codexHome: resolveCodexHome(), sessionId: context.nativeSessionId, workingDirectory: context.directory });
  if (!path) throw new Error("Bound native conversation transcript unavailable");
  await readCodexJsonlRecords(path, visit);
}

export async function nativeTurnCheckpoint(context: NativeTurnContext): Promise<number> {
  let count = 0;
  await readNative(context, (record) => {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (record.type === "event_msg" && payload?.type === "user_message") count += 1;
  });
  return count;
}

/** Match the first exact prompt AFTER the saved boundary, never an older identical prompt. */
export class NativeTurnRecovery {
  private count = 0;
  private matched = false;
  private final: string | null = null;
  reply: string | null = null;
  constructor(private readonly checkpoint: number, private readonly prompt: string) {}
  visit(record: Record<string, unknown>): void {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload || this.reply !== null) return;
    if (record.type === "event_msg" && payload.type === "user_message") {
      this.count += 1;
      if (this.count <= this.checkpoint) return;
      if (this.count !== this.checkpoint + 1 || payload.message !== this.prompt) {
        throw new Error("Native completed-turn checkpoint does not match the exact request");
      }
      this.matched = true;
    }
    if (!this.matched) return;
    if (record.type === "event_msg" && payload.type === "agent_message" && payload.phase === "final_answer" && typeof payload.message === "string") {
      this.final = payload.message;
    }
    if (record.type === "response_item" && payload.type === "message" && payload.role === "assistant" && payload.phase === "final_answer" && Array.isArray(payload.content)) {
      this.final = payload.content.map((part: { text?: string }) => part.text ?? "").join("");
    }
    if (record.type === "event_msg" && payload.type === "task_complete") {
      if (payload.error || !this.final?.trim()) throw new Error("Native correlated completion failed or final output missing");
      if (typeof payload.last_agent_message === "string" && payload.last_agent_message !== this.final) throw new Error("Native completed output mismatch");
      this.reply = this.final;
    }
  }
}

export async function recoverNativeTurn(context: NativeTurnContext, checkpoint: number, prompt: string): Promise<string | null> {
  const recovery = new NativeTurnRecovery(checkpoint, prompt);
  await readNative(context, (record) => recovery.visit(record));
  return recovery.reply;
}
