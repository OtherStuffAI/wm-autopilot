import { createHash } from "node:crypto";
import type { DirectChatPublicationPayload, DirectChatTurnRecord } from "./direct-chat-turn-store";

export function directChatPublicationPayloadHash(payload: DirectChatPublicationPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function buildDirectChatPublicationPayload(record: DirectChatTurnRecord, body: string): DirectChatPublicationPayload {
  if (!record.threadId || !record.agentNpub) throw new Error(`Agent Direct delivery ${record.turnId} lacks immutable thread/agent binding.`);
  return { body, threadId: record.threadId, metadata: { source: 'autopilot_session', session_id: record.sessionId ?? null,
    turn_id: record.turnId, prompt_type: 'direct_chat', source_message_ids: record.sourceMessageIds, agent_npub: record.agentNpub } };
}
