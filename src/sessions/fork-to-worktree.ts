import type { ProcessManager, SessionSnapshot } from "../agents/process-manager";
import type { MessageStore, StoredMessage } from "../storage/message-store";

export interface ForkToWorktreeInput {
  sourceSessionId: string;
  branch: string;
  messageCount?: number;
}

export interface ForkToWorktreeResult {
  session: SessionSnapshot;
  contextMessages: StoredMessage[];
  worktreePath: string;
  sourceSessionId: string;
}

/**
 * Format messages as context for injection into a new session.
 * Returns a markdown-formatted string with the conversation history.
 */
export function formatMessagesAsContext(messages: StoredMessage[]): string {
  if (messages.length === 0) {
    return "";
  }

  const lines: string[] = [
    "Continuing from a previous session. Here's the recent context:",
    "",
    "---",
  ];

  for (const msg of messages) {
    const role = msg.role === "user" ? "User" : "Assistant";
    // Truncate very long messages to keep context manageable
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + "...[truncated]"
      : msg.content;
    lines.push(`**[${role}]**: ${content}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("Please continue with this work in the new worktree.");

  return lines.join("\n");
}

/**
 * Get the last N messages from a session, ordered oldest to newest.
 */
export function getRecentMessages(
  messageStore: MessageStore,
  sessionId: string,
  count: number = 5
): StoredMessage[] {
  const allMessages = messageStore.listSessionMessages(sessionId);
  // Messages are typically ordered by creation, take the last N
  const recentMessages = allMessages.slice(-count);
  return recentMessages;
}

/**
 * Validate fork-to-worktree input.
 */
export function validateForkInput(input: unknown): ForkToWorktreeInput {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid request payload");
  }

  const record = input as Record<string, unknown>;

  const branch = typeof record.branch === "string" ? record.branch.trim() : "";
  if (!branch) {
    throw new Error("Branch name is required");
  }

  // Basic branch name validation
  if (!/^[a-zA-Z0-9._/-]+$/.test(branch)) {
    throw new Error("Invalid branch name. Use alphanumeric characters, dots, underscores, and hyphens.");
  }

  const messageCount = typeof record.messageCount === "number"
    ? Math.min(Math.max(1, Math.floor(record.messageCount)), 20)
    : 5;

  // sourceSessionId comes from URL, not payload
  return {
    sourceSessionId: "", // Will be set by caller
    branch,
    messageCount,
  };
}
