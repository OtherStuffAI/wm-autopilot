import type { AgentMessage } from "./agent-client";

/** Shared native SDK roles consumed by the existing Markdown/working-notes UI. */
export type NativeActivityRole = "agent-streaming" | "agent-working" | "agent-thinking" | "agent-tools" | "agent-error";

export function isNativeSdkTransport(transport?: string): boolean {
  return transport === "codex-sdk" || transport === "claude-sdk";
}

/** Native SDK IDs are not completion evidence. Only terminal success is final. */
export function isNativeFinalReady(input: {
  nativeTranscriptReady: boolean;
  agentTransport?: string;
  runtimeStatus: string | null;
}): boolean {
  return input.runtimeStatus === "stable"
    || (input.nativeTranscriptReady && !isNativeSdkTransport(input.agentTransport));
}

/** An error card supersedes earlier text in the same turn. */
export function findNativeTurnFinal<T extends { role: string; content: string }>(messages: T[]): T | undefined {
  const outcome = messages.findLast((message) => ["assistant", "agent", "agent-error"].includes(message.role)
    && message.content.trim().length > 0);
  return outcome?.role === "agent-error" ? undefined : outcome;
}

/** Stable identities let SSE updates and reload snapshots share a single card. */
export class NativeSdkActivity {
  private readonly messages = new Map<string, AgentMessage>();
  private lastTimestamp = 0;

  constructor(private readonly onMessage: (message: AgentMessage) => void) {}

  upsert(id: string, role: NativeActivityRole | "assistant" | "user", content: string): AgentMessage {
    const existing = this.messages.get(id);
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    const message: AgentMessage = {
      role, content, messageId: id,
      createdAt: existing?.createdAt ?? new Date(this.lastTimestamp).toISOString(),
    };
    this.messages.set(id, message);
    this.onMessage({ ...message });
    return message;
  }

  hydrate(messages: AgentMessage[]): void {
    for (const [index, message] of messages.entries()) {
      const id = message.messageId ?? `history:${index}:${message.createdAt}`;
      this.messages.set(id, { ...message });
      this.lastTimestamp = Math.max(this.lastTimestamp, Date.parse(message.createdAt) || 0);
    }
  }

  snapshot(): AgentMessage[] {
    return [...this.messages.values()].map((message) => ({ ...message }));
  }
}

/** Tool payloads are data, not Markdown instructions; choose a safe fence. */
export function formatNativeTool(label: string, value: unknown): string {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return `${label}\n\n${fence}\n${body}\n${fence}`;
}
