import { NativeTurnBoundary, NativeTurnRecords } from "../agents/native-turn-records.ts";
import { findCodexSessionFileForReading, resolveCodexHome } from "../agents/codex-session-fork.ts";
import { readCodexJsonlRecords } from "../agents/codex-jsonl-reader.ts";

export interface NativeTurnContext { nativeSessionId: string; directory: string; }

export async function readNative(context: NativeTurnContext, visit: (record: Record<string, unknown>) => void): Promise<void> {
  const path = await findCodexSessionFileForReading({ codexHome: resolveCodexHome(), sessionId: context.nativeSessionId, workingDirectory: context.directory });
  if (!path) throw new Error("Bound native conversation transcript unavailable");
  await readCodexJsonlRecords(path, record => {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (typeof payload?.thread_id === "string" && payload.thread_id !== context.nativeSessionId) throw new Error("Native transcript conversation mismatch");
    visit(record);
  });
}

export async function nativeTurnCheckpoint(context: NativeTurnContext): Promise<number> {
  const records = new NativeTurnRecords();
  await readNative(context, record => { records.visit(record); });
  return records.count;
}

/** Match the first exact prompt AFTER the saved boundary, never an older identical prompt. */
export class NativeTurnRecovery {
  private readonly boundary: NativeTurnBoundary;
  private final: string | null = null;
  reply: string | null = null;
  constructor(checkpoint: number, prompt: string) { this.boundary = new NativeTurnBoundary(checkpoint, prompt); }
  visit(record: Record<string, unknown>): void {
    if (this.reply !== null) return;
    const event = this.boundary.visit(record);
    if (event?.type === "message" && event.phase === "final_answer") this.final = event.text!;
    if (event?.type === "aborted") throw new Error("Native correlated completion failed: turn aborted");
    if (event?.type === "complete") {
      if (event.error || !this.final?.trim()) throw new Error("Native correlated completion failed or final output missing");
      if (event.text !== undefined && event.text !== this.final) throw new Error("Native completed output mismatch");
      this.reply = this.final;
    }
  }
}

export async function recoverNativeTurn(context: NativeTurnContext, checkpoint: number, prompt: string): Promise<string | null> {
  const recovery = new NativeTurnRecovery(checkpoint, prompt);
  await readNative(context, (record) => recovery.visit(record));
  return recovery.reply;
}
