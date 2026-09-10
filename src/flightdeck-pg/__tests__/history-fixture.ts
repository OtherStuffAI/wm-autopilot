import type { FlightDeckPgMessage } from "../../agent-chat/tower-client.ts";

export const historyMessages: FlightDeckPgMessage[] = Array.from({ length: 205 }, (_, index) => ({
  id: `message-${index}`,
  body: index === 0 || index === 204 ? "![image](storage://image-object)" : `Message ${index}`,
  thread_id: index === 0 ? "parent-thread" : "thread-1",
  owning_thread_id: index === 0 ? "parent-thread" : "thread-1",
  inherited: index === 0,
  ...(index === 0 || index === 204 ? {
    attachments: [{ kind: "image", storage_object_id: `image-${index}`, content_type: "image/png" }],
    metadata: { attachments: [{ kind: "image", storage_object_id: `image-${index}` }] },
  } : {}),
}));

export function historyPage(url: URL) {
  const start = Number(url.searchParams.get("cursor") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 200);
  return {
    channel_id: "channel-1",
    thread_id: "thread-1",
    effective_transcript: url.searchParams.get("effective_transcript") === "true",
    cursor_semantics: { version: 1, order: "created_at ASC, id ASC" },
    messages: historyMessages.slice(start, start + limit),
    next_cursor: start + limit < historyMessages.length ? String(start + limit) : null,
  };
}
