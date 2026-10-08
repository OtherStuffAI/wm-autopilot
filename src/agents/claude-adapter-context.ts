import { messageStore } from "../storage/message-store";
import type { SessionSnapshot } from "./process-manager";
import type { SessionMetadata } from "../sessions/session-metadata";
import type { AdapterSessionContext } from "./agent-adapter";
import { applyClaudeSubscriptionAuth } from "./agent-environment";

type ClaudeLaunchSession = Pick<SessionSnapshot, "id" | "agent" | "command"> & {
  metadata: SessionMetadata;
  definition: { env?: Record<string, string> };
};

/** Translate the existing private CLI launch contract into SDK options. */
export function buildClaudeAdapterContext(session: ClaudeLaunchSession, oauthToken: string | null): Partial<AdapterSessionContext> {
  if (session.agent !== "claude" || session.metadata.agentTransport !== "claude-sdk") return {};
  const mcpIndex = session.command.indexOf("--mcp-config");
  const cliIndex = session.command.indexOf("--") + 1;
  const native = session.metadata.nativeAgentSession;
  const billingMode = session.metadata.billingMode === "credits" ? "credits" : "subscription";
  const env = applyClaudeSubscriptionAuth(session.definition.env, { agent: "claude", billingMode, oauthToken });
  if (billingMode === "credits" && (!env.ANTHROPIC_BASE_URL || (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY))) {
    throw new Error("Claude SDK credits authentication must be reissued before resuming");
  }
  const historySessionId = session.metadata.resumedFromWingmanSessionId ?? session.id;
  const nativeSdkHistory = messageStore.listSessionMessages(historySessionId).map((message) => ({
    role: message.role, content: message.content, createdAt: message.createdAt,
    messageId: message.messageId ?? undefined,
  }));
  return {
    nativeSdkHistory,
    env,
    claudeCli: session.command[cliIndex],
    claudeMcpConfigPath: mcpIndex >= 0 ? session.command[mcpIndex + 1] : undefined,
    claudeSessionId: native?.agent === "claude" ? native.sessionId : undefined,
    claudeResume: native?.agent === "claude" && (native.source !== "preallocated"
      || Boolean(session.metadata.resumedFromWingmanSessionId || session.metadata.branchedFromWingmanSessionId)),
    claudeSkipPermissions: session.command.includes("--dangerously-skip-permissions"),
  };
}
