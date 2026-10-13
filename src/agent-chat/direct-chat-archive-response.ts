import type { ProcessManager } from "../agents/process-manager";
import { resolveAuthoritativeSessionMessages } from "../agents/authoritative-session-messages";
import { findNativeTurnFinal } from "../agents/native-sdk-contract";
import { matchesCodexPrompt } from "../agents/codex-session-discovery";
import type { SessionArchiveStore } from "../storage/session-archive-store";
import type { DirectChatTurnRecord } from "./direct-chat-turn-store";
import type { AssistantReplyResult } from "./session-runtime-session-ops";

/** Archive timestamps are never completion evidence. Require a terminal transcript. */
export function createArchivedDirectChatFinalReader(
  archive: Pick<SessionArchiveStore, "getArchivedSession" | "getArchivedMessages">,
  manager: Pick<ProcessManager, "getSession">,
  resolveMessages = resolveAuthoritativeSessionMessages,
) {
  return async (record: DirectChatTurnRecord): Promise<AssistantReplyResult | null> => {
    if (!record.sessionId || manager.getSession(record.sessionId)) return null;
    const session = archive.getArchivedSession(record.sessionId);
    if (!session) return null;
    const saved = archive.getArchivedMessages(record.sessionId);
    const messages = await resolveMessages(session, saved, { requireNative: true });
    const boundary = messages.findLastIndex(message => message.role === "user"
      && ((record.prompt && matchesCodexPrompt(message.content, record.prompt))
        || record.sourceMessageIds.some(id => message.content.includes(id))));
    const final = boundary < 0 ? undefined : findNativeTurnFinal(messages.slice(boundary + 1));
    // Codex SDK assistant snapshots can contain a streaming bubble captured at
    // archive. Only the native parser's final_answer (agent) proves completion.
    if (!final || (session.agent === "codex" && final.role !== "agent")) return null;
    return { content: final.content, createdAt: final.createdAt };
  };
}
