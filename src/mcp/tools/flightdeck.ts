import { z } from "zod";

import { callCapabilityBroker } from "../capability-client";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

const optionalId = z.string().optional().describe("Optional override; defaults to the current Flight Deck dispatch context when available");

export const flightdeckContextSchema = {};
export const flightdeckContextDescription =
  "Return the current Flight Deck PG workspace, channel/thread/task routing, and helper availability for this agent session.";

export const flightdeckThreadReadSchema = {
  channel_id: optionalId,
  thread_id: optionalId,
  limit: z.number().int().positive().max(500).optional().describe("Maximum messages to return; defaults to 200"),
};
export const flightdeckThreadReadDescription =
  "Read Flight Deck PG messages from the current or specified channel/thread using Autopilot's dispatch context.";

export const flightdeckChatReplySchema = {
  body: z.string().min(1).describe("Message body to post"),
  channel_id: optionalId,
  thread_id: optionalId,
};
export const flightdeckChatReplyDescription =
  "Post a Flight Deck PG chat reply in the current or specified channel/thread. Use only when the pipeline expects the agent to reply directly.";

export const flightdeckTaskCommentSchema = {
  body: z.string().min(1).describe("Task comment body to post"),
  task_id: optionalId,
  thread_id: optionalId,
};
export const flightdeckTaskCommentDescription =
  "Post a Flight Deck PG task comment on the current or specified task using Autopilot's dispatch context.";

export const flightdeckTaskCommentsSchema = {
  task_id: optionalId,
  limit: z.number().int().positive().max(500).optional().describe("Maximum comments to return; defaults to 200"),
};
export const flightdeckTaskCommentsDescription =
  "Read Flight Deck PG task comments for the current or specified task.";

export const flightdeckTaskStateSchema = {
  state: z.string().min(1).describe("Target task state, for example in_progress, review, done, blocked"),
  task_id: optionalId,
};
export const flightdeckTaskStateDescription =
  "Update a Flight Deck PG task state through Autopilot using an edit lease and row-version check.";

export const flightdeckDocCreateSchema = {
  title: z.string().min(1).describe("Document title"),
  body: z.string().optional().describe("Initial document body"),
};
export const flightdeckDocCreateDescription =
  "Create a Flight Deck PG document in the current channel using Tower typed document routes. Never falls back to Yoke.";

export const flightdeckDocGetSchema = {
  document_id: z.string().min(1).describe("Flight Deck document id"),
};
export const flightdeckDocGetDescription =
  "Read a Flight Deck PG document and body text using Tower typed document routes. Never falls back to Yoke.";

export const flightdeckDocUpdateSchema = {
  document_id: z.string().min(1).describe("Flight Deck document id"),
  body: z.string().min(1).describe("Updated document body"),
};
export const flightdeckDocUpdateDescription =
  "Update a Flight Deck PG document body through Tower typed document routes, acquiring an edit lease first. Never falls back to Yoke.";

export const flightdeckDocCommentsSchema = {
  document_id: z.string().min(1).describe("Flight Deck document id"),
};
export const flightdeckDocCommentsDescription =
  "Read Flight Deck PG document comments using Tower typed document comment routes. Never falls back to Yoke.";

export const flightdeckDocReplySchema = {
  document_id: z.string().optional().describe("Flight Deck document id, if known"),
  comment_id: z.string().min(1).describe("Parent document comment id"),
  body: z.string().min(1).describe("Reply body"),
};
export const flightdeckDocReplyDescription =
  "Reply to a Flight Deck PG document comment using Tower typed document comment routes. Never falls back to Yoke.";

export const flightdeckDailyScopeGetSchema = {
  owner_npub: z.string().optional().describe("Human owner's npub; defaults to the current Flight Deck human owner when available"),
  owner_actor_id: z.string().optional().describe("Human owner actor id if known"),
  note_date: z.string().optional().describe("YYYY-MM-DD date; defaults to today"),
};
export const flightdeckDailyScopeGetDescription =
  "Read a human's personal Daily Scope through Tower typed Flight Deck PG routes. Requires the human to enable Daily Scope access for this agent.";

