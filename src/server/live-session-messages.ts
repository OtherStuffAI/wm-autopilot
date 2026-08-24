import type { ProcessManager } from "../agents/process-manager";
import type {
  messageStore as MessageStoreInstance,
  ReplaceMessageInput,
  StoredMessage,
} from "../storage/message-store";
import { fetchAgentMessages } from "../agents/agent-client";
import { resolveAuthoritativeSessionMessages } from "../agents/authoritative-session-messages";

interface SyncLiveSessionMessagesInput {
  sessionId: string;
  force?: boolean;
  manager: ProcessManager;
  messageStore: typeof MessageStoreInstance;
  agentHost: string;
  requestTimeoutMs?: number;
  onTiming?: (timing: LiveSessionMessageSyncTiming) => void;
}

export interface LiveSessionMessageSyncTiming {
  sessionId: string;
  upstreamMs: number;
  authoritativeMs: number;
  persistenceMs: number;
  totalMs: number;
}

const sameMessages = (stored: StoredMessage[], incoming: ReplaceMessageInput[]): boolean => {
  if (stored.length !== incoming.length) return false;
  return stored.every((message, index) => {
    const next = incoming[index];
    if (!next) return false;
    return message.role === next.role &&
      message.content === next.content &&
      message.createdAt === next.createdAt &&
      (message.messageId ?? undefined) === (next.messageId ?? undefined) &&
      (message.turnId ?? undefined) === (next.turnId ?? undefined) &&
      (message.order ?? undefined) === (next.order ?? undefined);
  });
};

function latestUserMessage(messages: ReplaceMessageInput[]): { content: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = message?.role.toLowerCase() ?? "";
    const content = message?.content.trim() ?? "";
    if (role === "user" && content) {
      return { content };
    }
  }
  return null;
}

function userMessagesOnly(messages: ReplaceMessageInput[]): ReplaceMessageInput[] {
  return messages.filter((message) => message.role.toLowerCase() === "user");
}

export async function syncLiveSessionMessages(input: SyncLiveSessionMessagesInput): Promise<StoredMessage[]> {
  const { sessionId, force = false, manager, messageStore, agentHost } = input;
  const startedAt = Date.now();
  let upstreamMs = 0;
  let authoritativeMs = 0;
  let persistenceMs = 0;

  const reportTiming = () => input.onTiming?.({
    sessionId,
    upstreamMs,
    authoritativeMs,
    persistenceMs,
    totalMs: Date.now() - startedAt,
  });

  if (!force && messageStore.hasMessages(sessionId)) {
    return messageStore.listSessionMessages(sessionId);
  }

  let session = manager.getSession(sessionId);
  if (!session || session.status !== "running") {
    return messageStore.listSessionMessages(sessionId);
  }

  try {
    const hadMessages = messageStore.hasMessages(sessionId);
    const adapter = manager.getAdapter(sessionId);
    const upstreamStartedAt = Date.now();
    const requestTimeoutMs = input.requestTimeoutMs ?? 3000;
    const liveMessages = adapter
      ? await adapter.fetchMessages(requestTimeoutMs)
      : await fetchAgentMessages(agentHost, session.port, { timeoutMs: requestTimeoutMs });
    upstreamMs = Date.now() - upstreamStartedAt;
    const isAgentapiCodex = session.agent === "codex" && !adapter?.deliversPromptsDirectly?.();
    const isUnattachedAgentapiCodex = isAgentapiCodex &&
      !session.metadata?.nativeAgentSession?.sessionId;
    if (isUnattachedAgentapiCodex) {
      const latestUser = latestUserMessage(liveMessages);
      if (latestUser) {
        await manager.captureAgentapiCodexSessionIdFromPrompt(sessionId, latestUser.content, {
          // AgentAPI reconstructs PTY messages on reconnect and can assign a
          // fresh timestamp to an old prompt. The persisted session start is
          // the stable lower bound for locating that session's native rollout.
          sentAtMs: Date.parse(session.startedAt),
          attempts: 1,
          retryMs: 0,
        });
        session = manager.getSession(sessionId);
      }
      if (!session?.metadata?.nativeAgentSession?.sessionId) {
        // AgentAPI exposes a PTY screen scrape, not structured conversation
        // messages. Keep the user's prompts visible while native transcript
        // attachment retries on subsequent syncs; never render the scrape as
        // one enormous assistant bubble.
        const safeMessages = userMessagesOnly(liveMessages);
        if (safeMessages.length > 0 || !hadMessages) {
          messageStore.replaceMessages(sessionId, safeMessages);
        }
        const result = messageStore.listSessionMessages(sessionId);
        reportTiming();
        return result;
      }
    }
    const authoritativeStartedAt = Date.now();
    const messages = await resolveAuthoritativeSessionMessages(session, liveMessages);
    authoritativeMs = Date.now() - authoritativeStartedAt;
    if (isAgentapiCodex && messages.length === 0) {
      if (!hadMessages) {
        messageStore.replaceMessages(sessionId, userMessagesOnly(liveMessages));
      }
      const result = messageStore.listSessionMessages(sessionId);
      reportTiming();
      return result;
    }
    const storedMessages = messageStore.listSessionMessages(sessionId);
    if ((messages.length > 0 || !hadMessages) && !sameMessages(storedMessages, messages)) {
      const persistenceStartedAt = Date.now();
      messageStore.replaceMessages(sessionId, messages);
      persistenceMs = Date.now() - persistenceStartedAt;
    }
  } catch (error) {
    console.error(`Failed to synchronise messages for session ${sessionId}:`, error);
  }

  const result = messageStore.listSessionMessages(sessionId);
  reportTiming();
  return result;
}
