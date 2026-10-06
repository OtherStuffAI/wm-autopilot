import { findCodexSessionFileForReading, resolveCodexHome } from "../agents/codex-session-fork";
import { readCodexJsonlRecords } from "../agents/codex-jsonl-reader";

/** Recover only an explicit successful task_complete for the exact input. */
export async function recoverCodexCompletion(input: { sessionId: string; workingDirectory: string }, prompt: string): Promise<string | null> {
  const path = await findCodexSessionFileForReading({ ...input, codexHome: resolveCodexHome() });
  if (!path) return null;
  const recovery = new CompletionRecovery(prompt);
  await readCodexJsonlRecords(path, record => recovery.visit(record));
  return recovery.result;
}
export async function recoverCompletionRecords(records: AsyncIterable<Record<string, unknown>>, prompt: string): Promise<string | null> {
  const recovery = new CompletionRecovery(prompt);
  for await (const record of records) recovery.visit(record);
  return recovery.result;
}
class CompletionRecovery {
  private matched = false;
  private final: string | null = null;
  result: string | null = null;
  constructor(private readonly prompt: string) {}
  visit(record: Record<string, unknown>): void {
    if (this.result !== null) return;
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload) return;
    if (record.type === "event_msg" && payload.type === "user_message") {
      this.matched = payload.message === this.prompt;
      this.final = null;
    }
    if (!this.matched) return;
    if (record.type === "response_item" && payload.type === "message" && payload.role === "assistant" && payload.phase === "final_answer" && Array.isArray(payload.content)) {
      this.final = payload.content.map((p: { text?: string }) => p.text ?? "").join("");
    }
    if (record.type === "event_msg" && payload.type === "agent_message" && payload.phase === "final_answer" && typeof payload.message === "string") this.final = payload.message;
    if (record.type === "event_msg" && payload.type === "task_complete") {
      if (payload.error) throw new Error("correlated_turn_failed");
      const text = typeof payload.last_agent_message === "string" ? payload.last_agent_message : this.final;
      if (!text?.trim()) throw new Error("correlated_completed_text_missing");
      this.result = text;
    }
  }
}
