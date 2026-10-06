import { ConversationStore, type ConversationInput } from "./conversation-store";

export interface ConversationRuntime {
  beforeTurn?: () => Promise<void>;
  completedTurn: (prompt: string) => Promise<string>;
  recoverCompletedTurn: (prompt: string) => Promise<string | null>;
  sendFinal: (input: { id: string; text: string; replyTo: string }) => Promise<void>;
}
export function correlatedPrompt(input: ConversationInput): string {
  return `[White Noise input ${input.id}]\n${input.text}`;
}

/** Serial execution; submission acceptance is never assistant completion. */
export class ConversationRouter {
  constructor(readonly store: ConversationStore, private readonly runtime: ConversationRuntime) {}
  async drain(): Promise<void> {
    for (const input of this.store.pending()) {
      const prompt = correlatedPrompt(input);
      let reply = input.reply;
      if (input.state === "accepted") {
        reply = await this.runtime.recoverCompletedTurn(prompt);
        if (reply === null) throw new Error("accepted_input_requires_completion_recovery");
        this.store.complete(input.id, reply);
      } else if (input.state === "queued") {
        // Persist intent before crossing the agent side-effect boundary. An uncertain
        // crash is recovered from the correlated native transcript, never resubmitted.
        await this.runtime.beforeTurn?.();
        this.store.accept(input.id);
        reply = await this.runtime.completedTurn(prompt);
        this.store.complete(input.id, reply);
      }
      if (reply === null) throw new Error("completed_output_missing");
      await this.runtime.sendFinal({ id: `wn:${input.id}`, text: reply, replyTo: input.id });
      this.store.delivered(input.id);
    }
  }
}
