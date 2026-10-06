import type { Thread, ThreadEvent, Usage } from "@openai/codex-sdk";

export function extractCodexErrorMessage(raw: string | undefined | null): string {
  if (!raw) return "Codex turn failed";
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { detail?: unknown; message?: unknown };
      const detail = typeof parsed.detail === "string" ? parsed.detail : typeof parsed.message === "string" ? parsed.message : null;
      if (detail) return detail;
    } catch { /* Preserve an unstructured upstream error. */ }
  }
  return trimmed || "Codex turn failed";
}

/** SDK prompt/stream completion; commentary never becomes the returned final. */
export async function runCodexTurn(thread: Thread, content: string, input: {
  signal: AbortSignal;
  requireCompletion: boolean;
  onEvent: (event: ThreadEvent) => void;
  onAssistant: (text: string) => void;
  onThreadId: (id: string) => void;
}): Promise<{ finalText: string; usage: Usage | null }> {
  let finalText = "";
  let usage: Usage | null = null;
  let completed = false;
  let turnError: string | null = null;
  try {
    const { events } = await thread.runStreamed(content, { signal: input.signal });
    if (thread.id) input.onThreadId(thread.id);
    for await (const event of events) {
      input.onEvent(event);
      if (event.type === "thread.started") input.onThreadId(event.thread_id);
      if ((event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") && event.item.type === "agent_message") {
        const text = event.item.text;
        if (text) input.onAssistant(text);
        if (event.type === "item.completed") finalText = text;
      }
      if (event.type === "turn.completed") { usage = event.usage; completed = true; }
      if (event.type === "turn.failed") turnError = extractCodexErrorMessage(event.error?.message);
      if (event.type === "error") turnError = extractCodexErrorMessage(event.message);
    }
    if (turnError) throw new Error(turnError);
    if (input.requireCompletion && (!completed || !finalText.trim())) throw new Error("Native completed assistant output missing");
    return { finalText, usage };
  } catch (error) {
    if (turnError && !input.signal.aborted) throw new Error(turnError);
    throw error;
  }
}
