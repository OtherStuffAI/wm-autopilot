import type { DirectChatMessage } from "./direct-chat-contract";

const MAX_HISTORY_CHARACTERS = 262_144;
const MAX_MESSAGE_CHARACTERS = 32_768;

/** Keep crash dumps out of the prompt while retaining their authoritative IDs. */
export function budgetDirectChatHistory(history: DirectChatMessage[]): {
  messages: DirectChatMessage[];
  notice: string | null;
} {
  const messages: DirectChatMessage[] = [];
  let remaining = MAX_HISTORY_CHARACTERS;
  let omitted = 0;
  let excerpted = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    const overhead = message.messageId.length + message.createdAt.length + (message.speakerLabel?.length ?? 0) + 256;
    const limit = Math.min(MAX_MESSAGE_CHARACTERS, remaining - overhead);
    if (limit < 1024) {
      omitted = index + 1;
      break;
    }
    let body = message.message;
    if (body.length > limit) {
      const marker = `\n\n[Historical message excerpt: ${body.length} characters in the original. Retrieve message ${message.messageId} from the authoritative Flight Deck thread before relying on omitted details.]\n\n`;
      const available = Math.max(0, limit - marker.length);
      const head = Math.ceil(available / 2);
      body = body.slice(0, head) + marker + body.slice(-(available - head));
      excerpted += 1;
    }
    messages.unshift({ ...message, message: body });
    remaining -= body.length + overhead;
  }
  const notice = omitted || excerpted
    ? `History size limit: ${omitted} older messages omitted; ${excerpted} historical message bodies excerpted. The original messages remain unchanged in Flight Deck. Use the thread read tool/CLI with the source workspace, channel and thread to retrieve needed details; save large responses to a local file and inspect relevant sections instead of loading the entire crash dump into context.`
    : null;
  return { messages, notice };
}
