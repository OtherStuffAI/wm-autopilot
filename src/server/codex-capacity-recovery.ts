import type { StoredMessage } from "../storage/message-store";
import { writeServerLog } from "../logging/server-logger";

export const CODEX_CAPACITY_RETRY_MS = 21_000;

interface RecoveryOptions {
  isRunningCodex: (sessionId: string) => boolean;
  readMessages: (sessionId: string) => StoredMessage[];
  hasQueuedPrompt: (sessionId: string) => boolean;
  queueContinue: (sessionId: string) => void;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
}

/** Follow up only on a terminal capacity error, never on ordinary failures. */
export class CodexCapacityRecovery {
  private readonly observed = new Map<string, string>();

  constructor(private readonly options: RecoveryOptions) {}

  observe(sessionId: string, messages: StoredMessage[]): void {
    if (!this.options.isRunningCodex(sessionId)) return;
    const latest = messages.filter((message) => message.role === "user" || message.role === "assistant").at(-1);
    if (!latest || latest.role !== "assistant" || !latest.content.includes("Codex could not complete this turn")
      || !/server_overloaded|selected model is at capacity/i.test(latest.content)) return;
    const identity = `${latest.id}:${latest.content}`;
    if (this.observed.get(sessionId) === identity) return;
    this.observed.set(sessionId, identity);
    (this.options.schedule ?? setTimeout)(() => {
      if (!this.options.isRunningCodex(sessionId) || this.options.hasQueuedPrompt(sessionId)) return;
      const current = this.options.readMessages(sessionId)
        .filter((message) => message.role === "user" || message.role === "assistant").at(-1);
      if (!current || `${current.id}:${current.content}` !== identity) return;
      try {
        this.options.queueContinue(sessionId);
        writeServerLog("INFO", `Queued capacity recovery continue for session ${sessionId}`);
      } catch (error) {
        writeServerLog("ERROR", `Could not queue capacity recovery for session ${sessionId}`, error);
      }
    }, CODEX_CAPACITY_RETRY_MS);
  }
}
