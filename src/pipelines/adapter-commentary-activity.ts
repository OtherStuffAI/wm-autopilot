import { createHash } from "node:crypto";
import type { AgentMessage } from "../agents/agent-client.ts";
import type { PublicTurnActivity } from "../agents/bound-turn-activity.ts";

/** ACP thinking messages grow in place; publish immutable, content-versioned snapshots. */
export function adapterCommentaryActivity(message: AgentMessage, index: number): PublicTurnActivity | null {
  const thinking = message.role === "agent-thinking";
  if (!thinking && message.role !== "agent-commentary") return null;
  const text = message.content.replace(/\0/g, "").trim();
  if (!text) return null;
  // Keep recent progress visible even after the cumulative ACP message exceeds the limit.
  const content = thinking ? text.slice(-4000) : text.slice(0, 4000);
  const identity = String(message.messageId ?? index);
  const sourceId = thinking
    ? JSON.stringify(["thinking", identity, createHash("sha256").update(content).digest("hex")])
    : identity;
  return { sourceId, timestamp: message.createdAt, type: "commentary", content };
}