export const flightdeckDailyScopeUpsertSchema = {
  owner_npub: z.string().optional().describe("Human owner's npub; defaults to the current Flight Deck human owner when available"),
  owner_actor_id: z.string().optional().describe("Human owner actor id if known"),
  note_date: z.string().optional().describe("YYYY-MM-DD date; defaults to today"),
  title: z.string().optional().describe("Daily Scope title"),
  body: z.string().optional().describe("Narrative Daily Scope body"),
  narrative: z.string().optional().describe("Alias for body"),
  focus: z.string().optional().describe("Compatibility focus summary"),
  items: z.array(z.object({
    id: z.string().optional(),
    text: z.string().min(1),
    completed: z.boolean().optional(),
    source: z.string().optional(),
  })).max(5).optional().describe("Three to five concrete checklist items; never more than five"),
};
export const flightdeckDailyScopeUpsertDescription =
  "Create or update a human's personal Daily Scope checklist and narrative through Tower typed Flight Deck PG routes. Never uses Yoke.";

async function callFlightDeck(
  wingmanUrl: string,
  sessionId: string,
  action: string,
  params: Record<string, unknown> = {},
): Promise<ToolResult> {
  try {
    const payload = await callCapabilityBroker<Record<string, unknown>>(
      "/api/mcp/wingman/flightdeck",
      { action, ...params },
      {
        wingmanUrl: Bun.env.WINGMAN_BROKER_URL?.trim() || wingmanUrl,
        sessionId,
        capabilityToken: Bun.env.WINGMAN_CAPABILITY?.trim() ?? "",
      },
    );
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Failed to reach Wingman server: ${(error as Error).message}` }],
    };
  }
}

function mapIds(params: Record<string, unknown>): Record<string, unknown> {
  return {
    ...params,
    channelId: params.channel_id,
    threadId: params.thread_id,
    taskId: params.task_id,
    documentId: params.document_id,
    commentId: params.comment_id,
  };
}

export const handleFlightdeckContext = (_params: Record<string, never>, wingmanUrl: string, sessionId: string) =>
  callFlightDeck(wingmanUrl, sessionId, "context");

export const handleFlightdeckThreadRead = (params: Record<string, unknown>, wingmanUrl: string, sessionId: string) =>
  callFlightDeck(wingmanUrl, sessionId, "thread_read", mapIds(params));

export const handleFlightdeckChatReply = (params: Record<string, unknown>, wingmanUrl: string, sessionId: string) =>
  callFlightDeck(wingmanUrl, sessionId, "chat_reply", mapIds(params));

export const handleFlightdeckTaskComment = (params: Record<string, unknown>, wingmanUrl: string, sessionId: string) =>
  callFlightDeck(wingmanUrl, sessionId, "task_comment", mapIds(params));

export const handleFlightdeckTaskComments = (params: Record<string, unknown>, wingmanUrl: string, sessionId: string) =>
  callFlightDeck(wingmanUrl, sessionId, "task_comments", mapIds(params));

export const handleFlightdeckTaskState = (params: Record<string, unknown>, wingmanUrl: string, sessionId: string) =>
  callFlightDeck(wingmanUrl, sessionId, "task_state", mapIds(params));

export const handleFlightdeckDocCreate = (params: Record<string, unknown>, wingmanUrl: string, sessionId: string) =>
  callFlightDeck(wingmanUrl, sessionId, "doc_create", mapIds(params));

export const handleFlightdeckDocGet = (params: Record<string, unknown>, wingmanUrl: string, sessionId: string) =>
  callFlightDeck(wingmanUrl, sessionId, "doc_get", mapIds(params));

export const handleFlightdeckDocUpdate = (params: Record<string, unknown>, wingmanUrl: string, sessionId: string) =>
  callFlightDeck(wingmanUrl, sessionId, "doc_update", mapIds(params));

export const handleFlightdeckDocComments = (params: Record<string, unknown>, wingmanUrl: string, sessionId: string) =>
  callFlightDeck(wingmanUrl, sessionId, "doc_comments", mapIds(params));

export const handleFlightdeckDocReply = (params: Record<string, unknown>, wingmanUrl: string, sessionId: string) =>
  callFlightDeck(wingmanUrl, sessionId, "doc_reply", mapIds(params));

export const handleFlightdeckDailyScopeGet = (params: Record<string, unknown>, wingmanUrl: string, sessionId: string) =>
  callFlightDeck(wingmanUrl, sessionId, "daily_scope_get", mapIds(params));

export const handleFlightdeckDailyScopeUpsert = (params: Record<string, unknown>, wingmanUrl: string, sessionId: string) =>
  callFlightDeck(wingmanUrl, sessionId, "daily_scope_upsert", mapIds(params));
